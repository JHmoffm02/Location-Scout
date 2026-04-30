// api/deep_tag.js — full per-photo analysis pipeline for one album.
//
// STAGES:
//   1. Haiku tags + sharpness + composition score for every photo (medium-size, batched)
//   2. Distill album-level consensus keywords from per-photo tags
//   4. Sonnet deep tags for top 25% by composition score (medium-size, batched)
//
// Stage 3 (focus check) merges into Stage 1 — Haiku judges focus directly.
// Stage 5 (reorder) is handled by the frontend / a separate write-back endpoint.
//
// Request: POST { albumKey, images: [{key, url}], albumName, albumNotes, albumTags }
// Returns: {
//   ok, perPhoto: [{key, tags, sonnetTags, isSharp, composition, isTopPick, originalIndex}],
//   consensusTags, outlierTags,
//   sharpCount, softCount, topPickCount,
//   usage: { input, output, cache_read, cache_write, sonnet_input, sonnet_output },
//   costCents
// }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const STAGE1_BATCH_SIZE = 15;     // photos per Haiku call (image content blocks)
const STAGE4_BATCH_SIZE = 8;      // top picks per Sonnet call
const PARALLEL_BATCHES = 2;       // concurrent batches per stage
const STAGE1_MAX_RETRIES = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────
function smThumb(url)  { return url ? url.replace(/\/(Ti|S|M|L|XL|X2|X3|X4|X5|O)\//, '/Th/') : ''; }
function smMedium(url) { return url ? url.replace(/\/(Th|Ti|S|L|XL|X2|X3|X4|X5|O)\//, '/M/') : ''; }
function smLarge(url)  { return url ? url.replace(/\/(Th|Ti|S|M|XL|X2|X3|X4|X5|O)\//, '/L/') : ''; }

async function pmap(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function fetchImageAsBase64(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocationScoutApp/1.0)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const media_type = supported.includes(ct) ? ct : 'image/jpeg';
    return { type: 'base64', media_type, data: buf.toString('base64') };
  } finally { clearTimeout(timer); }
}

// Robust JSON recovery (handles trunc + trailing commas + mid-string truncation)
function parseJSON(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const first = cleaned.indexOf('{');
  if (first < 0) {
    const arrStart = cleaned.indexOf('[');
    if (arrStart < 0) throw new Error('No JSON found');
    cleaned = cleaned.slice(arrStart);
  } else {
    cleaned = cleaned.slice(first);
  }
  const lastClose = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastClose > 0) {
    try { return JSON.parse(cleaned.slice(0, lastClose + 1)); } catch (e) {}
  }
  // Fallback close-brackets
  let inStr = false, esc = false, bd = 0, kd = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') bd++;
    else if (c === '}') bd--;
    else if (c === '[') kd++;
    else if (c === ']') kd--;
  }
  let candidate = cleaned;
  if (inStr) candidate += '"';
  for (let i = 0; i < kd; i++) candidate += ']';
  for (let i = 0; i < bd; i++) candidate += '}';
  candidate = candidate.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(candidate);
}

async function callAnthropic(model, system, userContent, apiKey, maxTokens) {
  let lastErr;
  for (let attempt = 0; attempt <= STAGE1_MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 2400,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userContent }]
        }),
        signal: ctrl.signal
      });
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get('retry-after') || '');
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : 5000 * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const txt = (data.content || []).find(b => b.type === 'text');
      if (!txt) throw new Error('No text in response');
      return { text: txt.text, usage: data.usage || {} };
    } catch (e) {
      lastErr = e;
      if (attempt >= STAGE1_MAX_RETRIES) throw e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('Anthropic call failed');
}

// ── Stage 1: Haiku tags + focus + composition + ROLE ────────────────────────
function stage1SystemPrompt(albumName, albumNotes, albumTags, albumCategory) {
  // Try to detect what kind of place this is so the prompt can prioritize accordingly
  const cat = (albumCategory || '').toLowerCase();
  const isResidence = /residence|house|home|mansion|apartment|brownstone|townhouse|loft/.test(cat);
  const isCommercial = /restaurant|bar|cafe|store|shop|hotel|office|warehouse/.test(cat);
  const isOutdoor = /park|garden|street|beach|lot/.test(cat);

  let typeGuidance = '';
  if (isResidence) {
    typeGuidance = `\nThis is a RESIDENTIAL location. The most important photos are: (1) the hero exterior of the front, (2) the entry views, (3) wide establishing shots of each interior room. Most photos should be interior. Outdoor/garden shots are useful but secondary.`;
  } else if (isCommercial) {
    typeGuidance = `\nThis is a COMMERCIAL location. The most important photos are: (1) the storefront/entrance from outside, (2) the entry view from inside, (3) wide establishing shots of the main interior spaces, (4) any distinctive features (bar, dining room, kitchen). Most photos should be interior.`;
  } else if (isOutdoor) {
    typeGuidance = `\nThis is an OUTDOOR location. Wide establishing shots and varied angles of the space are most important.`;
  }

  return `You analyze film/TV scout photos. For each photo in this batch, return concrete useful metadata.

ALBUM CONTEXT:
  Album: ${albumName || '(unnamed)'}
  ${albumCategory ? `Category: ${albumCategory}` : ''}
  ${albumNotes ? `Notes excerpt: ${String(albumNotes).slice(0, 400)}` : ''}
  ${albumTags && albumTags.length ? `Existing keywords: ${albumTags.slice(0, 20).join(', ')}` : ''}${typeGuidance}

FOR EACH PHOTO, output:
  • tags: 5-8 concrete descriptive tags (architecture, materials, mood, lighting, room types, distinctive features). Multi-word tags use hyphens. No location names. No generic words like "interior"/"building".
  • is_sharp: TRUE if the main subject is in good focus, FALSE if motion-blurred, badly focused, accidentally taken, or BLANK (mostly black/white/featureless).
  • composition: integer 1-10 of overall photo quality.
      - 1-2: blurry, blank, mistake shot, or empty/featureless frame
      - 3-4: usable but not striking
      - 5-6: solid documentation shot
      - 7-8: well-composed, balanced, good lighting
      - 9-10: striking, would lead a presentation
    PANORAMA HANDLING: very wide images (panoramas) often look "smushed" but are useful establishing shots. Judge a panorama by what's in its central area — don't penalize it for the format. A well-shot interior pano of a ballroom might be a 7-8 even if it looks crammed in this preview.
  • role: ONE of:
      - "hero-exterior"  — establishing front facade
      - "side-exterior"  — supporting exterior
      - "entry-in"       — looking INTO the space from outside
      - "entry-out"      — looking OUT FROM inside toward entry/door
      - "room-overview"  — WIDE establishing shot of a distinct interior space
      - "room-detail"    — closer/featured detail (furniture, art, materials, corner)
      - "outdoor-feature" — distinct outdoor space (yard, pool, patio, garden)
      - "logistic"       — accidental/redundant/blank/low-value: partial walls, single stairs, doorbell closeups, signage, parking-lot ground, navigational shots, BLANK or near-blank frames
      - "transition"     — passages without features (plain hallway, plain stairwell, vestibule)
  • room: short consistent label (e.g. "kitchen", "primary-bedroom", "ballroom", "bath-1", "front-exterior"). Empty string if unknown.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "tags": ["..."], "is_sharp": true, "composition": 7, "role": "room-overview", "room": "kitchen" },
    { "i": 1, ... }
  ]
}`;
}

async function stage1Batch(album, batch, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smMedium(img.url), 8000); }
    catch (e) { return null; }
  }));
  const validPairs = sources.map((src, i) => src ? { src, img: batch[i] } : null).filter(Boolean);
  if (!validPairs.length) return { results: [], usage: { input_tokens: 0, output_tokens: 0 } };

  const userParts = [{ type: 'text', text: `Analyze these ${validPairs.length} photos.` }];
  validPairs.forEach((p, i) => {
    userParts.push({ type: 'text', text: `Photo ${i}:` });
    userParts.push({ type: 'image', source: p.src });
  });

  const sys = stage1SystemPrompt(album.name, album.notes, album.tags, album.category);
  const r = await callAnthropic(HAIKU, sys, userParts, apiKey, 1800);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];

  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    if (!m) {
      results.push({ key: p.img.key, tags: [], is_sharp: true, composition: 5, role: 'unknown', room: '' });
    } else {
      results.push({
        key: p.img.key,
        tags: Array.isArray(m.tags) ? m.tags : [],
        is_sharp: m.is_sharp !== false,
        composition: typeof m.composition === 'number' ? Math.max(1, Math.min(10, m.composition)) : 5,
        role: typeof m.role === 'string' ? m.role : 'unknown',
        room: typeof m.room === 'string' ? m.room.toLowerCase().trim() : ''
      });
    }
  });
  return { results, usage: r.usage };
}

// ── Stage 2: distill consensus tags from per-photo tags ─────────────────────
function distillConsensus(perPhoto) {
  const counts = new Map();
  perPhoto.forEach(p => {
    (p.tags || []).forEach(t => {
      const lower = String(t).toLowerCase();
      counts.set(lower, (counts.get(lower) || 0) + 1);
    });
  });
  // A tag is "consensus" if it appears in at least min(3, photoCount * 0.10) photos
  const photoCount = perPhoto.length;
  const minCount = Math.max(2, Math.floor(photoCount * 0.10));
  const consensus = [];
  const outliers = [];
  counts.forEach((count, tag) => {
    if (count >= minCount) consensus.push({ tag, count });
    else outliers.push({ tag, count });
  });
  consensus.sort((a, b) => b.count - a.count);
  return {
    consensus_tags: consensus.map(c => c.tag),
    outlier_tags:   outliers.map(o => o.tag)
  };
}

// ── Pick the walkthrough — at least 5 photos, target ~30% of the album ──
// Order of priorities:
//   1. 1-2 best hero-exterior  (capped — lead-in only)
//   2. 1 best entry-in
//   3. 1 best entry-out
//   4. ROOMS, ranked by RELEVANCE to the album's purpose:
//      - "core" rooms (whose photos heavily match album consensus tags) get up to 2 photos each
//      - "secondary" rooms (lightly matching) get 1 photo max
//      - room weight ranks them by core/secondary status, then by composition
//   5. Fill remaining slots with room-detail / outdoor-feature
//   6. Skip logistic + transition entirely
//
// Returns a Set of chosen image keys.
function pickWalkthrough(perPhoto, targetCount, consensusTags) {
  const sharp = perPhoto.filter(p => p.is_sharp);
  const consensusSet = new Set((consensusTags || []).map(t => String(t).toLowerCase()));

  // Group by role
  const byRole = {};
  sharp.forEach(p => {
    const r = p.role || 'unknown';
    if (!byRole[r]) byRole[r] = [];
    byRole[r].push(p);
  });
  Object.keys(byRole).forEach(r => {
    byRole[r].sort((a, b) => (b.composition - a.composition) || (a.originalIndex - b.originalIndex));
  });

  // ── Score each ROOM by relevance to the album's purpose ──
  // For each room, count how many of its photos' tags overlap with consensus.
  // Higher overlap → core room. Ties broken by total photo count (more = more documented).
  const roomStats = {};
  sharp.forEach(p => {
    const room = p.room || '';
    if (!room) return;
    if (!roomStats[room]) roomStats[room] = { photoCount: 0, consensusHits: 0, photos: [] };
    roomStats[room].photoCount++;
    roomStats[room].photos.push(p);
    (p.tags || []).forEach(t => {
      if (consensusSet.has(String(t).toLowerCase())) roomStats[room].consensusHits++;
    });
  });

  // Compute relevance score per room: avg consensus hits per photo.
  // Rooms with high avg are CORE — they ARE what this album is about.
  const roomEntries = Object.entries(roomStats).map(([room, s]) => ({
    room,
    avgRelevance: s.photoCount > 0 ? s.consensusHits / s.photoCount : 0,
    photoCount: s.photoCount,
    photos: s.photos
  }));
  // Sort: high relevance first, then high photo count
  roomEntries.sort((a, b) => (b.avgRelevance - a.avgRelevance) || (b.photoCount - a.photoCount));

  // Tier rooms: core (top half by relevance, or any with relevance >= 1.0), secondary (the rest)
  // If no consensus tags exist, treat all rooms as equal (fall back to original behavior).
  let coreRooms = new Set(), secondaryRooms = new Set();
  if (consensusSet.size && roomEntries.some(r => r.avgRelevance > 0)) {
    const cutoff = Math.max(0.5, roomEntries[0].avgRelevance * 0.5);
    roomEntries.forEach(r => {
      if (r.avgRelevance >= cutoff) coreRooms.add(r.room);
      else secondaryRooms.add(r.room);
    });
  } else {
    // No consensus to lean on — every room is "core", picker uses photo-count ordering
    roomEntries.forEach(r => coreRooms.add(r.room));
  }

  const picked = [];
  const pickedKeys = new Set();
  function pick(p) {
    if (!p || pickedKeys.has(p.key)) return false;
    pickedKeys.add(p.key);
    picked.push(p);
    return true;
  }

  // (1) Up to 2 hero-exteriors
  const heroLimit = Math.min(2, Math.max(1, Math.floor(targetCount * 0.15)));
  (byRole['hero-exterior'] || []).slice(0, heroLimit).forEach(pick);
  // (2) 1 entry-in
  if (byRole['entry-in'] && byRole['entry-in'][0]) pick(byRole['entry-in'][0]);
  // (3) 1 entry-out
  if (byRole['entry-out'] && byRole['entry-out'][0]) pick(byRole['entry-out'][0]);

  // (4) For each room, in relevance order: best room-overview from that room first,
  //     then up to 1 more from CORE rooms only (to prevent secondary-room over-representation)
  const roomOverviews = byRole['room-overview'] || [];
  const overviewsByRoom = {};
  roomOverviews.forEach(p => {
    const r = p.room || '';
    if (!overviewsByRoom[r]) overviewsByRoom[r] = [];
    overviewsByRoom[r].push(p);
  });

  // Pass 1: best overview per room, walking rooms in relevance order
  for (const re of roomEntries) {
    if (picked.length >= targetCount) break;
    const list = overviewsByRoom[re.room] || [];
    if (list.length) pick(list[0]);
  }

  // Pass 2: a SECOND overview from CORE rooms only, if any (and if we still need photos)
  for (const re of roomEntries) {
    if (picked.length >= targetCount) break;
    if (!coreRooms.has(re.room)) continue;
    const list = overviewsByRoom[re.room] || [];
    if (list.length > 1) pick(list[1]);
  }

  // (5) Fill remaining slots — prioritize details from CORE rooms, then anything else
  const detailsByRoom = {};
  (byRole['room-detail'] || []).forEach(p => {
    const r = p.room || '';
    if (!detailsByRoom[r]) detailsByRoom[r] = [];
    detailsByRoom[r].push(p);
  });

  // Pass A: 1 detail per CORE room
  for (const re of roomEntries) {
    if (picked.length >= targetCount) break;
    if (!coreRooms.has(re.room)) continue;
    const list = detailsByRoom[re.room] || [];
    if (list.length) pick(list[0]);
  }

  // Pass B: outdoor-feature shots if relevant
  if (picked.length < targetCount) {
    (byRole['outdoor-feature'] || []).slice(0, 2).forEach(pick);
  }

  // Pass C: more details from core rooms (composition-sorted)
  const moreDetails = (byRole['room-detail'] || [])
    .filter(p => coreRooms.has(p.room || ''))
    .filter(p => !pickedKeys.has(p.key));
  for (const p of moreDetails) {
    if (picked.length >= targetCount) break;
    pick(p);
  }

  // Pass D: side exteriors as last resort (capped)
  if (picked.length < targetCount) {
    (byRole['side-exterior'] || []).slice(0, 2).forEach(pick);
  }

  // Pass E: anything left from secondary rooms (last priority — won't overrepresent)
  const leftoverSecondary = sharp
    .filter(p => secondaryRooms.has(p.room) && !pickedKeys.has(p.key) && p.role !== 'logistic' && p.role !== 'transition')
    .sort((a, b) => b.composition - a.composition);
  for (const p of leftoverSecondary) {
    if (picked.length >= targetCount) break;
    pick(p);
  }

  return pickedKeys;
}
function stage4SystemPrompt(albumName, consensusTags) {
  return `You are providing enriched, high-detail keywords for the BEST photos in a film/TV scout album.

The album has been classified with these consensus keywords: ${consensusTags.slice(0, 12).join(', ')}.

For each photo in this batch, return MORE SPECIFIC and EVOCATIVE tags than usual — capture distinctive details, mood, and cinematic potential. 8-15 tags per photo. Multi-word tags use hyphens.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "tags": ["..."] },
    ...
  ]
}`;
}

async function stage4Batch(album, batch, consensusTags, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smMedium(img.url), 10000); }
    catch (e) { return null; }
  }));
  const validPairs = sources.map((src, i) => src ? { src, img: batch[i] } : null).filter(Boolean);
  if (!validPairs.length) return { results: [], usage: { input_tokens: 0, output_tokens: 0 } };

  const userParts = [{ type: 'text', text: `Provide enriched tags for these ${validPairs.length} top-pick photos.` }];
  validPairs.forEach((p, i) => {
    userParts.push({ type: 'text', text: `Photo ${i}:` });
    userParts.push({ type: 'image', source: p.src });
  });
  const sys = stage4SystemPrompt(album.name, consensusTags);
  const r = await callAnthropic(SONNET, sys, userParts, apiKey, 2000);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];

  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    results.push({
      key: p.img.key,
      tags: m && Array.isArray(m.tags) ? m.tags : []
    });
  });
  return { results, usage: r.usage };
}

// ── Pricing ──────────────────────────────────────────────────────────────────
// Returns total cost in 1/100ths of a cent.
function calcCost(haikuUsage, sonnetUsage) {
  // Haiku: $1/M input, $5/M output, cache reads $0.10/M, cache writes $1.25/M
  // 1/100ths cent units: input × 0.01, output × 0.05, cache read × 0.001, cache write × 0.0125
  const h = haikuUsage || {};
  const s = sonnetUsage || {};
  const haikuCost =
    (h.input_tokens || 0) * 0.01 +
    (h.output_tokens || 0) * 0.05 +
    (h.cache_read_input_tokens || 0) * 0.001 +
    (h.cache_creation_input_tokens || 0) * 0.0125;
  // Sonnet: $3/M input, $15/M output (3x and 3x of Haiku)
  const sonnetCost =
    (s.input_tokens || 0) * 0.03 +
    (s.output_tokens || 0) * 0.15 +
    (s.cache_read_input_tokens || 0) * 0.003 +
    (s.cache_creation_input_tokens || 0) * 0.0375;
  return Math.round(haikuCost + sonnetCost);
}

// ── Top-level handler ────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const albumKey = body.albumKey || '';
    const images = Array.isArray(body.images) ? body.images : [];
    const album = {
      key: albumKey,
      name: body.albumName || '',
      notes: body.albumNotes || '',
      tags: Array.isArray(body.albumTags) ? body.albumTags : [],
      category: body.albumCategory || ''  // e.g. "residences", "restaurants" — drives prompt bias
    };
    if (!albumKey) return res.status(400).json({ ok: false, error: 'albumKey required' });
    if (!images.length) return res.status(400).json({ ok: false, error: 'images required' });
    if (images.length > 200) return res.status(400).json({ ok: false, error: 'max 200 photos per pass' });

    // ── STAGE 1: per-photo Haiku tagging in batches ──
    const stage1Batches = [];
    for (let i = 0; i < images.length; i += STAGE1_BATCH_SIZE) {
      stage1Batches.push(images.slice(i, i + STAGE1_BATCH_SIZE));
    }
    const stage1Results = await pmap(
      stage1Batches,
      batch => stage1Batch(album, batch, apiKey),
      PARALLEL_BATCHES
    );
    // Merge per-photo results + sum usage
    const perPhoto = [];
    let haikuUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    stage1Results.forEach((batchResult, batchIdx) => {
      if (!batchResult || batchResult.__error) {
        console.error(`Stage 1 batch ${batchIdx} failed:`, batchResult && batchResult.__error);
        return;
      }
      (batchResult.results || []).forEach(r => perPhoto.push(r));
      const u = batchResult.usage || {};
      haikuUsage.input_tokens             += u.input_tokens || 0;
      haikuUsage.output_tokens            += u.output_tokens || 0;
      haikuUsage.cache_read_input_tokens  += u.cache_read_input_tokens || 0;
      haikuUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    });

    // Preserve original order using the input array
    const indexByKey = new Map();
    images.forEach((img, idx) => indexByKey.set(img.key, idx));
    perPhoto.forEach(p => { p.originalIndex = indexByKey.get(p.key); });

    // ── STAGE 2: distill consensus tags ──
    const { consensus_tags, outlier_tags } = distillConsensus(perPhoto);

    // ── STAGE 3: focus check (already merged into Stage 1) ──
    const sharpPhotos = perPhoto.filter(p => p.is_sharp);
    const softCount = perPhoto.length - sharpPhotos.length;

    // ── STAGE 4: walkthrough-style top picks (~30%, but always at least 5) ──
    // Roles + room relevance drive selection. Logistic + transition are excluded.
    const targetCount = Math.max(5, Math.ceil(perPhoto.length * 0.30));
    const topPickKeys = pickWalkthrough(perPhoto, targetCount, consensus_tags);
    perPhoto.forEach(p => { p.isTopPick = topPickKeys.has(p.key); });

    // Build batches of top picks with their URLs (from the original images list)
    const topPicks = images.filter(img => topPickKeys.has(img.key));
    const stage4Batches = [];
    for (let i = 0; i < topPicks.length; i += STAGE4_BATCH_SIZE) {
      stage4Batches.push(topPicks.slice(i, i + STAGE4_BATCH_SIZE));
    }
    const stage4Results = await pmap(
      stage4Batches,
      batch => stage4Batch(album, batch, consensus_tags, apiKey),
      PARALLEL_BATCHES
    );
    let sonnetUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const sonnetTagsByKey = new Map();
    stage4Results.forEach((batchResult, batchIdx) => {
      if (!batchResult || batchResult.__error) {
        console.error(`Stage 4 batch ${batchIdx} failed:`, batchResult && batchResult.__error);
        return;
      }
      (batchResult.results || []).forEach(r => sonnetTagsByKey.set(r.key, r.tags));
      const u = batchResult.usage || {};
      sonnetUsage.input_tokens             += u.input_tokens || 0;
      sonnetUsage.output_tokens            += u.output_tokens || 0;
      sonnetUsage.cache_read_input_tokens  += u.cache_read_input_tokens || 0;
      sonnetUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    });
    perPhoto.forEach(p => {
      if (sonnetTagsByKey.has(p.key)) p.sonnetTags = sonnetTagsByKey.get(p.key) || [];
      else p.sonnetTags = [];
    });

    // Compute ranked_index: top picks in TOUR ORDER, then sharp non-picks chronologically, then soft.
    // Tour order = hero → entry-in → entry-out → room-overviews (chrono) → room-details (chrono) → other (chrono).
    const ROLE_ORDER = {
      'hero-exterior':   1,
      'entry-in':        2,
      'entry-out':       3,
      'room-overview':   4,
      'room-detail':     5,
      'outdoor-feature': 6,
      'side-exterior':   7,
      'unknown':         8,
      'transition':      9,
      'logistic':       10
    };
    const tourSorted = perPhoto.slice().sort((a, b) => {
      // Top picks first (and within them, by tour-role then chrono)
      const aPick = a.isTopPick ? 0 : 1;
      const bPick = b.isTopPick ? 0 : 1;
      if (aPick !== bPick) return aPick - bPick;
      if (aPick === 0) {
        // Both top picks — order by role priority, then chronologically within role
        const ra = ROLE_ORDER[a.role] || 99;
        const rb = ROLE_ORDER[b.role] || 99;
        if (ra !== rb) return ra - rb;
        return (a.originalIndex || 0) - (b.originalIndex || 0);
      }
      // Both NOT top picks — sharp first (chrono), then soft (chrono)
      const aSharp = a.is_sharp ? 0 : 1;
      const bSharp = b.is_sharp ? 0 : 1;
      if (aSharp !== bSharp) return aSharp - bSharp;
      return (a.originalIndex || 0) - (b.originalIndex || 0);
    });
    tourSorted.forEach((p, idx) => { p.rankedIndex = idx; });

    const costCents = calcCost(haikuUsage, sonnetUsage);

    return res.json({
      ok: true,
      perPhoto,
      consensusTags: consensus_tags,
      outlierTags: outlier_tags,
      photoCount: perPhoto.length,
      sharpCount: sharpPhotos.length,
      softCount,
      topPickCount: topPickKeys.size,
      usage: {
        haiku:  haikuUsage,
        sonnet: sonnetUsage
      },
      costCents
    });
  } catch (e) {
    console.error('deep_tag error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'deep tag failed' });
  }
};
