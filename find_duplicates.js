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
        max_tokens: 1500,
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
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('No JSON in response');
  return JSON.parse(cleaned.slice(first, last + 1));
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
