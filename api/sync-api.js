// api/sync.js — CommonJS version for Vercel
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

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { library } = body || {};
    if (!library) { res.status(400).json({ error: 'No library data' }); return; }
    const { folders = [], albums = [], images = [] } = library;
    const stats = { folders: 0, albums: 0, images: 0, locations: 0 };

    // Upsert folders
    for (const f of folders) {
      try {
        await sb('smugmug_folders?on_conflict=sm_id', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify({ sm_id: f.id, name: f.name, path: f.path, web_url: f.url, sm_uri: f.uri, synced_at: new Date().toISOString() })
        });
        stats.folders++;
      } catch(e) { console.error('Folder upsert error:', e.message); }
    }

    // Upsert albums
    for (const a of albums) {
      try {
        await sb('smugmug_albums?on_conflict=sm_key', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify({ sm_key: a.id, name: a.name, path: a.path, web_url: a.url, sm_uri: a.uri, image_count: a.imageCount, keywords: a.keywords, description: a.description, synced_at: new Date().toISOString() })
        });
        stats.albums++;
      } catch(e) { console.error('Album upsert error:', e.message); }
    }

    // Upsert images in batches of 50
    for (let i = 0; i < images.length; i += 50) {
      const batch = images.slice(i, i + 50).map(img => ({
        sm_key: img.id, album_key: img.albumKey, album_name: img.albumName,
        album_path: img.albumPath, album_url: img.albumUrl,
        filename: img.filename, title: img.title, caption: img.caption,
        keywords: img.keywords, date_taken: img.date || null,
        width: img.width || null, height: img.height || null,
        thumb_url: img.thumbUrl, web_url: img.webUri,
        lat: img.lat || null, lng: img.lng || null,
        format: img.format, file_size: img.size || null,
        is_video: img.isVideo || false, synced_at: new Date().toISOString()
      }));
      try {
        await sb('smugmug_images?on_conflict=sm_key', {
          method: 'POST', prefer: 'resolution=merge-duplicates',
          body: JSON.stringify(batch)
        });
        stats.images += batch.length;
      } catch(e) { console.error('Image batch error:', e.message); }
    }

    // Auto-create location stubs for albums with geotagged photos
    const geoMap = {};
    images.filter(img => img.lat && img.lng).forEach(img => {
      if (!geoMap[img.albumKey]) geoMap[img.albumKey] = img;
    });
    for (const [albumKey, img] of Object.entries(geoMap)) {
      try {
        const existing = await sb(`locations?smugmug_album_key=eq.${albumKey}&select=id`);
        if (!existing || existing.length === 0) {
          await sb('locations', {
            method: 'POST',
            body: JSON.stringify({
              name: img.albumName, status: 'identified',
              lat: img.lat, lng: img.lng,
              tags: img.keywords ? img.keywords.split(' ').filter(Boolean) : [],
              notes: img.caption || null,
              smugmug_gallery_url: img.albumUrl,
              smugmug_album_key: albumKey,
              cover_photo_url: img.thumbUrl || null,
            })
          });
          stats.locations++;
        }
      } catch(e) { console.error('Location stub error:', e.message); }
    }

    // Update sync log
    try {
      await sb('sync_log?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({ id: 1, last_sync: new Date().toISOString(), folders_count: stats.folders, albums_count: stats.albums, images_count: stats.images })
      });
    } catch(e) {}

    res.json({ ok: true, stats });

  } catch(e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
