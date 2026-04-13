// api/smugmug.js
const crypto = require('crypto');
const SM_API = 'https://api.smugmug.com/api/v2';
const SM_USER = 'jordanhoffman';

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

// Fetch children of a SmugMug folder by URL path
// Uses the user node tree — walk path segments to find the right node
async function fetchFolderByPath(urlPath, accessToken, accessTokenSecret) {
  // Get user node first
  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  const rootNodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!rootNodeUri) throw new Error('Could not get root node');

  // Split path into segments e.g. ['Master-Library', 'Apartments']
  const segments = urlPath.split('/').filter(Boolean);

  // Walk the node tree segment by segment
  let currentNodeUri = rootNodeUri;
  for (const segment of segments) {
    const nodeRes = await smRequest(currentNodeUri, accessToken, accessTokenSecret);
    const node = nodeRes.Response?.Node;
    if (!node) throw new Error(`Node not found at segment: ${segment}`);

    const childrenUri = node.Uris?.ChildNodes?.Uri;
    if (!childrenUri) throw new Error(`No children at: ${segment}`);

    // Fetch children and find matching segment
    const childRes = await smRequest(childrenUri, accessToken, accessTokenSecret, { count: '200' });
    const children = childRes.Response?.Node || [];
    const childArr = Array.isArray(children) ? children : [children];

    const match = childArr.find(c =>
      c && (
        (c.UrlName || '').toLowerCase() === segment.toLowerCase() ||
        (c.Name || '').toLowerCase() === segment.toLowerCase().replace(/-/g, ' ')
      )
    );

    if (!match) throw new Error(`Folder not found: ${segment} (checked ${childArr.length} children)`);
    currentNodeUri = match.Uri;
  }

  // Now get children of the target node
  const targetRes = await smRequest(currentNodeUri, accessToken, accessTokenSecret);
  const targetNode = targetRes.Response?.Node;
  const childrenUri = targetNode?.Uris?.ChildNodes?.Uri;
  if (!childrenUri) return { folders: [], albums: [] };

  const childData = await smRequest(childrenUri, accessToken, accessTokenSecret, { count: '200' });
  const children = childData.Response?.Node || [];
  const arr = Array.isArray(children) ? children : [children];

  const folders = [];
  const albums = [];

  for (const item of arr) {
    if (!item) continue;
    if (item.Type === 'Album') {
      const albumUri = item.Uris?.Album?.Uri;
      let albumKey = null;
      let imageCount = 0;
      let description = '';
      let keywords = '';
      let thumbUrl = null;

      if (albumUri) {
        try {
          const albumData = await smRequest(albumUri, accessToken, accessTokenSecret);
          const album = albumData.Response?.Album;
          if (album) {
            albumKey = album.AlbumKey;
            imageCount = album.ImageCount || 0;
            description = album.Description || '';
            keywords = album.Keywords || '';
            const hlUri = album.Uris?.HighlightImage?.Uri;
            if (hlUri) {
              try {
                const hlData = await smRequest(hlUri, accessToken, accessTokenSecret);
                thumbUrl = hlData.Response?.Image?.ThumbnailUrl || null;
              } catch(e) {}
            }
          }
        } catch(e) { console.error('album error:', e.message); }
      }

      albums.push({
        id: albumKey || item.NodeID,
        name: item.Name,
        urlName: item.UrlName,
        url: item.WebUri,
        imageCount,
        description,
        keywords,
        thumbUrl,
      });
    } else if (item.Type === 'Folder' || item.Type === 'Page') {
      folders.push({
        name: item.Name,
        urlName: item.UrlName,
        path: `${urlPath}/${item.UrlName}`,
        url: item.WebUri,
      });
    }
  }

  return { folders, albums };
}

// Sync albums from a specific path into Supabase
async function syncAlbumsFromPath(urlPath, accessToken, accessTokenSecret) {
  const { folders, albums } = await fetchFolderByPath(urlPath, accessToken, accessTokenSecret);
  const images = [];

  for (const album of albums) {
    if (!album.id) continue;
    // Get full album details for description
    try {
      const albumData = await smRequest(`/album/${album.id}`, accessToken, accessTokenSecret);
      const full = albumData.Response?.Album;
      if (full) {
        album.description = full.Description || '';
        album.keywords = full.Keywords || '';
        album.imageCount = full.ImageCount || 0;

        // Get cover/highlight image
        const hlUri = full.Uris?.HighlightImage?.Uri;
        if (hlUri) {
          try {
            const hlData = await smRequest(hlUri, accessToken, accessTokenSecret);
            const hlImage = hlData.Response?.Image;
            if (hlImage) album.thumbUrl = hlImage.ThumbnailUrl || hlImage.SmallImageUrl;
          } catch(e) {}
        }

        // Get first page of images for thumbnails
        const imagesUri = full.Uris?.AlbumImages?.Uri;
        if (imagesUri) {
          try {
            const imgData = await smRequest(imagesUri, accessToken, accessTokenSecret, { count: '10' });
            const imgs = imgData.Response?.AlbumImage || [];
            const imgArr = Array.isArray(imgs) ? imgs : [imgs];
            imgArr.forEach(img => {
              if (!img || !img.ImageKey) return;
              images.push({
                id: img.ImageKey,
                albumKey: album.id,
                albumName: album.name,
                albumPath: urlPath,
                albumUrl: album.url,
                filename: img.FileName || '',
                title: img.Title || img.FileName || '',
                caption: img.Caption || '',
                keywords: img.Keywords || '',
                thumbUrl: img.ThumbnailUrl || null,
                webUri: img.WebUri || null,
                lat: img.Latitude || null,
                lng: img.Longitude || null,
                isVideo: img.IsVideo || false,
              });
              // Use first image as album thumb if none set
              if (!album.thumbUrl && img.ThumbnailUrl) album.thumbUrl = img.ThumbnailUrl;
            });
          } catch(e) {}
        }
      }
    } catch(e) { console.error('album detail error:', e.message); }
  }

  return { folders, albums, images };
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

    // Browse a folder by URL path — live from SmugMug
    if (action === 'browse') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const urlPath = req.query.path || '/Master-Library';
      const { folders, albums } = await fetchFolderByPath(urlPath, accessToken, accessTokenSecret);
      res.json({ ok: true, folders, albums });
      return;
    }

    // Sync a specific folder path into Supabase
    if (action === 'sync-path') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const urlPath = req.query.path || '/Master-Library';
      const result = await syncAlbumsFromPath(urlPath, accessToken, accessTokenSecret);
      res.json({ ok: true, ...result });
      return;
    }

    // Crawl/structure — returns minimal response, sync is now db-driven
    if (action === 'crawl' || action === 'structure') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      // Just verify auth works and return empty — full sync handled per-category
      const userData = await smRequest('/!authuser', accessToken, accessTokenSecret);
      res.json({ ok: true, library: { folders: [], albums: [], images: [] }, user: userData.Response?.User?.Name });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('SmugMug error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
