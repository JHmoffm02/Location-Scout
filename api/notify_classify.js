// api/notify_classify.js — receive new-upload notifications from the desktop ingest pipeline.
//
// POST /api/notify_classify
//   body: {
//     albums: [
//       { album_key: "abc123", album_name: "Joe's Diner", folder_name: "Joe's Diner",
//         meta: { photo_count: 47, notes_source: ".docx" } },
//       ...
//     ],
//     auto_classify: false   // (currently informational — option b not built yet)
//   }
//
// Response: { ok: true, queued: 3, skipped_existing: 1 }
//
// Idempotent: re-POSTing the same album_keys is a no-op (PRIMARY KEY upsert).
// The Organize tab reads from `pending_classify` to surface these albums.
//
// Auth: this endpoint accepts unauthenticated POSTs because the desktop ingest
// uses the Supabase anon key. If you later add auth, this needs to validate
// a token or service role.

'use strict';

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

// Limits to prevent abuse
const MAX_ALBUMS_PER_REQUEST = 200;
const MAX_FIELD_LENGTH = 500;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  // Also allow direct Python ingest (no Origin header at all)
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clean(value, maxLen) {
  if (value == null) return null;
  const s = String(value).slice(0, maxLen || MAX_FIELD_LENGTH).trim();
  return s || null;
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid JSON' });
  }

  const albums = Array.isArray(body.albums) ? body.albums : [];
  if (albums.length === 0) {
    return res.status(400).json({ ok: false, error: 'albums array required' });
  }
  if (albums.length > MAX_ALBUMS_PER_REQUEST) {
    return res.status(400).json({
      ok: false,
      error: `max ${MAX_ALBUMS_PER_REQUEST} albums per request`
    });
  }

  // Auto-classify flag is currently informational only.
  // Stored on each row so the future server-side worker (option b) can pick it up.
  const autoClassify = !!body.auto_classify;

  // Validate + sanitize each album entry
  const rows = [];
  const validationErrors = [];
  albums.forEach((a, i) => {
    if (!a || typeof a !== 'object') {
      validationErrors.push(`album[${i}]: not an object`);
      return;
    }
    const album_key = clean(a.album_key, 100);
    if (!album_key) {
      validationErrors.push(`album[${i}]: missing album_key`);
      return;
    }
    rows.push({
      album_key,
      album_name:    clean(a.album_name),
      folder_name:   clean(a.folder_name),
      upload_source: clean(a.upload_source) || 'ingest',
      auto_classify: autoClassify,
      meta:          (a.meta && typeof a.meta === 'object') ? a.meta : null,
      // queued_at uses DB default (NOW()) on insert; on conflict we preserve original
    });
  });

  if (validationErrors.length) {
    return res.status(400).json({
      ok: false,
      error: 'validation failed',
      details: validationErrors.slice(0, 10)
    });
  }

  // Find which album_keys already exist so we can report skipped count
  // (Cosmetic only — the upsert handles duplicates correctly either way.)
  let skipped = 0;
  try {
    const keys = rows.map(r => r.album_key);
    const list = keys.map(k => `"${encodeURIComponent(k)}"`).join(',');
    const checkRes = await fetch(
      `${supabaseUrl}/rest/v1/pending_classify?select=album_key&album_key=in.(${list})`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        }
      }
    );
    if (checkRes.ok) {
      const existing = await checkRes.json();
      skipped = Array.isArray(existing) ? existing.length : 0;
    }
  } catch (e) {
    // Non-fatal — the upsert below still works correctly
    console.warn('[notify_classify] dedup check failed:', e.message);
  }

  // Upsert. on_conflict=album_key with merge-duplicates means re-POSTing
  // an existing album_key is a no-op for the queued_at column (preserves
  // the original queue time). Other fields update with new values.
  try {
    const upsertRes = await fetch(
      `${supabaseUrl}/rest/v1/pending_classify?on_conflict=album_key`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows)
      }
    );
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('[notify_classify] upsert failed:', upsertRes.status, errText.slice(0, 300));
      return res.status(500).json({
        ok: false,
        error: `db upsert failed (${upsertRes.status})`,
        detail: errText.slice(0, 200)
      });
    }
  } catch (e) {
    console.error('[notify_classify] upsert threw:', e);
    return res.status(500).json({ ok: false, error: 'db error: ' + (e.message || 'unknown') });
  }

  return res.json({
    ok: true,
    queued: rows.length,
    skipped_existing: skipped,
    auto_classify: autoClassify,
  });
};
