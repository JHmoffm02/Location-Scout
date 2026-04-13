// api/smugmug.js
const crypto = require('crypto');
const SM_API = 'https://api.smugmug.com/api/v2';

function pct(s) { return encodeURIComponent(s).replace(/!/g, '%21'); }

function buildAuthHeader(method, baseUrl, oauthParams, signatureParams, consumerSecret, tokenSecret) {
  const allForSig = { ...signatureParams, ...oauthParams };
  const sortedStr = Object.keys(allForSig).sort()
    .map(k => `${pct(k)}=${pct(allForSig[k])}`).join('&');
  const baseString = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(sortedStr)}`;
  const sigKey = `${pct(consumerSecret)}&${pct(tokenSecret || '')}`;
  const sig = crypto.createHmac('sha1', sigKey).update(baseString).digest('base64');
  const headerParts = { ...oauthParams, oauth_signature: sig };
  return 'OAuth ' + Object.keys(headerParts)
    .map(k => `${pct(k)}="${pct(headerParts[k])}"`).join(', ');
}

function makeOauthParams(consumerKey, accessToken) {
  const p = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (accessToken) p.oauth_token = accessToken;
  return p;
}

async function smRequest(path, accessToken, accessTokenSecret, extraParams = {}) {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;
  const baseUrl = (path.startsWith('http') ? path : `${SM_API}${path}`).split('?')[0];
  const oauthParams = makeOauthParams(consumerKey, accessToken);
  const authHeader = buildAuthHeader('GET', baseUrl, oauthParams, extraParams, consumerSecret, accessTokenSecret || '');
  const finalUrl = new URL(baseUrl);
  Object.entries(extraParams).forEach(([k, v]) => finalUrl.searchParams.set(k, v));
  const res = await fetch(finalUrl.toString(), {
    headers: { Authorization: authHeader, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`SmugMug API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getRequestToken(callbackUrl) {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;
  const url = 'https://api.smugmug.com/services/oauth/1.0a/getRequestToken';
  const oauthParams = makeOauthParams(consumerKey, null);
  oauthParams.oauth_callback = callbackUrl;
  const authHeader = buildAuthHeader('POST', url, oauthParams, {}, consumerSecret, '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `oauth_callback=${pct(callbackUrl)}`
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Request token failed: ${text}`);
  const params = new URLSearchParams(text);
  return { requestToken: params.get('oauth_token'), requestTokenSecret: params.get('oauth_token_secret') };
}

async function getAccessToken(requestToken, requestTokenSecret, verifier) {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;
  const url = 'https://api.smugmug.com/services/oauth/1.0a/getAccessToken';
  const oauthParams = makeOauthParams(consumerKey, requestToken);
  oauthParams.oauth_verifier = verifier;
  const authHeader = buildAuthHeader('POST', url, oauthParams, {}, consumerSecret, requestTokenSecret);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `oauth_verifier=${pct(verifier)}`
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Access token failed: ${text}`);
  const params = new URLSearchParams(text);
  return { accessToken: params.get('oauth_token'), accessTokenSecret: params.get('oauth_token_secret') };
}

function extractFolderPath(webUrl) {
  try {
    const url = new URL(webUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length <= 1) return { folderPath: '', albumSlug: parts[0] || '' };
    return {
      folderPath: parts.slice(0, -1).join('/'),
      albumSlug: parts[parts.length - 1]
    };
  } catch(e) { return { folderPath: '', albumSlug: '' }; }
}

function slugToName(slug) {
  return decodeURIComponent(slug).replace(/-/g, ' ');
}

// Get just the root node's immediate children — fast, no deep crawl
async function getNodeChildren(nodeUri, accessToken, accessTokenSecret) {
  const nodeRes = await smRequest(nodeUri, accessToken, accessTokenSecret);
  const node = nodeRes.Response?.Node;
  if (!node) return [];
  const childrenUri = node.Uris?.ChildNodes?.Uri;
  if (!childrenUri) return [];
  const childRes = await smRequest(childrenUri, accessToken, accessTokenSecret, { count: '200' });
  const children = childRes.Response?.Node || [];
  return Array.isArray(children) ? children : [children];
}

// Get albums from a single node (one folder) — stays well under timeout
async function getAlbumsFromNode(nodeUri, accessToken, accessTokenSecret, folderPath) {
  const children = await getNodeChildren(nodeUri, accessToken, accessTokenSecret);
  const albums = [];
  const subfolders = [];

  for (const child of children) {
    if (!child || !child.Uri) continue;
    if (child.Type === 'Album') {
      const albumUri = child.Uris?.Album?.Uri;
      if (!albumUri) continue;
      try {
        const albumRes = await smRequest(albumUri, accessToken, accessTokenSecret);
        const album = albumRes.Response?.Album;
        if (!album) continue;
        const { folderPath: urlFolder } = extractFolderPath(album.WebUri || '');
        albums.push({
          id: album.AlbumKey,
          name: album.Name,
          path: urlFolder || folderPath,
          url: album.WebUri,
          uri: albumUri,
          imageCount: album.ImageCount || 0,
          keywords: album.Keywords || '',
          description: album.Description || '',
          nodeUri: child.Uri
        });
      } catch(e) { console.error('album error:', e.message); }
    } else if (child.Type === 'Folder') {
      const childPath = folderPath ? `${folderPath}/${child.UrlName || child.Name}` : (child.UrlName || child.Name);
      subfolders.push({
        id: child.NodeID || childPath,
        name: child.Name,
        path: childPath,
        uri: child.Uri
      });
    }
  }
  return { albums, subfolders };
}

// Crawl only albums (no images) — just folder/album structure
async function crawlStructure(accessToken, accessTokenSecret) {
  const results = { folders: [], albums: [] };
  const folderSet = new Set();

  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  const nodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!nodeUri) throw new Error('Could not get user node URI');

  // BFS queue — process level by level
  const queue = [{ uri: nodeUri, path: '' }];
  let processed = 0;
  const maxNodes = 50; // Safety limit per request

  while (queue.length > 0 && processed < maxNodes) {
    const { uri, path } = queue.shift();
    processed++;

    try {
      const { albums, subfolders } = await getAlbumsFromNode(uri, accessToken, accessTokenSecret, path);

      // Add folders
      subfolders.forEach(sf => {
        if (!folderSet.has(sf.path)) {
          folderSet.add(sf.path);
          results.folders.push(sf);
          queue.push({ uri: sf.uri, path: sf.path });
        }
      });

      // Add albums — also derive folder structure from URL
      albums.forEach(a => {
        results.albums.push(a);
        // Also add any intermediate folders from the URL path
        if (a.path) {
          const parts = a.path.split('/');
          let cum = '';
          parts.forEach((part, i) => {
            cum = i === 0 ? part : `${cum}/${part}`;
            if (!folderSet.has(cum)) {
              folderSet.add(cum);
              results.folders.push({
                id: cum.replace(/\//g, '-'),
                name: slugToName(part),
                path: cum,
                uri: ''
              });
            }
          });
        }
      });
    } catch(e) {
      console.error('crawl node error:', e.message);
    }
  }

  return { ...results, hasMore: queue.length > 0 };
}

// Crawl images for a specific album only
async function crawlAlbumImages(albumUri, albumKey, albumName, albumPath, albumUrl, accessToken, accessTokenSecret) {
  const images = [];
  let start = 1;
  const perPage = 100;
  while (true) {
    let imagesRes;
    try {
      imagesRes = await smRequest(albumUri + '/images', accessToken, accessTokenSecret,
        { count: String(perPage), start: String(start) });
    } catch(e) {
      // Try alternate images URI format
      try {
        imagesRes = await smRequest(`/album/${albumKey}!images`, accessToken, accessTokenSecret,
          { count: String(perPage), start: String(start) });
      } catch(e2) { break; }
    }
    const imgs = imagesRes.Response?.AlbumImage || [];
    const imgArr = Array.isArray(imgs) ? imgs : [imgs];
    for (const img of imgArr) {
      if (!img || !img.ImageKey) continue;
      images.push({
        id: img.ImageKey, albumKey, albumName,
        albumPath, albumUrl,
        filename: img.FileName || '',
        title: img.Title || img.FileName || '',
        caption: img.Caption || '',
        keywords: img.Keywords || '',
        date: img.DateTimeOriginal || img.DateTimeUploaded || null,
        width: img.OriginalWidth || null,
        height: img.OriginalHeight || null,
        thumbUrl: img.ThumbnailUrl || null,
        webUri: img.WebUri || null,
        lat: img.Latitude || null,
        lng: img.Longitude || null,
        format: img.Format || null,
        size: img.ArchivedSize || null,
        isVideo: img.IsVideo || false,
      });
    }
    if (imgArr.length < perPage) break;
    start += perPage;
  }
  return images;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  try {
    if (action === 'auth') {
      const host = req.headers.host || '';
      const proto = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${proto}://${host}/api/smugmug?action=callback`;
      const { requestToken, requestTokenSecret } = await getRequestToken(callbackUrl);
      res.setHeader('Set-Cookie', `sm_rts=${requestTokenSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
      const authUrl = `https://api.smugmug.com/services/oauth/1.0a/authorize?oauth_token=${requestToken}&Access=Full&Permissions=Read`;
      res.json({ authUrl, requestToken });
      return;
    }

    if (action === 'callback') {
      const { oauth_token, oauth_verifier } = req.query;
      const cookieStr = req.headers.cookie || '';
      const rtsCookie = cookieStr.split(';').find(c => c.trim().startsWith('sm_rts='));
      const requestTokenSecret = rtsCookie ? rtsCookie.split('=')[1].trim() : '';
      if (!oauth_token || !oauth_verifier) { res.status(400).json({ error: 'Missing OAuth params' }); return; }
      const { accessToken, accessTokenSecret } = await getAccessToken(oauth_token, requestTokenSecret, oauth_verifier);
      const host = req.headers.host || '';
      const proto = host.includes('localhost') ? 'http' : 'https';
      const payload = pct(JSON.stringify({ accessToken, accessTokenSecret }));
      res.writeHead(302, { Location: `${proto}://${host}/#sm_auth=${payload}` });
      res.end();
      return;
    }

    let accessToken = '', accessTokenSecret = '';
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
        accessToken = tokens.accessToken;
        accessTokenSecret = tokens.accessTokenSecret;
      } catch(e) {}
    }

    if (action === 'test') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const data = await smRequest('/!authuser', accessToken, accessTokenSecret);
      res.json({ ok: true, user: data.Response?.User?.Name });
      return;
    }

    // Structure crawl — just folders and album metadata, no images
    if (action === 'structure') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const result = await crawlStructure(accessToken, accessTokenSecret);
      res.json({ ok: true, library: { ...result, images: [] } });
      return;
    }

    // Full crawl — kept for compatibility but now just does structure
    if (action === 'crawl') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const result = await crawlStructure(accessToken, accessTokenSecret);
      res.json({ ok: true, library: { ...result, images: [] } });
      return;
    }

    // Images crawl for a single album
    if (action === 'album-images') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const { albumUri, albumKey, albumName, albumPath, albumUrl } = req.query;
      if (!albumUri && !albumKey) { res.status(400).json({ error: 'albumUri or albumKey required' }); return; }
      const uri = albumUri || `/album/${albumKey}`;
      const images = await crawlAlbumImages(uri, albumKey, albumName, albumPath, albumUrl, accessToken, accessTokenSecret);
      res.json({ ok: true, images });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('SmugMug error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
