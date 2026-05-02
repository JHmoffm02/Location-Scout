// api/find_duplicates.js — find logically duplicate folders ("junk-yard" + "scrapyard" etc.)
//
// Request: POST { folders: [{path, name, album_count, sample_albums}] }
// Returns: { ok: true, clusters: [{paths: [...], canonical_suggestion, reason}] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5';
const { parseJSON } = require('./_lib/parseClaude');

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

const SYSTEM_PROMPT = `You analyze folder names from a film/TV scout's photo library and propose ways to consolidate them.

You may propose TWO kinds of consolidation in your output — both go in the "clusters" array:

═══════════════════════════════════════════════════════════════════════
TYPE 1: MERGE (kind: "merge") — fold these into ONE canonical folder
═══════════════════════════════════════════════════════════════════════
Use this when folders genuinely represent the SAME location type. Be GENEROUS here:

  • Synonyms / spelling variants:
    - "junk-yard" + "scrapyard" + "junkyard" + "auto-salvage"
    - "warehouse" + "warehouses" + "storage"
    - "church" + "churches"

  • Conceptual equivalents (same thing, different word):
    - "waterfront" + "waterside" + "by-the-water"  → all water-adjacent locations
    - "garage" + "mechanic-shop" + "auto-repair" → all auto service places
    - "art-studio" + "arts" + "artist-studio" + "atelier"
    - "diner" + "diners" + "casual-restaurant"
    - "house" + "houses" + "single-family-home"

  • Plural/punctuation drift:
    - "bar" + "bars" + "Bar"

═══════════════════════════════════════════════════════════════════════
TYPE 2: GROUP UNDER PARENT (kind: "group") — make several folders into siblings under a new parent
═══════════════════════════════════════════════════════════════════════
Use this when folders are DIFFERENT types but SHARE A BROADER CATEGORY. Examples:

  • Industrial broadly:
    - "junkyard" + "warehouse" + "garage" + "factory" + "loading-dock"  → propose parent "industrial"
    - The merged result would be "industrial/junkyard", "industrial/warehouse", etc.

  • Food broadly:
    - "diner" + "fine-dining" + "cafe" + "deli"  → propose parent "restaurants"

  • Civic broadly:
    - "courthouse" + "library" + "post-office" + "city-hall"  → propose parent "civic"

  • Outdoors broadly:
    - "park" + "beach" + "waterfront" + "forest"  → propose parent "outdoor"

For "group" clusters, set "parent" to the proposed parent path. The child folders won't be renamed — they'll just be moved INTO the parent. So "junkyard" stays "junkyard", but its full path becomes "industrial/junkyard".

═══════════════════════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════════════════════
• ONLY group folders at the SAME DEPTH (same number of "/" separators).
• "bars" + "bars/brooklyn" — different depths — NEVER group.
• Sibling areas under a category ("bars/manhattan" + "bars/queens") are NOT duplicates — leave them alone.
• When in doubt, propose it — the user reviews each cluster and rejects bad ones.
• Aim for 5-15 cluster proposals if the library has obvious consolidation opportunities. Be generous.

═══════════════════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON, no prose, no markdown fences
═══════════════════════════════════════════════════════════════════════
{
  "clusters": [
    {
      "kind": "merge",
      "paths": ["junk-yard", "scrapyard", "auto-salvage"],
      "canonical": "junkyard",
      "reason": "all refer to scrap/auto yards"
    },
    {
      "kind": "group",
      "paths": ["junkyard", "warehouse", "garage", "factory"],
      "parent": "industrial",
      "reason": "all industrial / heavy-equipment spaces"
    }
  ]
}

If nothing in the list looks consolidable, return { "clusters": [] }.`;

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
    if (folders.length > 800) return res.status(400).json({ ok: false, error: 'max 800 folders per call' });

    // Run multi-pass when the list is large — each pass sees a subset, then merge results
    // and de-dupe overlapping clusters.
    const CHUNK_SIZE = 200;
    const allClusters = [];

    for (let i = 0; i < folders.length; i += CHUNK_SIZE) {
      const chunk = folders.slice(i, i + CHUNK_SIZE);
      const lines = chunk.map(f => {
        const albums = (f.sample_albums || []).slice(0, 3).join('; ');
        return `${f.path}  (${f.album_count || 0} albums${albums ? ': ' + albums : ''})`;
      }).join('\n');
      const userText = `Folder list:\n${lines}\n\nGroup any that likely represent the same category, AND propose grouping any that share a broader theme.`;

      const text = await callHaiku(SYSTEM_PROMPT, userText, apiKey);
      const parsed = parseJSON(text);
      const rawClusters = (parsed.clusters || []).filter(c =>
        Array.isArray(c.paths) && c.paths.length >= 2
      );

      // Per-cluster sanity:
      //   - same depth among paths
      //   - no parent/child relationship
      //   - "group" type also needs a parent
      const valid = rawClusters.filter(c => {
        const depths = c.paths.map(p => String(p).split('/').filter(Boolean).length);
        if (!depths.every(d => d === depths[0])) return false;
        for (let a = 0; a < c.paths.length; a++) {
          for (let b = 0; b < c.paths.length; b++) {
            if (a === b) continue;
            const x = String(c.paths[a]), y = String(c.paths[b]);
            if (y.startsWith(x + '/') || x.startsWith(y + '/')) return false;
          }
        }
        // Default kind = "merge" if missing
        if (!c.kind) c.kind = 'merge';
        if (c.kind === 'group' && !c.parent) return false;
        return true;
      });
      allClusters.push(...valid);
    }

    // Dedupe: drop clusters whose path-set is a subset of another
    // (when two chunks both saw "junkyard" + "scrapyard", we'd get duplicates)
    const seen = new Set();
    const unique = [];
    allClusters.forEach(c => {
      const key = c.kind + ':' + [...c.paths].sort().join(',');
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(c);
    });

    return res.json({ ok: true, clusters: unique });
  } catch (e) {
    console.error('find_duplicates error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
};
