// api/deep_tag.js — multi-stage album analysis pipeline.
//
// PIPELINE (driven by ?stage= query param so the frontend runs in steps):
//
//   stage=triage    Haiku on all THUMBNAILS. Marks blanks/super-blurry/contextless
//                   shots as rejected. Returns survivor list.
//
//   stage=classify  Haiku on LARGE images, only the survivors. Strict on focus and
//                   logistic detection. Returns role/room/tags/composition. Optionally
//                   takes a contextImageUrl (the user-picked cover) which is included
//                   as a priming image in every batch.
//
//   stage=organize  Sonnet TEXT-ONLY (with the cover image only) given album notes,
//                   Google Places data, and per-photo SUMMARIES from classify.
//                   Returns the walkthrough order + top-pick set.
//
//   stage=enrich    Sonnet on LARGE images of the top picks. Adds richer tags.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const TRIAGE_BATCH_SIZE   = 25;
const CLASSIFY_BATCH_SIZE = 8;
const ENRICH_BATCH_SIZE   = 6;
const PARALLEL_BATCHES    = 2;
const MAX_RETRIES         = 3;

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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      if (attempt >= MAX_RETRIES) throw e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('Anthropic call failed');
}

function calcCost(haikuUsage, sonnetUsage) {
  const h = haikuUsage || {};
  const s = sonnetUsage || {};
  const haikuCost =
    (h.input_tokens || 0) * 0.01 +
    (h.output_tokens || 0) * 0.05 +
    (h.cache_read_input_tokens || 0) * 0.001 +
    (h.cache_creation_input_tokens || 0) * 0.0125;
  const sonnetCost =
    (s.input_tokens || 0) * 0.03 +
    (s.output_tokens || 0) * 0.15 +
    (s.cache_read_input_tokens || 0) * 0.003 +
    (s.cache_creation_input_tokens || 0) * 0.0375;
  return Math.round(haikuCost + sonnetCost);
}

function sumUsage(usages) {
  const out = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  usages.forEach(u => {
    if (!u) return;
    out.input_tokens             += u.input_tokens || 0;
    out.output_tokens            += u.output_tokens || 0;
    out.cache_read_input_tokens  += u.cache_read_input_tokens || 0;
    out.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  });
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE: TRIAGE — Haiku on thumbnails, mark blanks/blurry/contextless
// ════════════════════════════════════════════════════════════════════════════
const TRIAGE_PROMPT = `You're triaging photos for a film/TV scout. Be STRICT — when in doubt, REJECT. The goal is to surface only photos that meaningfully sell the location. Reference shots, accidents, and feature-only details get rejected.

REJECT (mark reject:true) if ANY of these apply:
  • Blank, near-blank, mostly black, or mostly white — no clear subject
  • Out of focus, motion-blurred, or visibly soft on the intended subject
  • An empty wall, blank corner, or featureless surface
  • Stairs, stairwells, or steps photographed in isolation (no surrounding room context)
  • A door photographed alone (just the door — no room visible)
  • A hallway or transition with no distinctive character
  • A closet interior, utility space, or storage area in isolation
  • Bathroom fixtures alone (just a toilet, just a sink, just a tub) without showing the room
  • Material/hardware close-ups — wallpaper swatches, ceiling tiles, hinges, light switches, doorbells, electrical panels
  • Signage, address plates, permits, parking-lot ground, ceiling or floor textures
  • Accidental camera shots (sky, ground, lens-cover blur, finger over lens)
  • Tight architectural details (a single molding, a single beam) without the surrounding room
  • Anything that answers "what does this specific feature look like?" rather than "what is this place LIKE?"

KEEP (mark reject:false) if ALL of these apply:
  • The subject is in clear focus
  • The frame shows a recognizable space, room, exterior, or distinctive composition
  • The shot communicates "what this place is like" to a director who's never been there
  • Even imperfect framing is OK if the photo describes a real space

The threshold: if a photo wouldn't appear in a 30-photo scout deck of this location, reject it.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "reject": true, "reason": "isolated stairs, no room context" },
    { "i": 1, "reject": false }
  ]
}`;

async function triageBatch(batch, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smThumb(img.url), 6000); }
    catch (e) { return null; }
  }));
  const validPairs = sources.map((src, i) => src ? { src, img: batch[i] } : null).filter(Boolean);
  if (!validPairs.length) return { results: [], usage: {} };

  const userParts = [{ type: 'text', text: `Triage these ${validPairs.length} thumbnails.` }];
  validPairs.forEach((p, i) => {
    userParts.push({ type: 'text', text: `Photo ${i}:` });
    userParts.push({ type: 'image', source: p.src });
  });
  const r = await callAnthropic(HAIKU, TRIAGE_PROMPT, userParts, apiKey, 1200);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];

  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    results.push({
      key: p.img.key,
      reject: m ? !!m.reject : false,
      reason: m ? (m.reason || '') : ''
    });
  });
  return { results, usage: r.usage };
}

async function runTriage(images, apiKey) {
  const batches = [];
  for (let i = 0; i < images.length; i += TRIAGE_BATCH_SIZE) {
    batches.push(images.slice(i, i + TRIAGE_BATCH_SIZE));
  }
  const batchResults = await pmap(batches, b => triageBatch(b, apiKey), PARALLEL_BATCHES);
  const allResults = [];
  const usages = [];
  batchResults.forEach(br => {
    if (!br || br.__error) return;
    (br.results || []).forEach(r => allResults.push(r));
    usages.push(br.usage);
  });
  return { results: allResults, usage: sumUsage(usages) };
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE: CLASSIFY — Haiku on LARGE survivors, strict on focus + logistic
// ════════════════════════════════════════════════════════════════════════════
function classifySystemPrompt(albumName, albumNotes, albumTags, albumCategory, googlePlaces) {
  const cat = (albumCategory || '').toLowerCase();
  const isResidence = /residence|house|home|mansion|apartment|brownstone|townhouse|loft/.test(cat);
  const isCommercial = /restaurant|bar|cafe|store|shop|hotel|office|warehouse|event|venue|ballroom|reception/.test(cat);
  const isOutdoor = /park|garden|street|beach|lot/.test(cat);

  let typeGuidance = '';
  if (isResidence) typeGuidance = `\nRESIDENTIAL: prioritize interior establishing shots; exteriors are secondary.`;
  else if (isCommercial) typeGuidance = `\nCOMMERCIAL: prioritize storefront → main interior establishing shots → distinctive features.`;
  else if (isOutdoor) typeGuidance = `\nOUTDOOR: wide establishing shots and varied angles are most important.`;

  let placesContext = '';
  if (googlePlaces && (googlePlaces.formatted || googlePlaces.types)) {
    placesContext = `\nGOOGLE PLACES DATA:`;
    if (googlePlaces.formatted) placesContext += `\n  Address: ${googlePlaces.formatted}`;
    if (googlePlaces.types && googlePlaces.types.length) placesContext += `\n  Types: ${googlePlaces.types.slice(0, 5).join(', ')}`;
  }

  return `You analyze film/TV scout photos. The first image in the batch is the COVER REFERENCE — that's what this location actually IS. Use it as context for judging the rest. Return metadata for each NUMBERED photo (skip the cover reference in your output).

ALBUM CONTEXT:
  Album: ${albumName || '(unnamed)'}
  ${albumCategory ? `Category: ${albumCategory}` : ''}
  ${albumNotes ? `Notes: ${String(albumNotes).slice(0, 1500)}` : ''}
  ${albumTags && albumTags.length ? `Existing keywords: ${albumTags.slice(0, 20).join(', ')}` : ''}${typeGuidance}${placesContext}

FOR EACH NUMBERED PHOTO, output:
  • tags: 5-8 concrete descriptive tags (architecture, materials, mood, lighting, room types, distinctive features). Multi-word tags use hyphens. No location names. No generic words like "interior"/"building".
  • is_sharp: TRUE only if the main subject is in CLEAR focus. BE STRICT — if there's any motion blur, soft focus on the intended subject, or general unsharpness, return FALSE. When in doubt, FALSE.
  • composition: integer 1-10 (10 = striking, 1 = blurry/blank/mistake).
  • role: ONE of:
      - "hero-exterior"  — establishing front facade of the location
      - "side-exterior"  — supporting exterior context
      - "entry-in"       — looking INTO the space from outside
      - "entry-out"      — looking OUT from inside toward entry
      - "room-overview"  — WIDE establishing of a distinct interior space, showing how the space lives
      - "room-detail"    — closer feature of furniture/art/materials that adds character to the space
      - "outdoor-feature" — yard, pool, patio, garden — distinct outdoor space
      - "logistic"       — REFERENCE shots, NOT story shots. Practical-but-not-presentable. The KEY question: does this photo answer "what is this place LIKE?" (story) or "what does this specific feature look like?" (reference). Reference goes here:
                            • a blank door (just the door, no surrounding room context)
                            • stairs in isolation (a stairwell shot, single steps, partial railing)
                            • a closet interior (random closet, utility closet, no surrounding context)
                            • bathroom fixtures in isolation (just a sink, just a toilet, hardware closeup)
                            • material/detail close-ups (a swatch of wallpaper, ceiling tile, a hinge)
                            • blank corners, alcoves, empty walls
                            • doorbells, light switches, electrical panels
                            • signage closeups, reference shots of permits/numbers
                          Even if the photo is well-framed and well-focused, mark logistic if it's a REFERENCE shot rather than something that sells the space. BE GENEROUS marking logistic — wide shots are story; tight crops of single features are usually reference.
      - "transition"     — passages with no distinctive character (plain hallway, plain stairwell, vestibule)
  • room: short label (e.g. "kitchen", "ballroom", "bath-1"). Empty string if unknown.

PANORAMA HANDLING: judge a panorama by what's in its central region. Don't penalize for the format.

BE STRICT on logistic and is_sharp. We're trying to surface the TRUE WALKTHROUGH that sells the space — eliminate everything that's just reference.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "tags": ["..."], "is_sharp": true, "composition": 7, "role": "room-overview", "room": "kitchen" },
    ...
  ]
}`;
}

async function classifyBatch(album, batch, contextImages, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smLarge(img.url), 10000); }
    catch (e) { return null; }
  }));
  const validPairs = sources.map((src, i) => src ? { src, img: batch[i] } : null).filter(Boolean);
  if (!validPairs.length) return { results: [], usage: {} };

  const userParts = [];
  if (contextImages && contextImages.length) {
    userParts.push({
      type: 'text',
      text: `CENTERPIECE REFERENCE${contextImages.length > 1 ? 'S' : ''} (${contextImages.length} image${contextImages.length > 1 ? 's' : ''} representing what this location IS — use for context, do NOT classify):`
    });
    contextImages.forEach((img, i) => {
      if (contextImages.length > 1) userParts.push({ type: 'text', text: `Centerpiece ${i + 1}:` });
      userParts.push({ type: 'image', source: img });
    });
    userParts.push({ type: 'text', text: `Now classify these ${validPairs.length} numbered photos:` });
  } else {
    userParts.push({ type: 'text', text: `Classify these ${validPairs.length} photos.` });
  }
  validPairs.forEach((p, i) => {
    userParts.push({ type: 'text', text: `Photo ${i}:` });
    userParts.push({ type: 'image', source: p.src });
  });

  const sys = classifySystemPrompt(album.name, album.notes, album.tags, album.category, album.googlePlaces);
  const r = await callAnthropic(HAIKU, sys, userParts, apiKey, 2000);
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

async function runClassify(album, images, contextImageUrls, apiKey) {
  const urls = Array.isArray(contextImageUrls) ? contextImageUrls.filter(Boolean).slice(0, 5) : [];
  const contextImages = [];
  for (const url of urls) {
    try { contextImages.push(await fetchImageAsBase64(smMedium(url), 8000)); }
    catch (e) {}
  }
  const batches = [];
  for (let i = 0; i < images.length; i += CLASSIFY_BATCH_SIZE) {
    batches.push(images.slice(i, i + CLASSIFY_BATCH_SIZE));
  }
  const batchResults = await pmap(batches, b => classifyBatch(album, b, contextImages, apiKey), PARALLEL_BATCHES);
  const allResults = [];
  const usages = [];
  batchResults.forEach(br => {
    if (!br || br.__error) return;
    (br.results || []).forEach(r => allResults.push(r));
    usages.push(br.usage);
  });
  return { results: allResults, usage: sumUsage(usages) };
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE: ORGANIZE — Sonnet TEXT-ONLY (with cover image) returns walkthrough order
// ════════════════════════════════════════════════════════════════════════════
const ORGANIZE_PROMPT = `You're a film/TV scout's assistant. Given album metadata + a cover reference image + per-photo summaries, return the ideal walkthrough ORDER for presenting the location.

WALKTHROUGH PRINCIPLES:
  1. Lead with 1-2 hero exterior shots (establishing where we are)
  2. Show the entry — outside-looking-in, then a wide of inside-looking-out
  3. Move through the SIGNIFICANT spaces — the rooms that ARE the location's purpose
  4. Within each space: best wide overview first, then the reverse
  5. Outdoor features after interiors (unless it's an outdoor location)
  6. additional exteriors / reference shots / logistic photos go to the back
  7. Anything marked is_sharp:false or role:logistic goes to the END

SPACE PRIORITIZATION (this is the key judgment):
  - The cover image and album notes/category tell you what the location IS
  - Rooms whose tags align with the album's purpose are CORE — feature them
  - Original order is the starting point for the flow of the file
  - Rooms that exist but aren't the main draw are SECONDARY — give them a token mention
  - For a ballroom venue: ballroom + grand entrance are core; bathrooms are secondary
  - For a residence: living/family rooms + kitchen are core; bathrooms usually secondary

TOP PICKS:
  - These are the photos that, in this order, would be the highlight reel
  - Skip logistic/blurry/blank from top picks entirely

RESPECT CHRONOLOGY when ranking is otherwise tied — prefer the lower original_index.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "ordered": [
    { "key": "abc123", "top_pick": true,  "rank_reason": "hero exterior" },
    { "key": "def456", "top_pick": true,  "rank_reason": "ballroom overview, core space" },
    ...
  ]
}

Include EVERY photo in "ordered". The order of items IS the new walkthrough order.`;

async function runOrganize(album, perPhoto, contextImageUrls, apiKey) {
  const urls = Array.isArray(contextImageUrls) ? contextImageUrls.filter(Boolean).slice(0, 5) : [];
  const contextImages = [];
  for (const url of urls) {
    try { contextImages.push(await fetchImageAsBase64(smMedium(url), 8000)); }
    catch (e) {}
  }

  const lines = perPhoto.map(p => {
    const parts = [`key=${p.key}`];
    parts.push(`idx=${p.originalIndex}`);
    if (p.role) parts.push(`role=${p.role}`);
    if (p.room) parts.push(`room=${p.room}`);
    parts.push(`comp=${p.composition || 5}`);
    parts.push(`sharp=${p.is_sharp !== false}`);
    if (p.tags && p.tags.length) parts.push(`tags=[${p.tags.slice(0, 8).join(',')}]`);
    if (p.isRejected) parts.push('REJECTED');
    return parts.join(' · ');
  }).join('\n');

  const placesText = album.googlePlaces
    ? `\n\nGOOGLE PLACES:\n  ${album.googlePlaces.formatted || ''}\n  Types: ${(album.googlePlaces.types || []).join(', ')}`
    : '';

  const userParts = [];
  if (contextImages.length) {
    userParts.push({
      type: 'text',
      text: `CENTERPIECE IMAGE${contextImages.length > 1 ? 'S' : ''} (${contextImages.length} user-selected reference${contextImages.length > 1 ? 's' : ''} for what this location IS):`
    });
    contextImages.forEach((img, i) => {
      if (contextImages.length > 1) userParts.push({ type: 'text', text: `Centerpiece ${i + 1}:` });
      userParts.push({ type: 'image', source: img });
    });
  }
  userParts.push({
    type: 'text',
    text: `ALBUM: ${album.name || '(unnamed)'}\n` +
          `Category: ${album.category || 'unknown'}\n` +
          `Notes: ${String(album.notes || '').slice(0, 1500)}` +
          placesText +
          `\n\nPER-PHOTO SUMMARIES (${perPhoto.length} photos):\n${lines}\n\nReturn the walkthrough ordering.`
  });

  const r = await callAnthropic(SONNET, ORGANIZE_PROMPT, userParts, apiKey, 4000);
  const parsed = parseJSON(r.text);
  const ordered = Array.isArray(parsed.ordered) ? parsed.ordered : [];
  return { ordered, usage: r.usage };
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE: ENRICH — Sonnet large images on top picks
// ════════════════════════════════════════════════════════════════════════════
const ENRICH_PROMPT_TMPL = consensus =>
  `You provide enriched, evocative keywords for the BEST photos in a film/TV scout album.

Album consensus: ${consensus.slice(0, 12).join(', ')}.

For each photo: 8-15 specific tags. Capture distinctive details, mood, cinematic potential. Multi-word tags use hyphens.

OUTPUT — return ONLY this JSON, no prose:
{
  "photos": [
    { "i": 0, "tags": ["..."] },
    ...
  ]
}`;

async function enrichBatch(batch, consensus, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smLarge(img.url), 10000); }
    catch (e) { return null; }
  }));
  const validPairs = sources.map((src, i) => src ? { src, img: batch[i] } : null).filter(Boolean);
  if (!validPairs.length) return { results: [], usage: {} };

  const userParts = [{ type: 'text', text: `Provide enriched tags for these ${validPairs.length} top-pick photos.` }];
  validPairs.forEach((p, i) => {
    userParts.push({ type: 'text', text: `Photo ${i}:` });
    userParts.push({ type: 'image', source: p.src });
  });
  const r = await callAnthropic(SONNET, ENRICH_PROMPT_TMPL(consensus || []), userParts, apiKey, 2000);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];
  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    results.push({ key: p.img.key, tags: m && Array.isArray(m.tags) ? m.tags : [] });
  });
  return { results, usage: r.usage };
}

async function runEnrich(images, consensus, apiKey) {
  const batches = [];
  for (let i = 0; i < images.length; i += ENRICH_BATCH_SIZE) {
    batches.push(images.slice(i, i + ENRICH_BATCH_SIZE));
  }
  const batchResults = await pmap(batches, b => enrichBatch(b, consensus, apiKey), PARALLEL_BATCHES);
  const allResults = [];
  const usages = [];
  batchResults.forEach(br => {
    if (!br || br.__error) return;
    (br.results || []).forEach(r => allResults.push(r));
    usages.push(br.usage);
  });
  return { results: allResults, usage: sumUsage(usages) };
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
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
    const stage = (req.query && req.query.stage) || body.stage || 'classify';

    if (stage === 'triage') {
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) return res.status(400).json({ ok: false, error: 'images required' });
      if (images.length > 250) return res.status(400).json({ ok: false, error: 'max 250 photos per triage' });
      const { results, usage } = await runTriage(images, apiKey);
      return res.json({ ok: true, results, usage, costCents: calcCost(usage, null) });
    }

    if (stage === 'classify') {
      const album = {
        name: body.albumName || '',
        notes: body.albumNotes || '',
        tags: Array.isArray(body.albumTags) ? body.albumTags : [],
        category: body.albumCategory || '',
        googlePlaces: body.googlePlaces || null
      };
      const images = Array.isArray(body.images) ? body.images : [];
      // Accept either contextImageUrls (new, array) or contextImageUrl (legacy, single)
      const contextImageUrls = Array.isArray(body.contextImageUrls)
        ? body.contextImageUrls
        : (body.contextImageUrl ? [body.contextImageUrl] : []);
      if (!images.length) return res.status(400).json({ ok: false, error: 'images required' });
      if (images.length > 200) return res.status(400).json({ ok: false, error: 'max 200 photos per classify' });
      const { results, usage } = await runClassify(album, images, contextImageUrls, apiKey);
      return res.json({ ok: true, results, usage, costCents: calcCost(usage, null) });
    }

    if (stage === 'organize') {
      const album = {
        name: body.albumName || '',
        notes: body.albumNotes || '',
        category: body.albumCategory || '',
        googlePlaces: body.googlePlaces || null
      };
      const perPhoto = Array.isArray(body.perPhoto) ? body.perPhoto : [];
      const contextImageUrls = Array.isArray(body.contextImageUrls)
        ? body.contextImageUrls
        : (body.contextImageUrl ? [body.contextImageUrl] : []);
      if (!perPhoto.length) return res.status(400).json({ ok: false, error: 'perPhoto required' });
      if (perPhoto.length > 250) return res.status(400).json({ ok: false, error: 'max 250 photos per organize' });
      const { ordered, usage } = await runOrganize(album, perPhoto, contextImageUrls, apiKey);
      return res.json({ ok: true, ordered, usage, costCents: calcCost(null, usage) });
    }

    if (stage === 'enrich') {
      const images = Array.isArray(body.images) ? body.images : [];
      const consensus = Array.isArray(body.consensusTags) ? body.consensusTags : [];
      if (!images.length) return res.status(400).json({ ok: false, error: 'images required' });
      if (images.length > 60) return res.status(400).json({ ok: false, error: 'max 60 photos per enrich' });
      const { results, usage } = await runEnrich(images, consensus, apiKey);
      return res.json({ ok: true, results, usage, costCents: calcCost(null, usage) });
    }

    return res.status(400).json({ ok: false, error: `unknown stage: ${stage}` });
  } catch (e) {
    console.error('deep_tag error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'deep tag failed' });
  }
};
