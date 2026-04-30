// api/ai_search.js — natural-language library search via Claude
//
// Request: POST { query: "creepy industrial space with windows", locations: [{id, name, tags, notes_excerpt, address}] }
// Response: { ok: true, matches: [{id, score, reason, top_image_keys}, ...] }
//
// The frontend is responsible for sending only the location summaries (compact —
// ~50 tokens each) so even 1000 locations fit comfortably in context.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const SYSTEM_PROMPT = `You are a location scout's research assistant. Given a search query and a list of location summaries (each with a name, tags, and brief notes), return the locations that best match — with the BEST matches first.

INTERPRETATION RULES:
- Treat the query loosely. "Gritty" matches locations tagged "weathered", "industrial", "raw", "abandoned-feel", "decrepit".
- "Fancy" matches "elegant", "ornate", "polished", "marble-floors", "chandeliers".
- "Sketchy" matches "weathered", "abandoned-feel", "creepy", "deteriorating".
- "Cozy" matches "homey", "warm", "intimate", "wood-paneling", "warm-lighting".
- Combine multiple concepts: "creepy school" should match locations tagged like a school AND with creepy/abandoned/dim-lighting traits.
- A location's name often contains key info (e.g. "Empty Storefront" matches "vacant retail" queries).
- Notes excerpts may mention specific features the tags missed.

SCORING:
- 100 = perfect match across all query terms
- 80-99 = strong match (most terms hit, possibly via synonyms)
- 60-79 = partial match (some terms hit clearly, others weakly)
- 40-59 = weak match (only one or two terms hit, or only via stretch)
- Below 40: don't include

OUTPUT — return ONLY this JSON, no prose, no markdown fences:
{
  "matches": [
    { "id": "<location-id>", "score": 92, "reason": "tagged industrial + pre-war, brick visible, name suggests warehouse" },
    ...
  ]
}

Return the top 30 matches. If fewer than 5 score above 40, return only those — don't pad with weak matches.`;

async function callHaiku(systemPrompt, userText, apiKey, maxTokens) {
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
        max_tokens: maxTokens || 2500,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userText }]
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const txt = (data.content || []).find(b => b.type === 'text');
    if (!txt) throw new Error('no text in response');
    return txt.text;
  } finally { clearTimeout(timer); }
}

function parseJSON(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const first = cleaned.indexOf('{');
  if (first < 0) throw new Error('No JSON found');
  cleaned = cleaned.slice(first);

  // Recovery for truncated arrays
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace > 0) {
    try { return JSON.parse(cleaned.slice(0, lastBrace + 1)); } catch (e) {}
  }
  // Best-effort repair: close open brackets/braces
  let inStr = false, esc = false, bd = 0, kd = 0, lastSafe = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') bd++;
    else if (c === '}') { bd--; if (bd === 0 && kd === 0) lastSafe = i + 1; }
    else if (c === '[') kd++;
    else if (c === ']') kd--;
  }
  if (lastSafe > 0) {
    try { return JSON.parse(cleaned.slice(0, lastSafe)); } catch (e) {}
  }
  // Auto-close
  let candidate = cleaned;
  for (let i = 0; i < kd; i++) candidate += ']';
  for (let i = 0; i < bd; i++) candidate += '}';
  candidate = candidate.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(candidate);
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
    const query = (body && body.query || '').toString().trim();
    const locations = Array.isArray(body && body.locations) ? body.locations : [];
    if (!query) return res.status(400).json({ ok: false, error: 'query required' });
    if (!locations.length) return res.status(400).json({ ok: false, error: 'locations required' });
    if (locations.length > 1500) return res.status(400).json({ ok: false, error: 'max 1500 locations per call' });

    // Build the user message with all location summaries
    const lines = locations.map(l => {
      const tags = (l.tags || []).slice(0, 18).join(', ');
      const notes = (l.notes_excerpt || '').slice(0, 200);
      const addr = [l.city, l.state].filter(Boolean).join(', ');
      const parts = [
        `id=${l.id}`,
        `name="${(l.name || '').slice(0, 100)}"`,
      ];
      if (addr) parts.push(`area="${addr}"`);
      if (tags) parts.push(`tags=[${tags}]`);
      if (notes) parts.push(`notes="${notes.replace(/[\r\n]+/g, ' ')}"`);
      return parts.join(' · ');
    }).join('\n');

    const userText = `QUERY: ${query}\n\nLOCATIONS (${locations.length}):\n${lines}\n\nReturn the best matches.`;
    const text = await callHaiku(SYSTEM_PROMPT, userText, apiKey, 3000);
    const parsed = parseJSON(text);
    const matches = (parsed.matches || []).filter(m =>
      m && m.id && typeof m.score === 'number' && m.score >= 40
    );
    return res.json({ ok: true, matches });
  } catch (e) {
    console.error('ai_search error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'search failed' });
  }
};
