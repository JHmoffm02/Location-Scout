// api/smugmug.js
const crypto = require('crypto');
const SM_API = 'https://api.smugmug.com/api/v2';

function buildAuthHeader(method, baseUrl, oauthParams, signatureParams, consumerSecret, tokenSecret) {
  // signatureParams: only params that go INTO the signature (no _accept, no _expand in some cases)
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

function pct(s) { return encodeURIComponent(s).replace(/!/g, '%21'); }

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

  // Clean base URL — strip any query string
  const baseUrl = (path.startsWith('http') ? path : `${SM_API}${path}`).split('?')[0];

  const oauthParams = makeOauthParams(consumerKey, accessToken);

  // extraParams go into signature AND onto the URL (but NOT _accept)
  const authHeader = buildAuthHeader(
    'GET', baseUrl, oauthParams,
    extraParams, // only extraParams in signature, not _accept
    consumerSecret, accessTokenSecret || ''
  );

  // Build final URL: base + extraParams + _accept (accept added AFTER signing)
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
  return {
    requestToken: params.get('oauth_token'),
    requestTokenSecret: params.get('oauth_token_secret')
  };
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
  return {
    accessToken: params.get('oauth_token'),
    accessTokenSecret: params.get('oauth_token_secret')
  };
}

async function crawlLibrary(accessToken, accessTokenSecret) {
  const results = { folders: [], albums: [], images: [] };

  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  const nodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!nodeUri) throw new Error('Could not get user node URI');

  async function crawlNode(nodeUri, path = '') {
    let nodeRes;
    try {
      nodeRes = await smRequest(nodeUri, accessToken, accessTokenSecret, { _expand: 'ChildNodes' });
    } catch(e) { console.error('crawlNode error:', e.message); return; }
    const node = nodeRes.Response?.Node;
    if (!node) return;
    const nodePath = path ? `${path}/${node.Name}` : node.Name;

    if (node.Type === 'Folder') {
      results.folders.push({ id: node.NodeID, name: node.Name, path: nodePath, url: node.WebUri, uri: nodeUri });
      const children = nodeRes.Response?.ChildNodes?.Node || [];
      const childArr = Array.isArray(children) ? children : [children];
      for (const child of childArr) {
        if (child && child.Uri) await crawlNode(child.Uri, nodePath);
      }
    } else if (node.Type === 'Album') {
      const albumUri = node.Uris?.Album?.Uri;
      if (!albumUri) return;
      let albumRes;
      try { albumRes = await smRequest(albumUri, accessToken, accessTokenSecret); } catch(e) { return; }
      const album = albumRes.Response?.Album;
      if (!album) return;
      results.albums.push({
        id: album.AlbumKey, name: album.Name, path: nodePath,
        url: album.WebUri, uri: albumUri,
        imageCount: album.ImageCount || 0,
        keywords: album.Keywords || '', description: album.Description || ''
      });
      await crawlAlbumImages(album, nodePath);
    }
  }

  async function crawlAlbumImages(album, albumPath) {
    const albumImagesUri = album.Uris?.AlbumImages?.Uri;
    if (!albumImagesUri) return;
    let start = 1;
    const perPage = 100;
    while (true) {
      let imagesRes;
      try {
        imagesRes = await smRequest(
          albumImagesUri, accessToken, accessTokenSecret,
          { count: String(perPage), start: String(start) }
        );
      } catch(e) { break; }
      const images = imagesRes.Response?.AlbumImage || [];
      const imageArr = Array.isArray(images) ? images : [images];
      for (const img of imageArr) {
        if (!img || !img.ImageKey) continue;
        results.images.push({
          id: img.ImageKey, albumKey: album.AlbumKey, albumName: album.Name,
          albumPath, albumUrl: album.WebUri,
          filename: img.FileName || '', title: img.Title || img.FileName || '',
          caption: img.Caption || '', keywords: img.Keywords || '',
          date: img.DateTimeOriginal || img.DateTimeUploaded || null,
          width: img.OriginalWidth || null, height: img.OriginalHeight || null,
          thumbUrl: img.ThumbnailUrl || null, webUri: img.WebUri || null,
          lat: img.Latitude || null, lng: img.Longitude || null,
          format: img.Format || null, size: img.ArchivedSize || null,
          isVideo: img.IsVideo || false,
        });
      }
      if (imageArr.length < perPage) break;
      start += perPage;
    }
  }

  await crawlNode(nodeUri);
  return results;
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
      const callbackUrl = `${proto}://${host}/api/smugmug?action=callback&v=2`;
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

    // Parse tokens from Authorization header
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

    if (action === 'crawl') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const library = await crawlLibrary(accessToken, accessTokenSecret);
      res.json({ ok: true, library });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('SmugMug error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
