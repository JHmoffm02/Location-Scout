// api/classify.js — image-aware album classifier with model escalation
//
// Strategy:
//   Pass 1: Haiku 4.5 + 6 medium images + name/notes/address.
//   If confidence < 0.70 → Pass 2: Sonnet 4.6 + most diagnostic image + 2 unused, all large.
//
// Request: POST { albums: [{key, name, notes, address, city, state, image_urls}], taxonomy: [...paths] }
// Response: { results: [{key, path, confidence, reasoning, model, tags, ...}] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-6';
const CONFIDENCE_THRESHOLD = 0.70;
const PARALLEL = 3;  // concurrent classifications

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

// SmugMug image size transforms
function smMedium(url) { return url ? url.replace(/\/(Th|Ti|S)\//, '/M/') : ''; }
function smLarge(url)  { return url ? url.replace(/\/(Th|Ti|S|M)\//, '/L/') : ''; }

// ── Bounded-concurrency map ────────────────────────────────────────────────
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

// ── Build the prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(taxonomy) {
  const taxList = (taxonomy && taxonomy.length)
    ? taxonomy.map(p => '  - ' + p).join('\n')
    : '  (no existing categories — propose appropriate ones)';

  return `You classify locations for a film/TV scout's photo library. Your job is to assign each location to a category path that matches how a scout would intuitively organize them.

EXISTING TAXONOMY (prefer these paths when they fit):
${taxList}

GUIDELINES:
- Use existing paths when an album fits one well, even loosely
- Propose NEW paths only when nothing existing fits — keep them lowercase, hyphenated, hierarchical (e.g. "residences/brownstones", "commercial/warehouses")
- Common patterns: residences/{houses|apartments|mansions|lofts|brownstones|townhouses}, restaurants/{casual|fine-dining|diners|cafes}, bars, hotels, hospitals, schools, offices, industrial/{warehouses|factories|garages}, religious, public/{libraries|courthouses|museums}, retail/{shops|malls}
- Confidence rubric: 0.95+ = images clearly show the type, 0.85 = name + 1 image confirm, 0.70 = strong textual evidence only, <0.70 = ambiguous
- "most_diagnostic_image" is the 0-indexed image that most strongly informed your decision (so we can re-use it if we re-classify)
- "tags" should be 3-7 concrete descriptors (e.g. "industrial", "exposed-brick", "rooftop-access") — useful for search

OUTPUT: Return ONLY a JSON object, no prose, no markdown fences. Schema:
{
  "path": "category/subcategory",
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence",
  "most_diagnostic_image": 0,
  "tags": ["tag1", "tag2"],
  "alternative_paths": [{"path": "...", "confidence": 0.6}]
}`;
}

function buildAlbumMessage(album, imageUrls) {
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

  imageUrls.forEach((url, i) => {
    parts.push({ type: 'text', text: `Image ${i}:` });
    parts.push({ type: 'image', source: { type: 'url', url } });
  });

  return parts;
}

// ── Call Anthropic API ─────────────────────────────────────────────────────
async function callClaude(model, systemPrompt, userContent, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
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
        max_tokens: 600,
        system: [
          // Cacheable system block — first call pays full, rest get 90% off
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');
    return { text: textBlock.text, usage: data.usage || {} };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parse JSON from model output (forgiving) ──────────────────────────────
function parseClassification(text) {
  let cleaned = text.trim();
  // Strip ```json or ``` fences if Claude includes them despite instructions
  cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  // Find first { ... last }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('No JSON object in response: ' + cleaned.slice(0, 100));
  const json = cleaned.slice(first, last + 1);
  return JSON.parse(json);
}

// ── Classify a single album with escalation ────────────────────────────────
async function classifyOne(album, taxonomy, apiKey) {
  const allImages = (album.image_urls || []).filter(Boolean);
  if (allImages.length === 0) {
    // No images = text-only Haiku call
    const sys = buildSystemPrompt(taxonomy);
    const userParts = buildAlbumMessage(album, []);
    const r = await callClaude(HAIKU, sys, userParts, apiKey);
    const result = parseClassification(r.text);
    return { ...result, key: album.key, model: HAIKU, escalated: false, _images_used: 0 };
  }

  // ── Pass 1: Haiku with up to 6 medium images ──
  const pass1Images = allImages.slice(0, 6).map(smMedium);
  const sys = buildSystemPrompt(taxonomy);
  const userParts1 = buildAlbumMessage(album, pass1Images);
  const r1 = await callClaude(HAIKU, sys, userParts1, apiKey);
  let result = parseClassification(r1.text);
  result.key = album.key;
  result.model = HAIKU;
  result.escalated = false;
  result._images_used = pass1Images.length;

  // ── Pass 2: escalate to Sonnet for low-confidence ──
  if (result.confidence != null && result.confidence < CONFIDENCE_THRESHOLD) {
    const diagIdx = Math.max(0, Math.min(5, result.most_diagnostic_image || 0));
    const diagImg = allImages[diagIdx];
    // Pick 2 unused images (not the diagnostic one)
    const unused = allImages.filter((_, i) => i !== diagIdx);
    const pass2Images = [diagImg, unused[6] || unused[0], unused[7] || unused[1]]
      .filter(Boolean)
      .slice(0, 3)
      .map(smLarge);

    const userParts2 = buildAlbumMessage(album, pass2Images);
    try {
      const r2 = await callClaude(SONNET, sys, userParts2, apiKey);
      const result2 = parseClassification(r2.text);
      result = { ...result2, key: album.key, model: SONNET, escalated: true,
                 haiku_path: result.path, haiku_confidence: result.confidence,
                 _images_used: pass1Images.length + pass2Images.length };
    } catch (e) {
      // If Sonnet fails, keep Haiku result and flag
      result.escalation_error = e.message;
    }
  }

  return result;
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
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const albums = Array.isArray(body && body.albums) ? body.albums : [];
    const taxonomy = Array.isArray(body && body.taxonomy) ? body.taxonomy : [];
    if (albums.length === 0) {
      return res.status(400).json({ ok: false, error: 'no albums in request' });
    }
    if (albums.length > 50) {
      return res.status(400).json({ ok: false, error: 'max 50 albums per request' });
    }

    const results = await pmap(albums, a => classifyOne(a, taxonomy, apiKey), PARALLEL);

    // Surface errors to the caller per-album, but don't fail the whole batch
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
