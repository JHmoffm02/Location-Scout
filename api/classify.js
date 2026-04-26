// api/classify.js — two-pass image-aware classifier
//
// PASS 1 (Haiku, thumbnails): curate the best 8 representative images from the album.
//   Skips blurry/dark/redundant/logistic shots. Prefers diversity (exterior, multiple rooms).
// PASS 2 (Sonnet, 8 large images): rich classification + extensive descriptive tagging.
//
// Albums with ≤8 photos skip Pass 1 — Sonnet sees all of them directly.
// Per-album cost target: ~$0.04 with curated 8.
//
// Request: POST { albums: [{key, name, notes, address, image_urls}], taxonomy: [...paths] }
// Response: { results: [{key, path, confidence, reasoning, model, tags, ...}] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-6';
const TARGET_COUNT = 15;         // images selected for the deep classification
const MAX_THUMBS_PER_PASS1 = 100; // hard cap on Pass 1 input size
const PARALLEL = 2;              // concurrent classifications (was 3 — Sonnet rate-limit at Tier 1 is 30K tok/min)
const MAX_429_RETRIES = 4;

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

// SmugMug image size transforms
function smThumb(url)  { return url ? url.replace(/\/(Ti|S|M|L|XL)\//, '/Th/') : ''; }
function smLarge(url)  { return url ? url.replace(/\/(Th|Ti|S|M)\//, '/L/') : ''; }

// ── Image fetching: SmugMug blocks Anthropic via robots.txt, so we proxy ──
async function fetchImageAsBase64(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Be a polite client. SmugMug serves images to browsers; pretending to be one is fine.
        'User-Agent': 'Mozilla/5.0 (compatible; LocationScoutApp/1.0)'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    // Anthropic supports image/jpeg, image/png, image/gif, image/webp
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const media_type = supported.includes(ct) ? ct : 'image/jpeg';
    return { type: 'base64', media_type, data: buf.toString('base64') };
  } finally { clearTimeout(timer); }
}

async function fetchImagesAsBase64(urls, timeoutMs) {
  // Parallel fetch with per-image error containment
  return Promise.all(urls.map(async url => {
    if (!url) return null;
    try {
      return await fetchImageAsBase64(url, timeoutMs);
    } catch (e) {
      console.error('Image fetch failed:', url, e.message);
      return null;
    }
  }));
}

// ── Bounded concurrency ────────────────────────────────────────────────────
async function pmap(items, fn, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Sample evenly across an array (for albums with > MAX_THUMBS_PER_PASS1 photos)
function sampleEvenly(total, count) {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const step = total / count;
  const indices = [];
  for (let i = 0; i < count; i++) indices.push(Math.floor(i * step));
  return indices;
}

// ── Prompts ────────────────────────────────────────────────────────────────
function buildSelectionSystemPrompt(targetCount) {
  return `You curate photos for a film/TV location scout. The scout's album has multiple photos. Your job: pick the ${targetCount} most useful images for understanding what this location is and what's distinctive about it.

SELECTION CRITERIA:
- DIVERSITY > redundancy. Avoid 5 photos of the same room. Pick ONE that best represents each distinct space.
- COVER DIFFERENT SPACES: if the album has exterior, multiple interior rooms, distinctive details — include one of each.
- SPREAD ACROSS THE ALBUM. Photos are ordered as the scout shot them. Often the first cluster is one room (e.g. exterior shots), the next cluster another room, etc. Your ${targetCount} picks should be drawn from across the FULL range of indices — don't bunch them up. If the album has 80 photos, your selections should NOT all be from images 0-15; they should span the album. Different sections of the album typically capture different spaces.
- PREFER ESTABLISHING SHOTS over close-ups. Wide angles showing architecture and layout > tight crops.
- AVOID: blurry images, dark/underexposed shots, accidental shots, logistic photos (closeup of a doorbell, parking lot ground, plain hallway walls, isolated stairs without context, signage-only shots).
- INCLUDE: photos showing distinctive features (period details, materials, mood, lighting), exterior if available, the main usable rooms/spaces.
- ORDER MATTERS in your output: list selections in importance order — the most representative photo first.

Return ONLY this JSON, no prose, no markdown fences:
{
  "selected": [0, 5, 12, ...],
  "reasoning": "brief note on what types of images you picked AND what spread of the album they came from"
}`;
}

function buildClassifySystemPrompt(taxonomy, corrections) {
  const taxList = (taxonomy && taxonomy.length)
    ? taxonomy.map(p => '  - ' + p).join('\n')
    : '  (no existing categories — propose appropriate ones)';

  let correctionsBlock = '';
  if (corrections && corrections.length) {
    correctionsBlock = '\n\nPAST USER CORRECTIONS (the scout has previously fixed these — apply the same patterns):\n' +
      corrections.slice(0, 12).map(c => {
        const parts = [];
        if (c.applied_path && c.ai_path && c.applied_path !== c.ai_path) {
          parts.push(`"${c.album_name}" — AI suggested "${c.ai_path}", user moved to "${c.applied_path}".${c.note ? ' Note: ' + c.note : ''}`);
        } else if (c.applied_path) {
          parts.push(`"${c.album_name}" → "${c.applied_path}".`);
        }
        if (c.rejected_tags && c.rejected_tags.length) {
          parts.push(`  ↳ Rejected tags: ${c.rejected_tags.join(', ')} (don't suggest these for similar places).`);
        }
        if (c.added_tags && c.added_tags.length) {
          parts.push(`  ↳ User added tags: ${c.added_tags.join(', ')}.`);
        }
        return parts.join('\n');
      }).filter(Boolean).join('\n') + '\n';
  }

  return `You classify locations for a film/TV scout's photo library AND extract rich, searchable visual descriptors that help the scout find this place later.

EXISTING TAXONOMY (prefer these paths when they fit):
${taxList}
${correctionsBlock}
PATH GUIDELINES:
- The album NAME is critical — it often contains both the location identity AND its area (e.g. "100 East 1st St - Mt Vernon", "Joe's Pizza - Astoria")
- Use existing paths when an album fits one well, even loosely
- If an album doesn't fit existing paths cleanly, PROPOSE A NEW PATH — don't force-fit. New paths should be lowercase, hyphenated, hierarchical
- Many existing paths use a category/area structure (e.g. "bars/long-island"). When the album's area doesn't match an existing area-path, propose a NEW area-path rather than misclassifying the area.

NY METRO AREA REFERENCE (for the area portion of paths):
- manhattan — anywhere in Manhattan/NYC proper
- brooklyn — any Brooklyn neighborhood (Williamsburg, Park Slope, Bushwick, Crown Heights, etc.)
- queens — any Queens neighborhood (Astoria, Long Island City/LIC, Flushing, Jackson Heights, Forest Hills)
- bronx — anywhere in the Bronx
- staten-island — Staten Island
- long-island — Nassau & Suffolk counties ONLY (Hempstead, Garden City, Great Neck, Port Washington, Bayside, Levittown, Huntington, the Hamptons)
- westchester — Westchester County: Yonkers, MOUNT VERNON / MT VERNON, New Rochelle, White Plains, Pleasantville, Tarrytown, Mt Kisco, Larchmont, Scarsdale
- rockland — Rockland County: Nyack, New City, Spring Valley
- hudson-valley — Putnam, Dutchess, Orange counties (north of Westchester/Rockland)
- jersey — northern NJ urban (Jersey City, Hoboken, Newark, etc.)
- connecticut — CT areas (Greenwich, Stamford, Norwalk)
- upstate — anything else north of NYC metro
- LOCATION TYPE prefixes: residences, restaurants, bars, hotels, hospitals, schools, offices, industrial, religious, public, retail, etc.

If the album name says "Mt Vernon", that is WESTCHESTER, not Long Island. If "Astoria" or "LIC", that is QUEENS, not Long Island. The "Long Island" geographic label only applies to places east of NYC city limits in Nassau or Suffolk County.

CONFIDENCE RUBRIC:
- 0.95+ = images clearly show the type
- 0.85 = name + 1 image confirm
- 0.70 = strong textual evidence only
- <0.70 = ambiguous

TAG GUIDELINES — extract 8-18 album-level descriptive tags FROM THE IMAGES that summarize the location overall. These should help a scout search for this whole place. Cover as many of these dimensions as apply:

  ARCHITECTURE / STYLE: victorian, art-deco, mid-century-modern, brutalist, neoclassical, industrial, tudor, colonial, gothic, beaux-arts, federal, craftsman, ranch, contemporary, postmodern
  PERIOD / ERA FEEL: pre-war, 1920s, 1950s, 70s-era, modern, period-accurate, anachronistic, timeless, historical
  MATERIALS / FINISHES: wood-paneling, exposed-brick, marble-floors, stained-glass, hardwood, concrete, tile, stone, metal, plaster, wallpaper, terrazzo, linoleum, drywall
  LIGHT / WINDOWS: lots-of-windows, natural-light, skylights, floor-to-ceiling-windows, dim-lighting, fluorescent, harsh-overhead, warm-lighting, sconces, chandeliers, no-windows, basement-light
  MOOD / TONE: creepy, fancy, elegant, homey, sterile, warm, cold, ornate, minimal, cluttered, abandoned-feel, lived-in, polished, raw, intimate, grand
  SCALE / SIZE: cavernous, cramped, expansive, narrow, double-height-ceilings, low-ceilings, vaulted-ceilings, intimate
  CONDITION: pristine, weathered, renovated, decrepit, well-maintained, deteriorating, restored, original, distressed
  DISTINCTIVE FEATURES: spiral-staircase, rooftop-access, courtyard, fireplace, exposed-pipes, exposed-beams, columns, arches, balcony, terrace, basement, attic, kitchen-island
  COLOR PALETTE: white-walls, dark-wood, jewel-tones, pastel, monochrome, colorful, neutral, black-and-white
  CINEMATIC NOTES: shootable-360, hard-to-light, single-window-room, multiple-rooms, open-plan, character-rich, blank-canvas
  ROOM TYPES (use as tags too): kitchen, bathroom, bedroom, living-room, dining-room, foyer, hallway, basement, attic, exterior, backyard, rooftop

PER-IMAGE TAGS — provide 4-7 tags PER IMAGE (no more — keep them concise). These are MORE specific than the album tags — they describe what's actually visible in that one shot. A bedroom shot might tag "bedroom, four-poster-bed, hardwood, warm-lighting"; an exterior shot might tag "exterior, tudor, weathered, lots-of-trees". Different rooms typically have different feels — capture that.

Pick whichever genuinely apply based on what you see. Prefer specific over generic. Multi-word tags use hyphens. Do NOT include the location name or generic words like "interior"/"building".

OUTPUT: Return ONLY a JSON object, no prose, no markdown fences. Schema:
{
  "path": "category/subcategory",
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence describing what you see",
  "tags": ["album-level tag1", "tag2", ...],
  "per_image_tags": {
    "0": ["specific tags for image 0"],
    "1": ["specific tags for image 1"],
    ...
  },
  "alternative_paths": [{"path": "...", "confidence": 0.6}]
}`;
}

function buildAlbumMessage(album, imageSources) {
  const parts = [];
  const lines = [];
  lines.push(`Name: ${album.name || '(unnamed)'}`);
  if (album.address || album.city) {
    const addrParts = [album.address, album.city, album.state].filter(Boolean).join(', ');
    lines.push(`Address: ${addrParts}`);
  }
  if (album.place_name && album.place_name !== album.name) {
    lines.push(`Business: ${album.place_name}`);
  }
  if (album.place_website) lines.push(`Website: ${album.place_website}`);
  if (album.place_hours)   lines.push(`Hours: ${album.place_hours}`);
  if (album.notes) {
    const truncated = String(album.notes).slice(0, 800);
    lines.push(`Notes:\n${truncated}`);
  }
  parts.push({ type: 'text', text: lines.join('\n') });

  imageSources.forEach((src, i) => {
    if (!src) return;  // skip failed fetches
    parts.push({ type: 'text', text: `Image ${i}:` });
    parts.push({ type: 'image', source: src });
  });
  return parts;
}

function buildSelectionMessage(imageSources, targetCount) {
  // Filter out nulls (failed fetches) for the count message
  const valid = imageSources.filter(Boolean);
  const parts = [{
    type: 'text',
    text: `Pick the ${targetCount} most representative images from these ${valid.length} photos.`
  }];
  imageSources.forEach((src, i) => {
    if (!src) return;
    parts.push({ type: 'text', text: `Image ${i}:` });
    parts.push({ type: 'image', source: src });
  });
  return parts;
}

// ── Anthropic API call ─────────────────────────────────────────────────────
async function callClaude(model, systemPrompt, userContent, apiKey, maxTokens) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
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
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
          ],
          messages: [{ role: 'user', content: userContent }]
        }),
        signal: ctrl.signal
      });

      // Rate limit — wait the recommended duration and retry
      if (res.status === 429) {
        clearTimeout(timer);
        if (attempt >= MAX_429_RETRIES) {
          const txt = await res.text();
          throw new Error(`Anthropic 429 after ${MAX_429_RETRIES} retries: ${txt.slice(0, 200)}`);
        }
        // Anthropic uses 'retry-after' (seconds) and 'anthropic-ratelimit-input-tokens-reset' (ISO ts)
        let waitSec = parseFloat(res.headers.get('retry-after') || '');
        if (!Number.isFinite(waitSec) || waitSec <= 0) {
          // Fall back to ratelimit-reset header (an ISO timestamp)
          const resetIso = res.headers.get('anthropic-ratelimit-input-tokens-reset');
          if (resetIso) {
            const ms = new Date(resetIso).getTime() - Date.now();
            if (ms > 0) waitSec = ms / 1000;
          }
        }
        if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = 15 * (attempt + 1);
        // Cap at 60s per wait so we don't blow the Vercel function timeout
        const sleepMs = Math.min(waitSec * 1000, 60000);
        console.log(`[classify] 429 rate-limited, waiting ${Math.round(sleepMs/1000)}s before retry ${attempt+1}/${MAX_429_RETRIES}`);
        await new Promise(r => setTimeout(r, sleepMs));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json();
      const textBlock = (data.content || []).find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text in response');
      return { text: textBlock.text, usage: data.usage || {} };
    } catch (e) {
      lastErr = e;
      if (attempt >= MAX_429_RETRIES || (e.name === 'AbortError' && !/abort/i.test(e.message || ''))) throw e;
      // Network error etc — small backoff and retry
      if (e.message && !/Anthropic 429/.test(e.message)) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Failed after retries');
}

function parseJSON(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const first = cleaned.indexOf('{');
  if (first < 0) throw new Error('No JSON in: ' + cleaned.slice(0, 120));
  cleaned = cleaned.slice(first);

  // Strategy 1: direct parse if it ends in '}'
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace > 0) {
    try { return JSON.parse(cleaned.slice(0, lastBrace + 1)); } catch (e) { /* fall through */ }
  }

  // Strategy 2: scan, tracking depths + the current string's start position
  let inString = false, escape = false;
  let braceDepth = 0, bracketDepth = 0;
  let lastSafeEnd = -1;             // index just past last completion at root depth
  let lastTokenEnd = -1;            // index just past last completed value (any depth)
  let currentStringStart = -1;      // position of unmatched " (if we end mid-string)

  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') { inString = false; currentStringStart = -1; lastTokenEnd = i + 1; }
      continue;
    }
    if (c === '"') { inString = true; currentStringStart = i; continue; }
    if (c === '{') braceDepth++;
    else if (c === '}') {
      braceDepth--;
      lastTokenEnd = i + 1;
      if (braceDepth === 0 && bracketDepth === 0) lastSafeEnd = i + 1;
    }
    else if (c === '[') bracketDepth++;
    else if (c === ']') { bracketDepth--; lastTokenEnd = i + 1; }
    else if (/[\d\.\-]/.test(c) || /[truefalsn]/i.test(c)) lastTokenEnd = i + 1;
  }

  if (lastSafeEnd > 0) {
    try { return JSON.parse(cleaned.slice(0, lastSafeEnd)); } catch (e) {}
  }

  // Determine cut point for repair
  let cut;
  if (inString && currentStringStart >= 0) {
    // Mid-string truncation: cut to before the opening " of the unclosed string
    cut = currentStringStart;
    // Walk back over whitespace, then optional ':' (key separator), then optional key string
    while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
    if (cut > 0 && cleaned[cut - 1] === ':') {
      cut--;
      while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
      // Strip the key (string in quotes)
      if (cut > 0 && cleaned[cut - 1] === '"') {
        cut--;  // past closing quote of key
        while (cut > 0 && cleaned[cut - 1] !== '"') cut--;
        if (cut > 0) cut--;  // past opening quote of key
      }
    }
    // Strip preceding comma + whitespace
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  } else {
    cut = lastTokenEnd > 0 ? lastTokenEnd : cleaned.length;
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  }

  // Re-scan up to cut to compute open-bracket/open-brace counts
  let bd = 0, kd = 0, str = false, esc = false;
  for (let i = 0; i < cut; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (str) {
      if (c === '\\') esc = true;
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') str = true;
    else if (c === '{') bd++;
    else if (c === '}') bd--;
    else if (c === '[') kd++;
    else if (c === ']') kd--;
  }

  let candidate = cleaned.slice(0, cut);
  // Close arrays first (typically inner), then objects
  for (let i = 0; i < kd; i++) candidate += ']';
  for (let i = 0; i < bd; i++) candidate += '}';
  // Strip trailing commas before closers
  candidate = candidate.replace(/,(\s*[\]}])/g, '$1');

  try { return JSON.parse(candidate); } catch (e) {
    throw new Error('JSON parse failed (recovery exhausted): ' + e.message + ' | head: ' + cleaned.slice(0, 80));
  }
}

// ── Pass 1: Curate images ─────────────────────────────────────────────────
async function curateImages(allUrls, apiKey) {
  if (allUrls.length <= TARGET_COUNT) {
    return { indices: allUrls.map((_, i) => i), curationReasoning: '(skipped: ≤8 images)', usedCuration: false };
  }

  // Sample evenly if album is huge
  const sampledIndices = sampleEvenly(allUrls.length, MAX_THUMBS_PER_PASS1);
  const sampledThumbUrls = sampledIndices.map(i => smThumb(allUrls[i]));

  // Fetch all thumbnails as base64 (SmugMug blocks Anthropic's URL fetcher)
  const thumbSources = await fetchImagesAsBase64(sampledThumbUrls, 6000);
  const validCount = thumbSources.filter(Boolean).length;
  if (validCount === 0) {
    // All failed — fall back to just using the first TARGET_COUNT indices
    return { indices: sampledIndices.slice(0, TARGET_COUNT), curationReasoning: '(thumbnail fetch failed; using first ' + TARGET_COUNT + ')', usedCuration: false };
  }

  const sys = buildSelectionSystemPrompt(TARGET_COUNT);
  const userParts = buildSelectionMessage(thumbSources, TARGET_COUNT);
  const r = await callClaude(HAIKU, sys, userParts, apiKey, 400);
  const parsed = parseJSON(r.text);

  // Map sampled indices back to original indices in allUrls
  const selected = (parsed.selected || [])
    .filter(i => Number.isInteger(i) && i >= 0 && i < sampledIndices.length)
    .filter(i => thumbSources[i])  // skip indices whose fetch failed
    .slice(0, TARGET_COUNT)
    .map(i => sampledIndices[i]);

  if (selected.length === 0) {
    return { indices: sampledIndices.slice(0, TARGET_COUNT), curationReasoning: '(fallback: no valid selection returned)', usedCuration: false };
  }

  return { indices: selected, curationReasoning: parsed.reasoning || '', usedCuration: true };
}

async function classifyWithImages(album, taxonomy, corrections, imageSources, model, apiKey) {
  const sys = buildClassifySystemPrompt(taxonomy, corrections);
  const userParts = buildAlbumMessage(album, imageSources);
  const r = await callClaude(model, sys, userParts, apiKey, 1000);
  return parseJSON(r.text);
}

// ── Top-level: classify a single album ────────────────────────────────────
async function classifyOne(album, taxonomy, corrections, apiKey) {
  const allImages = (album.image_urls || []).filter(Boolean);
  const allKeys = album.image_keys || [];  // parallel array; may be empty

  if (allImages.length === 0) {
    // Text-only fallback
    const sys = buildClassifySystemPrompt(taxonomy, corrections);
    const userParts = buildAlbumMessage(album, []);
    const r = await callClaude(HAIKU, sys, userParts, apiKey, 1200);
    const result = parseJSON(r.text);
    return { ...result, key: album.key, model: HAIKU, _images_used: 0, _curation: 'none', selected_image_keys: [], per_image_tags_by_key: {} };
  }

  // Pass 1: curate
  const { indices, curationReasoning, usedCuration } = await curateImages(allImages, apiKey);

  // Pass 2: fetch medium versions of the curated set, then run Sonnet
  // (medium @ ~600px is plenty for classification and uses ~60% fewer tokens than large)
  const curatedMediumUrls = indices.map(i => smMedium(allImages[i]));
  const mediumSources = await fetchImagesAsBase64(curatedMediumUrls, 10000);

  // Track which indices succeeded (medium fetch worked)
  const validPairs = mediumSources
    .map((src, i) => src ? { src, originalIdx: indices[i], orderIdx: i } : null)
    .filter(Boolean);

  if (validPairs.length === 0) {
    const sys = buildClassifySystemPrompt(taxonomy, corrections);
    const userParts = buildAlbumMessage(album, []);
    const r = await callClaude(HAIKU, sys, userParts, apiKey, 1200);
    const result = parseJSON(r.text);
    return {
      ...result, key: album.key, model: HAIKU, _images_used: 0,
      _curation: 'failed-medium-fetch', selected_image_keys: [], per_image_tags_by_key: {}
    };
  }

  // Build the message with valid sources only; their order index in the AI's view = position in validPairs
  const validSources = validPairs.map(p => p.src);
  const result = await classifyWithImages(album, taxonomy, corrections, validSources, SONNET, apiKey);

  // Map per_image_tags from positional index → image_key
  const perImageByKey = {};
  const selectedKeys = [];
  validPairs.forEach((p, viewIdx) => {
    const imgKey = allKeys[p.originalIdx] || null;
    if (imgKey) {
      selectedKeys.push(imgKey);
      const tagsForThis = (result.per_image_tags && result.per_image_tags[String(viewIdx)]) || [];
      perImageByKey[imgKey] = tagsForThis;
    }
  });

  return {
    ...result,
    key: album.key,
    model: SONNET,
    _images_used: validSources.length,
    _curation: usedCuration ? 'haiku' : 'all',
    _curation_reasoning: curationReasoning,
    selected_image_keys: selectedKeys,
    selected_image_indices: validPairs.map(p => p.originalIdx),
    per_image_tags_by_key: perImageByKey
  };
}

// ── Handler ────────────────────────────────────────────────────────────────
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
    const albums = Array.isArray(body && body.albums) ? body.albums : [];
    const taxonomy = Array.isArray(body && body.taxonomy) ? body.taxonomy : [];
    const corrections = Array.isArray(body && body.corrections) ? body.corrections : [];
    if (albums.length === 0) return res.status(400).json({ ok: false, error: 'no albums in request' });
    if (albums.length > 25) return res.status(400).json({ ok: false, error: 'max 25 albums per request' });

    const results = await pmap(albums, a => classifyOne(a, taxonomy, corrections, apiKey), PARALLEL);

    const cleaned = results.map((r, i) => {
      if (r && r.error) return { key: albums[i].key, error: r.error };
      return r;
    });
    return res.json({ ok: true, results: cleaned });
  } catch (e) {
    console.error('classify error:', e);
    return res.status(500).json({ ok: false, error: 'classification failed' });
  }
};
