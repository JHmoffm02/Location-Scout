// api/smugmug.js
// Vercel serverless function — handles SmugMug OAuth 1.0a signing server-side
// Your SMUGMUG_SECRET never touches the browser

import crypto from 'crypto';

const SM_API = 'https://api.smugmug.com/api/v2';
const SM_UPLOAD = 'https://upload.smugmug.com/';

function oauthSign(method, url, params, consumerKey, consumerSecret, tokenSecret = '') {
  const allParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    ...params
  };

  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams)
  ].join('&');

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  allParams.oauth_signature = signature;

  const authHeader = 'OAuth ' + Object.keys(allParams)
    .filter(k => k.startsWith('oauth_'))
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(allParams[k])}"`)
    .join(', ');

  return authHeader;
}

async function smRequest(path, accessToken, accessSecret, queryParams = {}) {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;

  const url = path.startsWith('http') ? path : `${SM_API}${path}`;
  const fullUrl = new URL(url);

  // Add _accept and _expand params
  queryParams._accept = 'application/json';
  Object.entries(queryParams).forEach(([k, v]) => fullUrl.searchParams.set(k, v));

  const cleanUrl = `${fullUrl.protocol}//${fullUrl.host}${fullUrl.pathname}`;
  const urlParams = {};
  fullUrl.searchParams.forEach((v, k) => { urlParams[k] = v; });

  const oauthParams = accessToken ? {
    oauth_token: accessToken
  } : {};

  const authHeader = oauthSign(
    'GET', cleanUrl, { ...urlParams, ...oauthParams },
    consumerKey, consumerSecret, accessSecret || ''
  );

  const res = await fetch(fullUrl.toString(), {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SmugMug API error ${res.status}: ${text}`);
  }

  return res.json();
}

// Request token (step 1 of OAuth)
async function getRequestToken() {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;
  const callbackUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/smugmug?action=callback`
    : 'http://localhost:3000/api/smugmug?action=callback';

  const url = 'https://api.smugmug.com/services/oauth/1.0a/getRequestToken';
  const authHeader = oauthSign('POST', url, { oauth_callback: callbackUrl }, consumerKey, consumerSecret);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `oauth_callback=${encodeURIComponent(callbackUrl)}`
  });

  const text = await res.text();
  const params = new URLSearchParams(text);
  return {
    requestToken: params.get('oauth_token'),
    requestTokenSecret: params.get('oauth_token_secret')
  };
}

// Exchange request token for access token (step 3 of OAuth)
async function getAccessToken(requestToken, requestTokenSecret, verifier) {
  const consumerKey = process.env.SMUGMUG_KEY;
  const consumerSecret = process.env.SMUGMUG_SECRET;
  const url = 'https://api.smugmug.com/services/oauth/1.0a/getAccessToken';

  const authHeader = oauthSign('POST', url, {
    oauth_token: requestToken,
    oauth_verifier: verifier
  }, consumerKey, consumerSecret, requestTokenSecret);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `oauth_verifier=${encodeURIComponent(verifier)}`
  });

  const text = await res.text();
  const params = new URLSearchParams(text);
  return {
    accessToken: params.get('oauth_token'),
    accessTokenSecret: params.get('oauth_token_secret')
  };
}

// Crawl entire SmugMug library recursively
async function crawlLibrary(accessToken, accessTokenSecret) {
  const results = { folders: [], albums: [], images: [] };

  // Get authenticated user
  const userRes = await smRequest('/api/v2!authuser', accessToken, accessTokenSecret);
  const userUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!userUri) throw new Error('Could not get user node');

  // Crawl node tree recursively
  async function crawlNode(nodeUri, path = '') {
    const nodeRes = await smRequest(nodeUri, accessToken, accessTokenSecret, { _expand: 'ChildNodes' });
    const node = nodeRes.Response?.Node;
    if (!node) return;

    const nodePath = path ? `${path}/${node.Name}` : node.Name;

    if (node.Type === 'Folder') {
      results.folders.push({
        id: node.NodeID,
        name: node.Name,
        path: nodePath,
        url: node.WebUri,
        uri: nodeUri
      });
      // Crawl children
      const children = nodeRes.Response?.ChildNodes?.Node || [];
      for (const child of children) {
        await crawlNode(child.Uri, nodePath);
      }
    } else if (node.Type === 'Album') {
      const albumRes = await smRequest(node.Uris?.Album?.Uri, accessToken, accessTokenSecret);
      const album = albumRes.Response?.Album;
      if (album) {
        results.albums.push({
          id: album.AlbumKey,
          name: album.Name,
          path: nodePath,
          url: album.WebUri,
          uri: node.Uris?.Album?.Uri,
          imageCount: album.ImageCount,
          coverImageUri: album.Uris?.AlbumCoverImage?.Uri,
          keywords: album.Keywords || '',
          description: album.Description || ''
        });
        // Get images in this album
        await crawlAlbumImages(album, nodePath);
      }
    }
  }

  async function crawlAlbumImages(album, albumPath) {
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const imagesRes = await smRequest(
        `${album.Uris.AlbumImages.Uri}`,
        accessToken, accessTokenSecret,
        { count: perPage, start: (page - 1) * perPage + 1 }
      );

      const images = imagesRes.Response?.AlbumImage || [];
      for (const img of images) {
        results.images.push({
          id: img.ImageKey,
          albumKey: album.AlbumKey,
          albumName: album.Name,
          albumPath,
          albumUrl: album.WebUri,
          filename: img.FileName,
          title: img.Title || img.FileName,
          caption: img.Caption || '',
          keywords: img.Keywords || '',
          date: img.DateTimeOriginal || img.DateTimeUploaded,
          width: img.OriginalWidth,
          height: img.OriginalHeight,
          thumbUrl: img.ThumbnailUrl,
          smallUrl: img.Uris?.ImageSizes?.Uri,
          webUri: img.WebUri,
          lat: img.Latitude || null,
          lng: img.Longitude || null,
          altitude: img.Altitude || null,
          format: img.Format,
          size: img.ArchivedSize,
          md5: img.ArchivedMD5,
          isVideo: img.IsVideo || false,
        });
      }

      hasMore = images.length === perPage;
      page++;
    }
  }

  await crawlNode(userUri);
  return results;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  try {
    // ---- AUTH FLOW ----
    if (action === 'auth') {
      const { requestToken, requestTokenSecret } = await getRequestToken();
      // Store request token secret in a cookie for the callback
      res.setHeader('Set-Cookie', `sm_rts=${requestTokenSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
      const authUrl = `https://api.smugmug.com/services/oauth/1.0a/authorize?oauth_token=${requestToken}&Access=Full&Permissions=Read`;
      res.json({ authUrl, requestToken });
      return;
    }

    if (action === 'callback') {
      const { oauth_token, oauth_verifier } = req.query;
      const requestTokenSecret = req.cookies?.sm_rts || req.query.rts;
      if (!oauth_token || !oauth_verifier) {
        res.status(400).json({ error: 'Missing OAuth params' }); return;
      }
      const { accessToken, accessTokenSecret } = await getAccessToken(oauth_token, requestTokenSecret, oauth_verifier);
      // Return tokens to client via redirect with fragment
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';
      res.redirect(`${appUrl}/#sm_auth=${encodeURIComponent(JSON.stringify({ accessToken, accessTokenSecret }))}`);
      return;
    }

    // All endpoints below require tokens
    const authHeader = req.headers.authorization;
    let accessToken = '', accessTokenSecret = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
        accessToken = tokens.accessToken;
        accessTokenSecret = tokens.accessTokenSecret;
      } catch(e) {}
    }

    // ---- CRAWL FULL LIBRARY ----
    if (action === 'crawl') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const library = await crawlLibrary(accessToken, accessTokenSecret);
      res.json({ ok: true, library });
      return;
    }

    // ---- GET ALBUM IMAGES ----
    if (action === 'album') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const { albumUri } = req.query;
      if (!albumUri) { res.status(400).json({ error: 'albumUri required' }); return; }
      const data = await smRequest(albumUri, accessToken, accessTokenSecret, { count: 100 });
      res.json({ ok: true, data });
      return;
    }

    // ---- GET IMAGE SIZES ----
    if (action === 'sizes') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const { sizesUri } = req.query;
      const data = await smRequest(sizesUri, accessToken, accessTokenSecret);
      res.json({ ok: true, data });
      return;
    }

    // ---- TEST CONNECTION ----
    if (action === 'test') {
      if (!accessToken) { res.status(401).json({ error: 'Not authenticated with SmugMug' }); return; }
      const data = await smRequest('/api/v2!authuser', accessToken, accessTokenSecret);
      res.json({ ok: true, user: data.Response?.User });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('SmugMug API error:', e);
    res.status(500).json({ error: e.message });
  }
}
