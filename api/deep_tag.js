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

// ── Stage 1: Haiku tags + focus + composition ────────────────────────────────
function stage1SystemPrompt(albumName, albumNotes, albumTags) {
  return `You analyze film/TV scout photos. For each photo in this batch, return:
  • 5-8 concrete descriptive tags (architecture, materials, mood, lighting, subjects, room types)
  • is_sharp: TRUE if the main subject is in good focus, FALSE if motion-blurred, out of focus, or a logistic mistake shot
  • composition: integer 1-10 of overall photo quality / aesthetic appeal (10 = striking, well-composed; 1 = blurry or accidental)

ALBUM CONTEXT (use to bias your tagging — bias tags toward what's notable for this album):
  Album: ${albumName || '(unnamed)'}
  ${albumNotes ? `Notes excerpt: ${String(albumNotes).slice(0, 400)}` : ''}
  ${albumTags && albumTags.length ? `Existing keywords: ${albumTags.slice(0, 20).join(', ')}` : ''}

TAG GUIDELINES — multi-word tags use hyphens. Pick whichever genuinely apply. Don't include the location name. Don't include generic words like "interior" / "building".

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "tags": ["..."], "is_sharp": true, "composition": 7 },
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

  const sys = stage1SystemPrompt(album.name, album.notes, album.tags);
  const r = await callAnthropic(HAIKU, sys, userParts, apiKey, 1500);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];

  // Map back to image keys via local index
  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    if (!m) {
      // No record for this photo — assume sharp, default composition
      results.push({ key: p.img.key, tags: [], is_sharp: true, composition: 5 });
    } else {
      results.push({
        key: p.img.key,
        tags: Array.isArray(m.tags) ? m.tags : [],
        is_sharp: m.is_sharp !== false,  // default to sharp on missing field
        composition: typeof m.composition === 'number' ? Math.max(1, Math.min(10, m.composition)) : 5
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

// ── Stage 4: Sonnet enriched tags for top picks ─────────────────────────────
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
      tags: Array.isArray(body.albumTags) ? body.albumTags : []
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

    // ── STAGE 3: focus check (already merged into Stage 1 — just count) ──
    const sharpPhotos = perPhoto.filter(p => p.is_sharp);
    const softCount = perPhoto.length - sharpPhotos.length;

    // ── STAGE 4: top 25% by composition score, run Sonnet ──
    sharpPhotos.sort((a, b) => (b.composition || 0) - (a.composition || 0));
    const topCount = Math.max(1, Math.ceil(sharpPhotos.length * 0.25));
    const topPickKeys = new Set(sharpPhotos.slice(0, topCount).map(p => p.key));
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

    // Compute ranked_index: chronological order within top picks first, then everything else
    perPhoto.sort((a, b) => (a.originalIndex || 0) - (b.originalIndex || 0));
    let rankedPos = 0;
    // Pass 1: top picks in chrono order
    perPhoto.forEach(p => {
      if (p.isTopPick) p.rankedIndex = rankedPos++;
    });
    // Pass 2: sharp non-top in chrono order
    perPhoto.forEach(p => {
      if (!p.isTopPick && p.is_sharp) p.rankedIndex = rankedPos++;
    });
    // Pass 3: soft photos at the end, chrono order
    perPhoto.forEach(p => {
      if (!p.is_sharp) p.rankedIndex = rankedPos++;
    });

    const costCents = calcCost(haikuUsage, sonnetUsage);

    return res.json({
      ok: true,
      perPhoto,
      consensusTags: consensus_tags,
      outlierTags: outlier_tags,
      photoCount: perPhoto.length,
      sharpCount: sharpPhotos.length,
      softCount,
      topPickCount: topCount,
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
