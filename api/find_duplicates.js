// api/find_duplicates.js — find logically duplicate folders ("junk-yard" + "scrapyard" etc.)
//
// Request: POST { folders: [{path, name, album_count, sample_albums}] }
// Returns: { ok: true, clusters: [{paths: [...], canonical_suggestion, reason}] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const SYSTEM_PROMPT = `You analyze folder names from a film/TV scout's photo library and group ones that likely represent the SAME logical category.

Examples of folders that should be grouped:
- "junk-yard" + "scrapyard" + "junkyard" → all auto/metal scrap places
- "houses" + "homes" + "single-family-homes"
- "diners" + "diner" + "casual-restaurants"
- "warehouse" + "warehouses" + "storage"
- "church" + "churches" + "religious"

DO NOT group folders that are merely related but distinct:
- "bars" and "lounges" are different categories — keep separate
- "houses" and "mansions" are different scales — keep separate
- "manhattan" and "brooklyn" are different boroughs — keep separate

For each cluster you propose, suggest a canonical name (the cleanest, most descriptive — preferably one that's already in the list).

Return ONLY a JSON object, no prose:
{
  "clusters": [
    {
      "paths": ["junk-yard", "scrapyard"],
      "canonical": "junk-yard",
      "reason": "synonyms — both refer to scrap/auto yards"
    }
  ]
}

If nothing in the list looks duplicate, return { "clusters": [] }.`;

async function callHaiku(systemPrompt, userText, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userText }]
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
    return textBlock.text;
  } finally { clearTimeout(timer); }
}

function parseJSON(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const first = cleaned.indexOf('{');
  if (first < 0) throw new Error('No JSON in response: ' + cleaned.slice(0, 120));
  cleaned = cleaned.slice(first);

  // Try direct parse if response ends in '}'
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace > 0) {
    try { return JSON.parse(cleaned.slice(0, lastBrace + 1)); } catch (e) { /* fall through */ }
  }

  // Recovery: scan for last fully-balanced top-level object
  let inString = false, escape = false, braceDepth = 0, bracketDepth = 0;
  let lastSafeEnd = -1, lastTokenEnd = -1, currentStringStart = -1;
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
      braceDepth--; lastTokenEnd = i + 1;
      if (braceDepth === 0 && bracketDepth === 0) lastSafeEnd = i + 1;
    }
    else if (c === '[') bracketDepth++;
    else if (c === ']') { bracketDepth--; lastTokenEnd = i + 1; }
    else if (/[\d\.\-]/.test(c) || /[truefalsn]/i.test(c)) lastTokenEnd = i + 1;
  }
  if (lastSafeEnd > 0) {
    try { return JSON.parse(cleaned.slice(0, lastSafeEnd)); } catch (e) {}
  }

  let cut;
  if (inString && currentStringStart >= 0) {
    cut = currentStringStart;
    while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
    if (cut > 0 && cleaned[cut - 1] === ':') {
      cut--;
      while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
      if (cut > 0 && cleaned[cut - 1] === '"') {
        cut--;
        while (cut > 0 && cleaned[cut - 1] !== '"') cut--;
        if (cut > 0) cut--;
      }
    }
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  } else {
    cut = lastTokenEnd > 0 ? lastTokenEnd : cleaned.length;
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  }
  let bd = 0, kd = 0, str = false, esc = false;
  for (let i = 0; i < cut; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (str) { if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') bd++;
    else if (c === '}') bd--;
    else if (c === '[') kd++;
    else if (c === ']') kd--;
  }
  let candidate = cleaned.slice(0, cut);
  for (let i = 0; i < kd; i++) candidate += ']';
  for (let i = 0; i < bd; i++) candidate += '}';
  candidate = candidate.replace(/,(\s*[\]}])/g, '$1');
  try { return JSON.parse(candidate); } catch (e) {
    throw new Error('JSON parse failed: ' + e.message + ' | head: ' + cleaned.slice(0, 80));
  }
}

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
    const folders = Array.isArray(body && body.folders) ? body.folders : [];
    if (!folders.length) return res.status(400).json({ ok: false, error: 'no folders provided' });
    if (folders.length > 200) return res.status(400).json({ ok: false, error: 'max 200 folders per call' });

    // Build a compact list for Claude
    const lines = folders.map(f => {
      const albums = (f.sample_albums || []).slice(0, 3).join('; ');
      return `${f.path}  (${f.album_count || 0} albums${albums ? ': ' + albums : ''})`;
    }).join('\n');
    const userText = `Folder list:\n${lines}\n\nGroup any that likely represent the same category.`;

    const text = await callHaiku(SYSTEM_PROMPT, userText, apiKey);
    const parsed = parseJSON(text);
    const clusters = (parsed.clusters || []).filter(c =>
      Array.isArray(c.paths) && c.paths.length >= 2
    );
    return res.json({ ok: true, clusters });
  } catch (e) {
    console.error('find_duplicates error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
};
