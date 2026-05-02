// api/deep_tag.js — multi-stage album analysis pipeline.
//
// PIPELINE (driven by ?stage= query param so the frontend runs in steps):
//
//   stage=classify  Haiku on MEDIUM images. Per photo, returns:
//                     - description (1 sentence, ~15-25 words)
//                     - tags (5-8 keywords)
//                     - role / room / composition / is_sharp
//                     - reject (boolean — strict, includes blank/blurry/contextless)
//                   Optionally takes contextImageUrls (1-5 centerpieces) as priming.
//                   Frontend pre-filters obviously-blank images via local blur detection
//                   before this stage runs, so we never pay to look at junk.
//
//   stage=organize  Sonnet WITH IMAGES of up to 60 best candidates.
//                   Receives centerpieces + actual photos + per-photo descriptions/tags.
//                   Returns the walkthrough order + top-pick set.
//
//   stage=enrich    Sonnet on LARGE images of top picks. Adds richer keywords.
//
// (The old separate "triage" stage is gone — its job was redundant with classify
//  once we added is_sharp + reject + role=logistic detection. Local blur filtering
//  handles the obvious junk; AI handles the judgment calls.)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';
const { parseJSON } = require('./_lib/parseClaude');

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const CLASSIFY_BATCH_SIZE = 10;   // medium-image batches per Anthropic call
const ENRICH_BATCH_SIZE   = 6;
const PARALLEL_BATCHES    = 2;    // 2 concurrent Anthropic calls per chunk
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

// Returns total cost in 1/100ths of a cent (NOT cents, NOT dollars).
//
// Storage unit choice: we use integer 1/100ths-of-a-cent (a.k.a. "millicents")
// so we can store costs as INTEGER in the api_usage DB column without losing precision.
// Converting back: dollars = cost_centhsofacent / 10000, cents = cost_centhsofacent / 100.
//
// Per-token multipliers:
//   Haiku 4.5 input  = $1/M tokens = 100 millicents per token? NO — $1/M = $0.000001/tok
//   = 0.0001 cents/tok = 0.01 millicents/tok. ← that's the 0.01 multiplier below.
//   Haiku output     = $5/M = 0.05 millicents/tok
//   Haiku cache-read = $0.10/M = 0.001 millicents/tok
//   Haiku cache-write= $1.25/M = 0.0125 millicents/tok
//   Sonnet input     = $3/M = 0.03 millicents/tok
//   Sonnet output    = $15/M = 0.15 millicents/tok
//   Sonnet cache-read= $0.30/M = 0.003 millicents/tok
//   Sonnet cache-write= $3.75/M = 0.0375 millicents/tok
//
// Sanity check: 100,000 Haiku input tokens × 0.01 = 1000 millicents = 10 cents = $0.10 ✓
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

// Strip HTML entities, markdown link syntax, and collapse whitespace from notes
// before sending to the AI. Otherwise Sonnet sometimes mirrors these characters
// in its output and breaks JSON parsing (e.g. unescaped quotes from HTML entities).
function sanitizeNotes(s, maxLen) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen || 1500);
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE: CLASSIFY — Haiku on MEDIUM images, single pass per album.
// Returns description + tags + role + room + composition + sharpness + reject
// for every photo. The frontend pre-filters obvious blur via local Laplacian
// before calling this, so we don't pay AI to look at literal black frames.
// ════════════════════════════════════════════════════════════════════════════
function classifySystemPrompt(albumName, albumNotes, albumTags, albumCategory, googlePlaces, rejectedTags, userExamples) {
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

  let avoidTags = '';
  if (rejectedTags && rejectedTags.length) {
    const slice = rejectedTags.slice(0, 25);
    avoidTags = `\nUSER FEEDBACK — these tags have been removed by the user in past albums; AVOID them:\n  ${slice.join(', ')}`;
  }

  let exampleBlock = '';
  if (userExamples && userExamples.length) {
    const fav = userExamples.filter(e => e.action === 'favorite').slice(0, 8);
    const rej = userExamples.filter(e => e.action === 'reject').slice(0, 8);
    if (fav.length || rej.length) {
      exampleBlock = `\nUSER PRECEDENT FROM SIMILAR ALBUMS (this user's past edits in albums of the same category — calibrate your judgments accordingly):`;
      if (fav.length) {
        exampleBlock += `\n  PROMOTED (user favorited these):\n` + fav.map(e =>
          `    - role:${e.role} tags:[${(e.tags || []).join(',')}]`
        ).join('\n');
      }
      if (rej.length) {
        exampleBlock += `\n  DEMOTED (user rejected these):\n` + rej.map(e =>
          `    - role:${e.role} tags:[${(e.tags || []).join(',')}]`
        ).join('\n');
      }
    }
  }

  return `You analyze film/TV scout photos for a location library. Return metadata for each NUMBERED photo. The user message may begin with one or more labeled CENTERPIECE images that show what the location IS — use those as context, do NOT classify them.

ALBUM CONTEXT:
  Album: ${albumName || '(unnamed)'}
  ${albumCategory ? `Category: ${albumCategory}` : ''}
  ${albumNotes ? `Notes: ${sanitizeNotes(albumNotes)}` : ''}
  ${albumTags && albumTags.length ? `Existing keywords: ${albumTags.slice(0, 20).join(', ')}` : ''}${typeGuidance}${placesContext}${avoidTags}${exampleBlock}

FOR EACH NUMBERED PHOTO, output:
  • description: ONE concise sentence (15-25 words) describing what's visible — focus on the PERMANENT location, not transient conditions. Format: "Wide angle of [space] showing [permanent features]" or similar. Concrete details, not vague summaries. Skip weather, parked vehicles, present-but-temporary staging — describe the place, not what's happening to be in the frame today.
  • tags: 5-8 SPECIFIC, DISTINCTIVE tags. Multi-word tags use hyphens.
      AVOID GENERIC TAGS that apply to nearly any location: "interior", "building", "room", "wall", "floor", "ceiling", "window", "door", "kitchen", "bedroom", "bathroom", "living-room", "hallway"
      AVOID EPHEMERAL TAGS — temporary conditions that aren't part of the location itself:
        weather: "overcast-sky", "snowing", "rainy", "cloudy", "sunny-day", "winter-conditions", "fall-foliage", "spring-bloom"
        present-but-not-permanent: "scattered-vehicles", "parked-cars", "construction-cones", "temporary-signage", "people-walking", "delivery-truck", "open-umbrellas"
        time-of-day: "morning-light", "evening", "night-shot" (unless lighting design IS distinctive — e.g. "permanent-neon-sign" is fine)
        seasonal staging: "halloween-decorations", "christmas-tree", "wedding-setup"
      The location is what's PERMANENT. Cars come and go. Snow melts. Signs change. Tag the building.
      PREFER SPECIFIC, SEARCHABLE TAGS: distinctive features (cul-de-sac, in-ground-pool, rooftop-deck, exposed-brick, cathedral-ceiling, marble-fireplace, art-deco-trim), materials (terrazzo-floor, wood-paneling, copper-hood), eras (pre-war, mid-century, brutalist), moods (cozy, sterile, gritty), unusual elements (spiral-staircase, sunken-living-room, juliet-balcony)
      Generic room types are OK ONLY if combined with something distinctive (e.g. "open-kitchen" not "kitchen", "primary-suite" not "bedroom").
      Don't include the location name. Don't include obvious words.
  • is_sharp: TRUE only if the main subject is in CRISP focus. BE STRICT — any soft focus, motion blur, or general unsharpness gets FALSE. Even slight unsharpness on the main subject = FALSE. When in doubt, FALSE. We'd rather demote a borderline photo than feature one that looks soft on a presentation deck.
  • composition: integer 1-10 (10 = striking, 1 = blurry/blank/mistake).
  • depth_quality: integer 1-5 measuring spatial depth in the image:
      5 = strong depth-of-field, layered foreground/midground/background, clear leading lines, you can FEEL the space
      4 = good depth, three-dimensional read of the space
      3 = adequate depth, you understand the space's volume
      2 = mostly flat, one plane dominates
      1 = no depth signal — flat wall shot, fully head-on detail, no spatial information
    Photos with high depth_quality help directors visualize the space — score them strongly.
  • is_pano: TRUE if this image is a panorama (very wide aspect ratio, stitched-together field of view). Used for duplicate detection — a pano + non-pano of the same view counts as duplicates.
  • dup_of: empty string OR the index 'i' of an EARLIER photo in this same batch that this photo is a near-duplicate of. STRICT RULE — a tighter version of an earlier wide is ONLY a duplicate if the framing is similar enough that they don't add separate value. Specifically:
      - Two shots from the same vantage point within a few feet of each other, same angle = DUPLICATE
      - A pano and a non-pano showing essentially the same view = DUPLICATE
      - A tighter shot of the SAME composition (same subject centered, same angle, just zoomed in less than 50% of the wide's framing) = DUPLICATE
      - A genuinely closer shot that focuses on a specific feature within the wider scene (subject is a SMALLER portion of the wide's frame, ~50% or less) = NOT A DUPLICATE — these are continuity shots that lead the eye in. Keep both.
    DON'T flag as duplicate:
      - Two angles of the same room from different positions
      - Wide of a room + closeup of a feature within that room (different intent)
      - Shots that show different parts of the same space
    BE CAREFUL with similar-looking spaces: two different auditoriums, two different bedrooms, two different bathrooms in the same property are NOT duplicates of each other even if they look similar. Only flag as duplicate when you're confident it's the SAME space + nearly the same composition.
    Only set this if you're CONFIDENT. When in doubt, leave empty.
  • reject: TRUE if this photo doesn't belong in any presentation deck — it's a technical mistake or shows nothing useful:
      - Blank, near-blank, mostly black/white, no visible subject
      - Out of focus, soft-focused on the subject, or motion-blurred
      - Accidental shots (sky, ground, lens cover, finger over lens)
      - Duplicate of an already-better-captured shot (only if obviously redundant)
    KEEP (reject:false) if the photo shows ANY recognizable space and is sharp enough to use, even if it's a "reference" shot. Reference shots are fine — they just go to the back via role:logistic.

    THE DISTINCTION between reject and logistic:
      • reject = "this photo is technically broken or accidentally taken — toss it"
      • logistic = "this photo is fine, it just isn't a story shot — use it as reference, keep at the back"
    A blurry shot of a great room → reject:true (it's broken).
    A sharp shot of a doorbell → reject:false, role:logistic (fine photo, just not a story shot).
    A blurry shot of a doorbell → reject:true (broken AND not story-worthy).
  • role: ONE of:
      - "hero-exterior"  — establishing front facade of the location
      - "side-exterior"  — supporting exterior context
      - "entry-in"       — looking INTO the space from outside
      - "entry-out"      — looking OUT from inside toward entry
      - "room-overview"  — WIDE establishing of a distinct interior space, showing how the space lives
      - "room-detail"    — closer feature of furniture/art/materials that adds character to the space
      - "outdoor-feature" — yard, pool, patio, garden — distinct outdoor space
      - "logistic"       — REFERENCE shots, kept-but-not-story. Sharp photos that show a single feature without scene context: a closet, a doorbell, a single stair, a hardware closeup, a blank wall, a partial of something. The KEY question: does this answer "what is this place LIKE?" (story → not logistic) or "what does this specific feature look like?" (reference → logistic). BE GENEROUS marking logistic — wide shots are story; tight crops of single features are usually reference.
      - "transition"     — passages with no distinctive character (plain hallway, plain stairwell, vestibule)
  • room: short label (e.g. "kitchen", "ballroom", "bath-1"). Empty string if unknown.

PANORAMA HANDLING: judge a panorama by what's in its central 16x9 region. Don't penalize for the format. But mark is_pano:true so duplicate detection can match it against non-pano shots of the same view.

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "photos": [
    { "i": 0, "description": "Wide angle of...", "tags": ["..."], "is_sharp": true, "composition": 7, "depth_quality": 4, "is_pano": false, "dup_of": "", "reject": false, "role": "room-overview", "room": "kitchen" },
    ...
  ]
}`;
}

async function classifyBatch(album, batch, contextImages, apiKey) {
  const sources = await Promise.all(batch.map(async img => {
    try { return await fetchImageAsBase64(smMedium(img.url), 8000); }
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

  const sys = classifySystemPrompt(album.name, album.notes, album.tags, album.category, album.googlePlaces, album.rejectedTags, album.userExamples);
  // Bumped to 3000 tokens — descriptions add ~25 tokens × 10 photos = 250 tokens of output
  const r = await callAnthropic(HAIKU, sys, userParts, apiKey, 3000);
  const parsed = parseJSON(r.text);
  const photos = Array.isArray(parsed.photos) ? parsed.photos : [];

  const results = [];
  validPairs.forEach((p, i) => {
    const m = photos.find(x => x && x.i === i);
    if (!m) {
      results.push({
        key: p.img.key, description: '', tags: [],
        is_sharp: true, composition: 5, depth_quality: 3, is_pano: false, dup_of: '',
        reject: false, role: 'unknown', room: ''
      });
    } else {
      // dup_of comes back as a number index — convert to the actual photo key in this batch
      let dupOfKey = '';
      if (m.dup_of !== undefined && m.dup_of !== null && m.dup_of !== '') {
        const dupIdx = typeof m.dup_of === 'number' ? m.dup_of : parseInt(String(m.dup_of), 10);
        if (Number.isFinite(dupIdx) && dupIdx >= 0 && dupIdx < i) {
          // Look up the key of the photo that came at that index
          const target = validPairs[dupIdx];
          if (target) dupOfKey = target.img.key;
        }
      }
      results.push({
        key: p.img.key,
        description: typeof m.description === 'string' ? m.description.trim() : '',
        tags: Array.isArray(m.tags) ? m.tags : [],
        // BE STRICT: only true if Haiku explicitly returned true. Missing/null → false.
        is_sharp: m.is_sharp === true,
        composition: typeof m.composition === 'number' ? Math.max(1, Math.min(10, m.composition)) : 5,
        depth_quality: typeof m.depth_quality === 'number' ? Math.max(1, Math.min(5, m.depth_quality)) : 3,
        is_pano: !!m.is_pano,
        dup_of: dupOfKey,
        reject: !!m.reject,
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
// STAGE: ORGANIZE — Sonnet WITH IMAGES of the candidates returns walkthrough order
// ════════════════════════════════════════════════════════════════════════════
// Sonnet sees the actual photos (medium size) for ranking-quality candidates,
// not just text summaries. Logistic/rejected photos stay text-only at the back.
// This is the meaningful upgrade: the AI doing the organizing now actually SEES
// the photos rather than trusting Stage 2's tags.
const ORGANIZE_PROMPT = `You're a film/TV scout's assistant. Your output is a presentation order — a walkthrough that leads a director through this location as if they're physically touring it. The viewer's experience is the priority. Quality and composition are SECONDARY to flow.

═══ FLOW PRINCIPLES (the most important rule) ═══

You are walking the viewer through a physical space. Don't bounce around. Think like you're actually leading them by the hand:

  • Lead with the BEST single hero exterior — establish where we are
  • Walk to the door (entry tight)
  • Step inside (entry-in, then a wide of inside-looking-out)
  • Move through interior spaces ONE AT A TIME
    - Finish a room before moving on
    - Don't return to a room you've already shown unless there's a reason
    - The reason can be: showing it from a balcony or upper floor that requires going through other spaces first; or a different time/state of the same room (e.g. set up vs. broken down)
  • Outdoor features last (unless this IS an outdoor location)
  • Side/back exteriors at the very end (unless they show the centerpiece hero)

═══ EYE CONTINUITY (when possible, not a rule) ═══

Within and between connected spaces, prefer photo sequences where the viewer's eye can follow:
  • If photo A shows the couch from the right and photo B shows the same couch from the other side, sequence them adjacent — the viewer can follow the couch as the orientation point.
  • If a photo includes BOTH the current room and a glimpse of the next room (e.g. living room with the kitchen visible through a doorway), use it as a TRANSITION SHOT before pivoting to that next room.
  • Use the descriptions to identify these continuity opportunities.
  • This is a soft preference, not a hard rule. When eye continuity conflicts with flow, flow wins.

═══ ROOM ALLOCATION (use the per-room overview) ═══

The PER-ROOM SUMMARY below tells you how many photos exist for each space. Allocate top-pick slots accordingly:
  • Major spaces central to the location's purpose — 2-3 top picks each
  • Medium spaces — 1-2 top picks each
  • Minor/peripheral spaces — 1 top pick if notable, otherwise skip
  • Don't give bathrooms 3 top picks just because there are 8 bathroom photos. Allocate by importance to the location's purpose, not by photo count.

═══ DUPLICATE DETECTION (be aggressive but careful) ═══

These are duplicates — keep ONE, push the rest to the end:
  • A panorama and a non-panorama from the same vantage point of the same space — the pano IS the non-pano, just wider. Pick whichever is sharper / better composed; demote the other.
  • Two shots from nearly the same position (within a few feet, same room, same angle) — pick the better one
  • A tighter version of the same wide (same composition, just less zoomed-out) where the framing isn't meaningfully different — pick the wide, demote the tight
  • Photos with marker [DUP_OF:keyXXX] in the summary — the per-photo classifier flagged these as visually redundant. Treat the linked photo as primary; demote this one.

NOT duplicates — keep both:
  • A wide of a room + a closeup of a specific feature inside that room (the closeup focuses on something distinct within the wider scene) — these are continuity shots, sequence them adjacent
  • Two angles of the same room from different positions
  • Two different rooms that happen to look similar (e.g. two auditoriums in the same property, two similar bedrooms in a hotel) — DO NOT cross-reference them as duplicates of each other. Each distinct space gets its own treatment. Use the room field and descriptions to distinguish.

═══ FRONT EXTERIOR DISCIPLINE ═══

  • At most ONE hero exterior in the top 5 picks
  • At most ONE entry-tight shot in the top 5 picks
  • Other front exteriors → only in lead-in if they show the SAME hero element as a centerpiece exterior
  • Side wings, back of building, peripheral exteriors → role:logistic, push to end

═══ CENTERPIECE PRIORITY ═══

  • Centerpiece 1 is the user's PRIMARY pick — what defines this location
  • If centerpiece 1 is exterior, it leads the walkthrough
  • If centerpiece 1 is interior, hero exterior still opens (if available) but reach centerpiece 1's space EARLY
  • Centerpieces 2-5 always appear in top picks unless clearly inappropriate

═══ DEPTH AND COMPOSITION (slot-fillers, not slot-decisions) ═══

Flow decides WHICH SLOTS exist in the walkthrough (lead-in, kitchen overview, kitchen detail, etc.).
Composition + depth decide WHICH PHOTO FILLS each slot when there are multiple candidates.

So when flow says "we need a kitchen overview here," choose among kitchen-overview-tagged photos by:
  • depth_quality (higher = more spatial information for the director)
  • composition score (higher = better looking)
These two never override flow. They never promote a kitchen detail above a kitchen overview just because it scored 9. They ONLY pick between candidates that flow has already deemed slot-equivalent.

═══ TOP PICKS ═══

  • These are the photos that, in this order, would be the highlight reel
  • Skip logistic, blurry, blank, and duplicate from top picks entirely

═══ OUTPUT FORMAT ═══

Return ONLY this JSON, no prose, no markdown fences. KEEP IT MINIMAL:
{
  "suggested_path": "category/subcategory",
  "path_confidence": 0.0-1.0,
  "ordered": [
    { "key": "abc123", "top_pick": true },
    { "key": "def456", "top_pick": true },
    ...
  ]
}

CRITICAL FORMATTING RULES — your output will be machine-parsed:
  • Each ordered item is JUST { "key": "...", "top_pick": true|false } — NO other fields
  • Do NOT include rank_reason or any explanation in the JSON
  • Album keys are alphanumeric only — copy them exactly from the input
  • Do NOT include any text before the opening { or after the closing }
  • Do NOT use markdown formatting

PATH SUGGESTION:
  • Use existing taxonomy paths when one fits (passed in TAXONOMY below)
  • Propose a new path only if no existing one fits well
  • Lowercase, hyphenated, hierarchical (e.g. "residences/brownstones", "restaurants/diners", "events/ballrooms")
  • For NY metro: respect borough/area distinctions (manhattan, brooklyn, queens, bronx, staten-island, long-island, westchester, jersey, hudson-valley)
  • path_confidence: 0.95+ = certain, 0.85 = strong, 0.70 = reasonable, <0.70 = uncertain

Include EVERY photo (both the candidates you see and the rejected ones listed below) in "ordered". The order of items IS the new walkthrough order.`;

async function runOrganize(album, perPhoto, contextImageUrls, candidateImages, taxonomy, apiKey) {
  const urls = Array.isArray(contextImageUrls) ? contextImageUrls.filter(Boolean).slice(0, 5) : [];
  const contextImages = [];
  for (const url of urls) {
    try { contextImages.push(await fetchImageAsBase64(smMedium(url), 8000)); }
    catch (e) {}
  }

  // Decide which photos to send as actual images vs. as text-only summaries.
  //
  // We compute an importance score per photo combining:
  //   - composition (1-10 base)
  //   - role bonus (hero exterior, room overview > details > transition)
  //   - room rarity (photos of less-documented rooms get a boost)
  //   - centerpiece bonus (user picks always elevated)
  //   - chronological-spread tiebreaker (slight nudge toward time coverage)
  //   - near-duplicate penalty (same role + same room + adjacent original index → likely dup)
  //
  // Then we take the top 60 by score, capped at our budget.
  const eligible = perPhoto.filter(p =>
    !p.isRejected && p.is_sharp !== false && p.role !== 'logistic' && p.role !== 'transition'
  );
  // Build room → photos map (for rarity calculation)
  const photosByRoom = new Map();
  eligible.forEach(p => {
    const r = p.room || '_unknown';
    if (!photosByRoom.has(r)) photosByRoom.set(r, []);
    photosByRoom.get(r).push(p);
  });

  const ROLE_BONUS = {
    'hero-exterior':   3,
    'entry-in':        4,
    'entry-out':       3,
    'room-overview':   3,
    'outdoor-feature': 2,
    'room-detail':     1,
    'side-exterior':   0,
    'unknown':         0
  };

  function roomRarityBonus(room) {
    const list = photosByRoom.get(room || '_unknown') || [];
    if (list.length <= 1) return 3;   // unique room — highest priority
    if (list.length <= 3) return 2;
    if (list.length <= 6) return 1;
    return 0;                          // very common room — no rarity boost
  }

  // Score each eligible photo
  eligible.forEach(p => {
    let score = (p.composition || 5);
    score += ROLE_BONUS[p.role] || 0;
    score += roomRarityBonus(p.room);
    if (p.centerpieceSlot && p.centerpieceSlot > 0) score += 5;
    // Depth bonus — high depth_quality means the photo conveys spatial volume,
    // which is exactly what scout decks need to communicate scale of a space.
    if (p.depth_quality) score += (p.depth_quality - 3);  // -2 to +2 around the median of 3
    // Hard penalty for AI-flagged duplicates
    if (p.dup_of) score -= 5;
    p._impScore = score;
  });

  // Detect near-duplicates: same room + same role + originalIndex within 2.
  // Group by (room, role) bucket, sort by composition desc, penalize all but the best.
  const dupBuckets = new Map();
  eligible.forEach(p => {
    const k = (p.room || '_') + '|' + (p.role || '_');
    if (!dupBuckets.has(k)) dupBuckets.set(k, []);
    dupBuckets.get(k).push(p);
  });
  dupBuckets.forEach(bucket => {
    if (bucket.length < 2) return;
    bucket.sort((a, b) => (b._impScore || 0) - (a._impScore || 0));
    // Within sorted bucket, penalize photos whose original index is within 2 of an
    // already-kept higher-scored photo (likely shot back-to-back of same thing).
    const kept = [];
    bucket.forEach(p => {
      const isDup = kept.some(k => Math.abs((p.originalIndex || 0) - (k.originalIndex || 0)) <= 2);
      if (isDup) p._impScore = (p._impScore || 0) - 3;
      kept.push(p);
    });
  });

  // Final pick: sort by score, take top 60. But guarantee centerpieces are in.
  eligible.sort((a, b) => (b._impScore || 0) - (a._impScore || 0));
  const TARGET = 60;
  const picked = eligible.slice(0, TARGET);
  // Force-include any centerpiece not already in the top 60
  eligible.forEach(p => {
    if (p.centerpieceSlot && p.centerpieceSlot > 0 && !picked.includes(p)) {
      picked.push(p);
    }
  });
  // Sort the final candidate set chronologically so Sonnet sees them in shot order
  // (helpful for understanding what came before/after each shot in the original walkthrough)
  picked.sort((a, b) => (a.originalIndex || 0) - (b.originalIndex || 0));
  const imageCandidates = picked;
  const imageCandidateKeys = new Set(imageCandidates.map(p => p.key));

  // Fetch medium-size images for those candidates
  const candidateUrlByKey = new Map();
  (candidateImages || []).forEach(c => { if (c && c.key && c.url) candidateUrlByKey.set(c.key, c.url); });
  const candidateSources = await Promise.all(imageCandidates.map(async p => {
    const url = candidateUrlByKey.get(p.key);
    if (!url) return null;
    try { return await fetchImageAsBase64(smMedium(url), 8000); }
    catch (e) { return null; }
  }));

  // Text-only summaries for ALL photos (so Sonnet sees the full scope including rejects).
  // Mark which ones it has visual access to with [IMG=N]. Photos NOT in the visual subset
  // rely on the description field — written by Stage 1 — to give Sonnet enough context
  // to rank them.
  const linesAll = perPhoto.map(p => {
    const parts = [`key=${p.key}`];
    parts.push(`idx=${p.originalIndex}`);
    if (p.role) parts.push(`role=${p.role}`);
    if (p.room) parts.push(`room=${p.room}`);
    parts.push(`comp=${p.composition || 5}`);
    if (p.depth_quality) parts.push(`depth=${p.depth_quality}`);
    parts.push(`sharp=${p.is_sharp !== false}`);
    if (p.is_pano) parts.push('PANO');
    if (p.dup_of) parts.push(`[DUP_OF:${p.dup_of}]`);
    if (p.tags && p.tags.length) parts.push(`tags=[${p.tags.slice(0, 8).join(',')}]`);
    if (p.description) parts.push(`desc="${String(p.description).replace(/"/g, "'").slice(0, 200)}"`);
    if (p.isRejected) parts.push('REJECTED');
    if (p.centerpieceSlot && p.centerpieceSlot > 0) parts.push(`*USER-CENTERPIECE-${p.centerpieceSlot}*`);
    if (imageCandidateKeys.has(p.key)) {
      const visualIdx = imageCandidates.findIndex(c => c.key === p.key);
      parts.push(`[IMG=${visualIdx}]`);
    }
    return parts.join(' · ');
  }).join('\n');

  // Per-room overview — gives Sonnet the data to allocate picks proportionally
  const roomCounts = new Map();
  perPhoto.forEach(p => {
    if (p.isRejected || p.role === 'logistic' || p.role === 'transition') return;
    const r = p.room || '(unspecified)';
    roomCounts.set(r, (roomCounts.get(r) || 0) + 1);
  });
  const roomOverview = Array.from(roomCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([r, c]) => `  ${r}: ${c} photos`)
    .join('\n');

  // Notes get sanitized before sending — module-level sanitizeNotes() strips HTML
  // entities and markdown link syntax that confuse Sonnet's JSON output.
  const cleanNotes = sanitizeNotes(album.notes);

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

  // Now the candidate images that Sonnet will visually rank
  if (candidateSources.some(Boolean)) {
    const validCount = candidateSources.filter(Boolean).length;
    userParts.push({ type: 'text', text: `CANDIDATE PHOTOS (${validCount} photos for visual ranking — referenced as IMG=N in the summaries below):` });
    candidateSources.forEach((src, i) => {
      if (!src) return;
      userParts.push({ type: 'text', text: `IMG=${i} (key=${imageCandidates[i].key}):` });
      userParts.push({ type: 'image', source: src });
    });
  }

  const taxonomyText = (Array.isArray(taxonomy) && taxonomy.length)
    ? `\n\nEXISTING TAXONOMY (prefer one of these paths if it fits):\n  ${taxonomy.slice(0, 80).join('\n  ')}`
    : '';

  userParts.push({
    type: 'text',
    text: `\nALBUM: ${album.name || '(unnamed)'}\n` +
          `Category: ${album.category || 'unknown'}\n` +
          `Notes: ${cleanNotes}` +
          placesText +
          taxonomyText +
          (roomOverview ? `\n\nPER-ROOM SUMMARY (use this to allocate top-pick slots proportionally):\n${roomOverview}` : '') +
          `\n\nALL PHOTOS (${perPhoto.length} total — visual candidates marked with IMG=N, the rest are text-only with their tags):\n${linesAll}\n\nReturn the walkthrough ordering AND a suggested folder path. Include every photo's key in "ordered".`
  });

  const r = await callAnthropic(SONNET, ORGANIZE_PROMPT, userParts, apiKey, 5000);
  let ordered = [];
  let suggestedPath = '';
  let pathConfidence = 0;
  try {
    const parsed = parseJSON(r.text);
    ordered = Array.isArray(parsed.ordered) ? parsed.ordered : [];
    suggestedPath = typeof parsed.suggested_path === 'string' ? parsed.suggested_path : '';
    pathConfidence = typeof parsed.path_confidence === 'number' ? parsed.path_confidence : 0;
  } catch (e) {
    console.error('[organize] JSON parse failed; falling back to regex extraction:', e.message);
    // Fallback: extract { "key": "...", "top_pick": ... } chunks from the raw text directly.
    // This handles cases where Sonnet's output has stray characters that break the full parse
    // but the per-item structure is still recoverable.
    const rx = /\{\s*"key"\s*:\s*"([^"]+)"\s*,\s*"top_pick"\s*:\s*(true|false)/g;
    let m;
    while ((m = rx.exec(r.text)) !== null) {
      ordered.push({ key: m[1], top_pick: m[2] === 'true' });
    }
    // Also try to recover the path/confidence
    const pathMatch = r.text.match(/"suggested_path"\s*:\s*"([^"]+)"/);
    if (pathMatch) suggestedPath = pathMatch[1];
    const confMatch = r.text.match(/"path_confidence"\s*:\s*([0-9.]+)/);
    if (confMatch) pathConfidence = parseFloat(confMatch[1]);
    console.log(`[organize] regex fallback recovered ${ordered.length} entries, path="${suggestedPath}"`);
  }
  return { ordered, suggestedPath, pathConfidence, usage: r.usage };
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

    if (stage === 'classify') {
      const album = {
        name: body.albumName || '',
        notes: body.albumNotes || '',
        tags: Array.isArray(body.albumTags) ? body.albumTags : [],
        category: body.albumCategory || '',
        googlePlaces: body.googlePlaces || null,
        rejectedTags: Array.isArray(body.rejectedTags) ? body.rejectedTags : [],
        userExamples: Array.isArray(body.userExamples) ? body.userExamples : []
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
      const candidateImages = Array.isArray(body.candidateImages) ? body.candidateImages : [];
      const taxonomy = Array.isArray(body.taxonomy) ? body.taxonomy : [];
      const contextImageUrls = Array.isArray(body.contextImageUrls)
        ? body.contextImageUrls
        : (body.contextImageUrl ? [body.contextImageUrl] : []);
      if (!perPhoto.length) return res.status(400).json({ ok: false, error: 'perPhoto required' });
      if (perPhoto.length > 250) return res.status(400).json({ ok: false, error: 'max 250 photos per organize' });
      const { ordered, suggestedPath, pathConfidence, usage } = await runOrganize(album, perPhoto, contextImageUrls, candidateImages, taxonomy, apiKey);
      return res.json({
        ok: true,
        ordered,
        suggestedPath, pathConfidence,
        usage, costCents: calcCost(null, usage)
      });
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
    // Log everything we know about the failure so the next 500 tells us exactly what broke.
    // This shows up in Vercel function logs.
    const stackLines = e && e.stack ? e.stack.split('\n').slice(0, 8).join('\n') : '(no stack)';
    console.error('[deep_tag] FAILURE:', {
      message: e && e.message,
      stack: stackLines,
      type: e && e.constructor && e.constructor.name,
      stage: (req.query && req.query.stage) || 'unknown',
      memory_used_mb: Math.round((process.memoryUsage && process.memoryUsage().heapUsed || 0) / 1024 / 1024),
      memory_rss_mb: Math.round((process.memoryUsage && process.memoryUsage().rss || 0) / 1024 / 1024),
    });
    // Return the actual error message to the client so the toast tells us something useful.
    return res.status(500).json({
      ok: false,
      error: (e && e.message) || 'deep tag failed',
      type: e && e.constructor && e.constructor.name
    });
  }
};
