// api/sync.js
// Vercel serverless function — syncs SmugMug library data into Supabase
// Called from the browser after a successful crawl

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'Supabase not configured' }); return;
  }

  const sbApi = async (path, opts = {}) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation',
        ...opts.headers
      },
      ...opts
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Supabase error ${r.status}: ${t}`);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };

  try {
    const { library } = req.body;
    if (!library) { res.status(400).json({ error: 'No library data' }); return; }

    const { folders = [], albums = [], images = [] } = library;
    const stats = { folders: 0, albums: 0, images: 0, locations: 0 };

    // ---- UPSERT SMUGMUG FOLDERS ----
    for (const folder of folders) {
      await sbApi('smugmug_folders?on_conflict=sm_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({
          sm_id: folder.id,
          name: folder.name,
          path: folder.path,
          web_url: folder.url,
          sm_uri: folder.uri,
          synced_at: new Date().toISOString()
        })
      });
      stats.folders++;
    }

    // ---- UPSERT SMUGMUG ALBUMS ----
    for (const album of albums) {
      await sbApi('smugmug_albums?on_conflict=sm_key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({
          sm_key: album.id,
          name: album.name,
          path: album.path,
          web_url: album.url,
          sm_uri: album.uri,
          image_count: album.imageCount,
          keywords: album.keywords,
          description: album.description,
          synced_at: new Date().toISOString()
        })
      });
      stats.albums++;
    }

    // ---- UPSERT SMUGMUG IMAGES ----
    // Process in batches of 50
    const batchSize = 50;
    for (let i = 0; i < images.length; i += batchSize) {
      const batch = images.slice(i, i + batchSize).map(img => ({
        sm_key: img.id,
        album_key: img.albumKey,
        album_name: img.albumName,
        album_path: img.albumPath,
        album_url: img.albumUrl,
        filename: img.filename,
        title: img.title,
        caption: img.caption,
        keywords: img.keywords,
        date_taken: img.date || null,
        width: img.width || null,
        height: img.height || null,
        thumb_url: img.thumbUrl,
        web_url: img.webUri,
        lat: img.lat || null,
        lng: img.lng || null,
        format: img.format,
        file_size: img.size || null,
        is_video: img.isVideo || false,
        synced_at: new Date().toISOString()
      }));

      await sbApi('smugmug_images?on_conflict=sm_key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify(batch)
      });
      stats.images += batch.length;
    }

    // ---- AUTO-CREATE LOCATIONS from albums with geo data ----
    // For albums that have a consistent path structure, try to create location stubs
    const albumsWithGeo = images.filter(img => img.lat && img.lng);
    const albumGeoMap = {};
    albumsWithGeo.forEach(img => {
      if (!albumGeoMap[img.albumKey]) {
        albumGeoMap[img.albumKey] = { lat: img.lat, lng: img.lng, album: img };
      }
    });

    for (const [albumKey, geo] of Object.entries(albumGeoMap)) {
      // Check if location already exists for this album
      const existing = await sbApi(`locations?smugmug_album_key=eq.${albumKey}&select=id`);
      if (!existing || existing.length === 0) {
        const img = geo.album;
        await sbApi('locations', {
          method: 'POST',
          body: JSON.stringify({
            name: img.albumName,
            status: 'identified',
            lat: geo.lat,
            lng: geo.lng,
            tags: img.keywords ? img.keywords.split(' ').filter(Boolean) : [],
            notes: img.caption || null,
            smugmug_gallery_url: img.albumUrl,
            smugmug_album_key: albumKey,
            cover_photo_url: img.thumbUrl,
          })
        });
        stats.locations++;
      }
    }

    // ---- UPDATE LAST SYNC TIME ----
    await sbApi('sync_log?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: JSON.stringify({
        id: 1,
        last_sync: new Date().toISOString(),
        folders_count: stats.folders,
        albums_count: stats.albums,
        images_count: stats.images
      })
    });

    res.json({ ok: true, stats });

  } catch(e) {
    console.error('Sync error:', e);
    res.status(500).json({ error: e.message });
  }
}
