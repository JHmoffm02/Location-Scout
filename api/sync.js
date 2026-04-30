// api/sync.js — DB sync from SmugMug crawl
//
// Major fixes vs v1:
// - Uses shared parser.js (no duplicate parser logic)
// - Respects notes_override (won't clobber user edits)
// - No state_code default (was always 'NY')
// - Keywords parsed properly (no destroying multi-word tags)
// - Removed dead deletion code path
// - Sets address_verified = false on auto-extracted addresses
// - Stores parser candidates for the verification UI

const Parser = require('../parser.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Supabase not configured' });

  const sb = async (path, opts = {}) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation', ...opts.headers
      }, ...opts
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };

  // Better keyword splitter — handles SmugMug's typical formats
  function parseKeywords(raw) {
    if (!raw || typeof raw !== 'string') return [];
    // SmugMug uses semicolons or commas as separators; words within a tag stay intact
    return raw.split(/[;,]/).map(t => t.trim()).filter(Boolean);
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { library, mode } = body || {};
    if (!library) return res.status(400).json({ error: 'No library data' });

    const { folders = [], albums = [], images = [] } = library;
    const stats = { folders: 0, albums: 0, images: 0, locations_created: 0, locations_updated: 0, deleted: 0 };

    // ── Folders upsert ────────────────────────────────────────────────────
    for (const f of folders) {
      try {
        await sb('smugmug_folders?on_conflict=path', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify({
            sm_id: f.id || f.path, name: f.name, path: f.path,
            web_url: f.url || null, sm_uri: f.uri || null,
            synced_at: new Date().toISOString()
          })
        });
        stats.folders++;
      } catch (e) { console.error('Folder error:', e.message); }
    }

    // ── Albums upsert + locations sync ────────────────────────────────────
    for (const a of albums) {
      try {
        // Build the album upsert. If a.unchanged is true, the crawl signaled this
        // album hasn't changed — skip overwriting fields that involve work
        // (highlight_url, description re-parse, location reconciliation).
        const albumPatch = {
          sm_key: a.id, name: a.name, path: a.path,
          web_url: a.url, sm_uri: a.uri,
          image_count: a.imageCount || 0,
          keywords: a.keywords || '',
          synced_at: new Date().toISOString()
        };
        if (a.lastUpdated) albumPatch.last_updated = a.lastUpdated;
        // Only overwrite description/highlight_url when the album actually changed
        if (!a.unchanged) {
          albumPatch.description = a.description || '';
          if (a.thumbUrl) albumPatch.highlight_url = a.thumbUrl;
        }
        await sb('smugmug_albums?on_conflict=sm_key', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify(albumPatch)
        });
        stats.albums++;

        // If the album hasn't changed, skip the location reconciliation entirely
        // (parser, candidates, tags, status — none of those derive from anything that changed).
        if (a.unchanged) {
          stats.unchanged = (stats.unchanged || 0) + 1;
          continue;
        }

        // Run shared parser on the album description
        const parsed = Parser.parse(a.description, { locName: a.name });
        const addr = (parsed && parsed.address) || null;
        const candidates = (parsed && parsed.addressCandidates) || [];
        const tags = parseKeywords(a.keywords);
        const sigDate = (parsed && parsed.date) || null;
        const sigName = (parsed && parsed.signature) || null;
        const status = (parsed && parsed.pending) ? 'pending' : 'identified';

        // Find existing location for this album
        const existing = await sb(`locations?smugmug_album_key=eq.${a.id}&select=id,address,city,state_code,notes,notes_override,address_verified,lat,lng,cover_photo_url,status`);

        if (existing && existing.length > 0) {
          const loc = existing[0];
          const updates = {
            smugmug_gallery_url: a.url,
            updated_at: new Date().toISOString(),
          };

          // Address fields: only update if NOT verified by user
          if (!loc.address_verified) {
            if (addr && addr.street) updates.address = addr.street;
            if (addr && addr.cross) updates.address_cross = addr.cross;
            if (addr && addr.city)  updates.city = addr.city;
            if (addr && addr.state) updates.state_code = addr.state;
            if (addr && addr.zip)   updates.zip = addr.zip;
            if (candidates.length)  updates.address_candidates = candidates;
            if (parsed && parsed.address) {
              updates.geocode_query = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
            } else if (a.name) {
              updates.geocode_query = a.name;
            }
          }

          // Notes: only update if NOT overridden by user, and only if description is non-empty
          if (!loc.notes_override && a.description && a.description.trim()) {
            updates.notes = a.description;
          }

          // Tags
          if (tags.length) updates.tags = tags;

          // Status: only update if "identified" (default) — preserve user-set scouted/approved
          if ((loc.status === 'identified' || !loc.status) && status === 'pending') {
            updates.status = 'pending';
          }

          // Scout signature
          if (sigDate && !loc.scout_date) updates.scout_date = sigDate;
          if (sigName && !loc.scout_name) updates.scout_name = sigName;

          await sb(`locations?id=eq.${loc.id}`, {
            method: 'PATCH', body: JSON.stringify(updates),
            headers: { Prefer: 'return=minimal' }
          });
          stats.locations_updated++;
        } else {
          // Create new location
          const newLoc = {
            name: a.name,
            status: status,
            address: addr ? (addr.street || null) : null,
            address_cross: addr ? (addr.cross || null) : null,
            city: addr ? (addr.city || null) : null,
            state_code: addr ? (addr.state || null) : null,
            zip: addr ? (addr.zip || null) : null,
            address_verified: false,
            address_candidates: candidates.length ? candidates : null,
            lat: null, lng: null,
            notes: a.description || null,
            notes_override: false,
            tags: tags,
            smugmug_gallery_url: a.url,
            smugmug_album_key: a.id,
            scout_date: sigDate,
            scout_name: sigName,
            geocode_query: addr
              ? [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')
              : a.name
          };
          await sb('locations', {
            method: 'POST',
            body: JSON.stringify(newLoc),
            headers: { Prefer: 'return=minimal' }
          });
          stats.locations_created++;
        }
      } catch (e) { console.error('Album sync error for', a.name, ':', e.message); }
    }

    // ── Images batch upsert ───────────────────────────────────────────────
    for (let i = 0; i < images.length; i += 50) {
      const batch = images.slice(i, i + 50).map(img => ({
        sm_key: img.id, album_key: img.albumKey,
        album_name: img.albumName, album_path: img.albumPath,
        album_url: img.albumUrl, filename: img.filename,
        title: img.title, caption: img.caption,
        keywords: img.keywords, date_taken: img.date || null,
        width: img.width || null, height: img.height || null,
        thumb_url: img.thumbUrl, web_url: img.webUri,
        lat: img.lat || null, lng: img.lng || null,
        format: img.format, file_size: img.size || null,
        is_video: img.isVideo || false,
        synced_at: new Date().toISOString()
      }));
      try {
        await sb('smugmug_images?on_conflict=sm_key', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify(batch)
        });
        stats.images += batch.length;
      } catch (e) { console.error('Image batch error:', e.message); }
    }

    // ── Set cover photos for new locations from first image ───────────────
    if (images.length > 0) {
      const firstByAlbum = {};
      images.forEach(img => {
        if (img.thumbUrl && !firstByAlbum[img.albumKey]) firstByAlbum[img.albumKey] = img.thumbUrl;
      });
      for (const [albumKey, thumbUrl] of Object.entries(firstByAlbum)) {
        try {
          const locs = await sb(`locations?smugmug_album_key=eq.${albumKey}&select=id,cover_photo_url`);
          if (locs && locs[0] && !locs[0].cover_photo_url) {
            await sb(`locations?id=eq.${locs[0].id}`, {
              method: 'PATCH', body: JSON.stringify({ cover_photo_url: thumbUrl }),
              headers: { Prefer: 'return=minimal' }
            });
          }
        } catch (e) {}
      }
    }

    // ── Deletion (only when called in 'full' mode with complete album list) ──
    // The frontend now signals this explicitly to prevent partial-list deletions.
    if (mode === 'full' && albums.length > 0) {
      try {
        const syncedKeys = new Set(albums.map(a => a.id).filter(Boolean));
        const allInDb = await sb('smugmug_albums?select=sm_key,name');
        const toDelete = (allInDb || []).filter(a => !syncedKeys.has(a.sm_key));
        for (const s of toDelete) {
          await sb('smugmug_albums?sm_key=eq.' + s.sm_key, {
            method: 'DELETE', headers: { Prefer: 'return=minimal' }
          });
          // Only delete linked locations if they were never edited
          await sb('locations?smugmug_album_key=eq.' + s.sm_key + '&address_verified=eq.false&notes_override=eq.false&address.is.null',
            { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        }
        stats.deleted = toDelete.length;
      } catch (e) { console.error('deletion error:', e.message); }
    }

    // ── Sync log ──────────────────────────────────────────────────────────
    try {
      await sb('sync_log?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({
          id: 1, last_sync: new Date().toISOString(),
          folders_count: stats.folders,
          albums_count: stats.albums,
          images_count: stats.images
        })
      });
    } catch (e) {}

    return res.json({ ok: true, stats });
  } catch (e) {
    console.error('Sync error:', e.message);
    return res.status(500).json({ error: 'sync failed' });
  }
};
