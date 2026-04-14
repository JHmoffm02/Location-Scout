// api/sync.js — CommonJS
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) { res.status(500).json({ error: 'Supabase not configured' }); return; }

  const sb = async (path, opts = {}) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation', ...opts.headers
      }, ...opts
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };

  // ---- DESCRIPTION PARSER ----
  function parseDescription(desc, albumName) {
    if (!desc || !desc.trim()) return {};
    const result = {};

    // Normalize line endings and trim
    const raw = desc.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // Extract status from *word* pattern
    const statusMatch = raw.match(/\*(pending|approved|scouted|identified|rejected|limited|available|hold)\*/i);
    if (statusMatch) {
      const s = statusMatch[1].toLowerCase();
      if (['pending', 'approved', 'scouted', 'identified', 'rejected'].includes(s)) {
        result.status = s;
      }
    }

    // Split on newlines or find the address block
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    // Find notes section
    const notesIdx = lines.findIndex(l => /^notes?\s*:/i.test(l));

    // Address is typically on line 1 or 2 — after the name/status line
    // Look for a line that contains a street number or zip code pattern
    const addressPattern = /\d+[\w\s\-\.]+(?:st|ave|blvd|rd|dr|ln|pl|way|ct|terr?|pkwy|hwy|broadway|street|avenue|road|drive|lane|place|court|blvd)\b/i;
    const zipPattern = /\b\d{5}\b/;
    const cityStatePattern = /\b([A-Z]{2})\s+\d{5}\b/;

    let addressLines = [];
    const endIdx = notesIdx >= 0 ? notesIdx : lines.length;

    for (let i = 0; i < endIdx; i++) {
      const line = lines[i];
      // Skip the name/status line (first line)
      if (i === 0) continue;
      // If line has address characteristics, include it
      if (addressPattern.test(line) || zipPattern.test(line)) {
        addressLines.push(line);
      }
    }

    // If no structured address found, try line 1 (second line after name)
    if (!addressLines.length && lines.length > 1) {
      const candidate = lines[1];
      // Only use if it doesn't look like just a status/name line
      if (!candidate.match(/^\*/)) {
        addressLines.push(candidate);
      }
    }

    if (addressLines.length) {
      const fullAddr = addressLines.join(' ');

      // Extract state code
      const stateMatch = fullAddr.match(/\b(NY|NJ|CT|PA|MA|CA|FL|TX)\b/);
      if (stateMatch) result.state_code = stateMatch[1];

      // Extract city — word(s) before state
      const cityMatch = fullAddr.match(/([A-Za-z\s]+),?\s+(?:NY|NJ|CT|PA|MA)\b/);
      if (cityMatch) result.city = cityMatch[1].trim().replace(/,$/, '');

      // Store clean address — strip the city/state/zip part for address field
      const addrClean = fullAddr
        .replace(/\(.*?\)/g, '') // remove parentheticals
        .replace(/\s+/g, ' ')
        .trim();
      result.address = addrClean;
    }

    // Extract notes content
    if (notesIdx >= 0) {
      const noteLines = lines.slice(notesIdx);
      const notesRaw = noteLines.join('\n')
        .replace(/^notes?\s*:/i, '')
        .trim();

      // Clean up bullet dashes and extra spaces
      result.notes = notesRaw
        .replace(/^-\s*/gm, '• ')
        .replace(/\.\s*-\s*/g, '.\n• ')
        .trim();

      // Try to extract scout date (MM-DD-YY or MM/DD/YY at end)
      const dateMatch = result.notes.match(/([A-Z]\.\s*\w+|J\.\s*Hoffman)\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\.?\s*$/i);
      if (dateMatch) {
        result.scout_date = dateMatch[2];
        result.scout_name = dateMatch[1].trim();
      }
    }

    // Build geocode address — prefer parsed address + city/state, fallback to album name
    if (result.address) {
      result.geocode_query = [result.address, result.city, result.state_code].filter(Boolean).join(', ');
    } else {
      result.geocode_query = albumName;
    }

    return result;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { library } = body || {};
    if (!library) { res.status(400).json({ error: 'No library data' }); return; }

    const { folders = [], albums = [], images = [] } = library;
    const stats = { folders: 0, albums: 0, images: 0, locations: 0, updated: 0 };

    // Upsert folders
    for (const f of folders) {
      try {
        await sb('smugmug_folders?on_conflict=sm_id', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify({
            sm_id: f.id, name: f.name, path: f.path,
            web_url: f.url, sm_uri: f.uri, synced_at: new Date().toISOString()
          })
        });
        stats.folders++;
      } catch(e) { console.error('Folder error:', e.message); }
    }

    // Upsert albums — parse description for each
    for (const a of albums) {
      try {
        await sb('smugmug_albums?on_conflict=sm_key', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify({
            sm_key: a.id, name: a.name, path: a.path,
            web_url: a.url, sm_uri: a.uri,
            image_count: a.imageCount,
            keywords: a.keywords,
            description: a.description,
            highlight_url: a.thumbUrl || null,
            highlight_url: a.thumbUrl || null,
            synced_at: new Date().toISOString()
          })
        });
        stats.albums++;

        // Parse description and update/create location
        const parsed = parseDescription(a.description, a.name);

        // Check if location exists for this album
        const existing = await sb(`locations?smugmug_album_key=eq.${a.id}&select=id,lat,lng`);

        if (existing && existing.length > 0) {
          // Update existing — only fill in missing fields
          const loc = existing[0];
          const updates = {
            smugmug_gallery_url: a.url,
            updated_at: new Date().toISOString(),
          };
          if (parsed.status) updates.status = parsed.status;
          if (parsed.address) updates.address = parsed.address;
          if (parsed.city) updates.city = parsed.city;
          if (parsed.state_code) updates.state_code = parsed.state_code;
          if (parsed.notes) updates.notes = parsed.notes;
          if (parsed.geocode_query) updates.geocode_query = parsed.geocode_query;
          // Only update coords if currently 0/null
          if ((!loc.lat || loc.lat === 0) && a.lat) updates.lat = a.lat;
          if ((!loc.lng || loc.lng === 0) && a.lng) updates.lng = a.lng;

          await sb(`locations?id=eq.${loc.id}`, {
            method: 'PATCH', body: JSON.stringify(updates),
            headers: { Prefer: 'return=minimal' }
          });
          stats.updated++;
        } else {
          // Create new location from album
          await sb('locations', {
            method: 'POST',
            body: JSON.stringify({
              name: a.name,
              status: parsed.status || 'identified',
              address: parsed.address || null,
              city: parsed.city || null,
              state_code: parsed.state_code || 'NY',
              lat: a.lat || null,
              lng: a.lng || null,
              notes: parsed.notes || null,
              tags: a.keywords ? a.keywords.split(/[\s,]+/).filter(Boolean) : [],
              smugmug_gallery_url: a.url,
              smugmug_album_key: a.id,
              geocode_query: parsed.geocode_query || a.name,
            })
          });
          stats.locations++;
        }
      } catch(e) { console.error('Album error:', e.message); }
    }

    // Upsert images in batches of 50
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
      } catch(e) { console.error('Image batch error:', e.message); }
    }

    // Set cover photos for locations from first image in album
    if (images.length > 0) {
      const albumFirstImage = {};
      images.forEach(img => {
        if (img.thumbUrl && !albumFirstImage[img.albumKey]) {
          albumFirstImage[img.albumKey] = img.thumbUrl;
        }
      });
      for (const [albumKey, thumbUrl] of Object.entries(albumFirstImage)) {
        try {
          const locs = await sb(`locations?smugmug_album_key=eq.${albumKey}&select=id,cover_photo_url`);
          if (locs && locs[0] && !locs[0].cover_photo_url) {
            await sb(`locations?id=eq.${locs[0].id}`, {
              method: 'PATCH', body: JSON.stringify({ cover_photo_url: thumbUrl }),
              headers: { Prefer: 'return=minimal' }
            });
          }
        } catch(e) {}
      }
    }

    // Update sync log
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
    } catch(e) {}

    // Add geocode_query column if needed
    res.json({ ok: true, stats });

  } catch(e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
