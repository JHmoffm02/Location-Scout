// api/smugmug.js — OAuth 1.0a + library crawl with parallelized fetches
//
// Improvements over v1:
// - Bounded-concurrency album fetches (was the big sync slowdown)
// - Retry on transient SmugMug errors
// - Secure cookie flag
// - Defensive env var checks

const crypto = require('crypto');
const SM_API = 'https://api.smugmug.com/api/v2';
const CONCURRENCY = 5;          // parallel SmugMug requests
const MAX_RETRIES = 2;
const CRAWL_DEPTH_LIMIT = 8;

// ── OAuth helpers ──────────────────────────────────────────────────────────
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

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

async function smPost(path, accessToken, accessTokenSecret, jsonBody, attempt = 0) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
  const baseUrl = (path.startsWith('http') ? path : `${SM_API}${path}`).split('?')[0];
  const oauthParams = makeOauthParams(consumerKey, accessToken);
  const authHeader = buildAuthHeader('POST', baseUrl, oauthParams, {}, consumerSecret, accessTokenSecret || '');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(jsonBody || {}),
        signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      return smPost(path, accessToken, accessTokenSecret, jsonBody, attempt + 1);
    }
    if (!res.ok) throw new Error(`SmugMug POST ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if ((e.name === 'AbortError' || /network|fetch/i.test(e.message)) && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      return smPost(path, accessToken, accessTokenSecret, jsonBody, attempt + 1);
    }
    throw e;
  }
}

// ── Folder navigation / move helpers ──────────────────────────────────────
function urlSlug(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'folder';
}
function titleCase(s) {
  return String(s).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Find or create a child folder under parentNodeUri matching `name`. Returns the child node URI.
async function findOrCreateChildFolder(parentNodeUri, name, accessToken, accessTokenSecret) {
  const baseUri = parentNodeUri.split('!')[0];
  const childRes = await smRequest(baseUri + '!children', accessToken, accessTokenSecret, { count: '500' });
  const children = childRes.Response?.Node || [];
  const arr = Array.isArray(children) ? children : [children];

  const slug = urlSlug(name);
  const lower = name.toLowerCase().trim();
  const existing = arr.find(c => {
    if (!c || c.Type !== 'Folder') return false;
    const n = (c.Name || '').toLowerCase().trim();
    const u = (c.UrlName || '').toLowerCase();
    return n === lower || u === slug || n.replace(/[-\s]+/g, '') === lower.replace(/[-\s]+/g, '');
  });
  if (existing) return existing.Uri;

  // Create
  const created = await smPost(baseUri + '!children', accessToken, accessTokenSecret, {
    Name: titleCase(name),
    UrlName: titleCase(name).replace(/\s+/g, '-'),
    Privacy: 'Public',
    Type: 'Folder'
  });
  const node = created.Response?.Node;
  if (!node || !node.Uri) throw new Error('Folder create returned no Node URI');
  return node.Uri;
}

// Walk down from root, creating segments as needed. Returns final folder node URI + path-segments-actually-used.
async function findOrCreateFolderPath(pathSegments, accessToken, accessTokenSecret) {
  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  const rootNodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!rootNodeUri) throw new Error('No root node URI');
  let current = rootNodeUri;
  for (const seg of pathSegments) {
    if (!seg) continue;
    current = await findOrCreateChildFolder(current, seg, accessToken, accessTokenSecret);
  }
  return current;
}

// DELETE a node (folder or album) by its full URI
async function deleteNodeByUri(nodeUri, accessToken, accessTokenSecret) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
  const baseUrl = nodeUri.startsWith('http') ? nodeUri : `https://api.smugmug.com${nodeUri}`;
  const oauthParams = makeOauthParams(consumerKey, accessToken);
  const authHeader = buildAuthHeader('DELETE', baseUrl, oauthParams, {}, consumerSecret, accessTokenSecret || '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(baseUrl, {
      method: 'DELETE',
      headers: { Authorization: authHeader, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`SmugMug DELETE ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } finally { clearTimeout(timer); }
}

// Find a folder by path and delete it (must be empty in SmugMug — caller should move children first)
async function deleteFolderByPath(path, accessToken, accessTokenSecret) {
  const segments = String(path || '').split('/').filter(Boolean);
  if (!segments.length) throw new Error('Empty path');
  // Walk down to find the node URI for this folder
  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  let currentNodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!currentNodeUri) throw new Error('No root node');
  for (const seg of segments) {
    const baseUri = currentNodeUri.split('!')[0];
    const childRes = await smRequest(baseUri + '!children', accessToken, accessTokenSecret, { count: '500' });
    const children = childRes.Response?.Node || [];
    const arr = Array.isArray(children) ? children : [children];
    const slug = urlSlug(seg), lower = seg.toLowerCase();
    const match = arr.find(c => {
      if (!c) return false;
      const n = (c.Name || '').toLowerCase().trim();
      const u = (c.UrlName || '').toLowerCase();
      return n === lower || u === slug || n.replace(/[-\s]+/g, '') === lower.replace(/[-\s]+/g, '');
    });
    if (!match) throw new Error(`Folder segment not found: ${seg}`);
    currentNodeUri = match.Uri;
  }
  await deleteNodeByUri(currentNodeUri, accessToken, accessTokenSecret);
  return { ok: true, deletedPath: segments.join('/') };
}

// PATCH album fields (Keywords, Description, etc.)
async function patchAlbum(albumKey, fields, accessToken, accessTokenSecret) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
  const baseUrl = `${SM_API}/album/${albumKey}`;
  const oauthParams = makeOauthParams(consumerKey, accessToken);
  const authHeader = buildAuthHeader('PATCH', baseUrl, oauthParams, {}, consumerSecret, accessTokenSecret || '');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(baseUrl, {
      method: 'PATCH',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fields || {}),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`SmugMug PATCH ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

// Merge tag arrays: dedupe (case-insensitive), preserve original casing for existing
function mergeKeywords(existingRaw, newTags) {
  const existing = String(existingRaw || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(existing.map(t => t.toLowerCase()));
  const additions = (newTags || []).filter(t => t && !seen.has(String(t).toLowerCase().trim()));
  return existing.concat(additions).join('; ');
}

// Move an album (by AlbumKey) to a destination folder path. Optionally update keywords/description.
async function moveAlbumByKey(albumKey, destPath, opts, accessToken, accessTokenSecret) {
  opts = opts || {};
  // 1. Fetch album → get its node URI + current keywords
  const albumRes = await smRequest('/album/' + albumKey, accessToken, accessTokenSecret);
  const album = albumRes.Response?.Album;
  if (!album) throw new Error('Album not found: ' + albumKey);
  const albumNodeUri = album.Uris?.Node?.Uri;
  if (!albumNodeUri) throw new Error('No album node URI for ' + albumKey);

  // 2. Find/create destination folder
  const segments = String(destPath || '').split('/').filter(Boolean);
  if (!segments.length) throw new Error('Empty destination path');
  const destNodeUri = await findOrCreateFolderPath(segments, accessToken, accessTokenSecret);

  // 3. Move the album node
  const baseUri = destNodeUri.split('!')[0];
  await smPost(baseUri + '!movenodes', accessToken, accessTokenSecret, {
    MoveUris: [albumNodeUri]
  });

  // 4. Optionally PATCH album with new keywords (merged) and/or description
  const patchFields = {};
  if (opts.tags && opts.tags.length) {
    patchFields.Keywords = mergeKeywords(album.Keywords, opts.tags);
  }
  if (opts.description && !album.Description) {
    patchFields.Description = opts.description;
  }
  let mergedKeywords = album.Keywords || '';
  if (Object.keys(patchFields).length) {
    try {
      await patchAlbum(albumKey, patchFields, accessToken, accessTokenSecret);
      if (patchFields.Keywords) mergedKeywords = patchFields.Keywords;
    } catch (e) {
      console.error('Album PATCH failed:', e.message);
      // Don't fail the whole move just because tags didn't save
    }
  }

  // 5. Re-fetch album to get its new WebUri
  await new Promise(r => setTimeout(r, 250));
  const after = await smRequest('/album/' + albumKey, accessToken, accessTokenSecret);
  const newWebUri = after.Response?.Album?.WebUri || '';

  return { ok: true, albumKey, newPath: segments.join('/'), newWebUri, keywords: mergedKeywords };
}

async function smRequest(path, accessToken, accessTokenSecret, extraParams = {}, attempt = 0) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
  const baseUrl = (path.startsWith('http') ? path : `${SM_API}${path}`).split('?')[0];
  const oauthParams = makeOauthParams(consumerKey, accessToken);
  const authHeader = buildAuthHeader('GET', baseUrl, oauthParams, extraParams, consumerSecret, accessTokenSecret || '');
  const finalUrl = new URL(baseUrl);
  Object.entries(extraParams).forEach(([k, v]) => finalUrl.searchParams.set(k, v));

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(finalUrl.toString(), {
        headers: { Authorization: authHeader, Accept: 'application/json' },
        signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }

    // 429 = rate limit; 5xx = transient — retry with backoff
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      return smRequest(path, accessToken, accessTokenSecret, extraParams, attempt + 1);
    }
    if (!res.ok) throw new Error(`SmugMug API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  } catch (e) {
    if ((e.name === 'AbortError' || /network|fetch/i.test(e.message)) && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      return smRequest(path, accessToken, accessTokenSecret, extraParams, attempt + 1);
    }
    throw e;
  }
}

// ── Bounded-concurrency map (replaces serial for-loop) ────────────────────
async function pmap(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── OAuth flow ─────────────────────────────────────────────────────────────
async function getRequestToken(callbackUrl) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
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
  if (!res.ok) throw new Error(`Request token failed: ${text.slice(0, 200)}`);
  const params = new URLSearchParams(text);
  return { requestToken: params.get('oauth_token'), requestTokenSecret: params.get('oauth_token_secret') };
}

async function getAccessToken(requestToken, requestTokenSecret, verifier) {
  const consumerKey = envOrThrow('SMUGMUG_KEY');
  const consumerSecret = envOrThrow('SMUGMUG_SECRET');
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
  if (!res.ok) throw new Error(`Access token failed: ${text.slice(0, 200)}`);
  const params = new URLSearchParams(text);
  return { accessToken: params.get('oauth_token'), accessTokenSecret: params.get('oauth_token_secret') };
}

// ── Crawl: walk the entire library, parallelize at each level ──────────────
async function crawlLibrary(accessToken, accessTokenSecret) {
  const userRes = await smRequest('/!authuser', accessToken, accessTokenSecret);
  const rootNodeUri = userRes.Response?.User?.Uris?.Node?.Uri;
  if (!rootNodeUri) throw new Error('Could not get root node');

  const folders = [], albums = [];
  const folderSet = new Set();

  async function processNode(nodeUri, depth) {
    if (depth > CRAWL_DEPTH_LIMIT) return;
    let nodeRes;
    try { nodeRes = await smRequest(nodeUri, accessToken, accessTokenSecret); }
    catch (e) { return; }

    const node = nodeRes.Response?.Node;
    if (!node) return;
    const childrenUri = node.Uris?.ChildNodes?.Uri;
    if (!childrenUri) return;

    let childRes;
    try { childRes = await smRequest(childrenUri, accessToken, accessTokenSecret, { count: '500' }); }
    catch (e) { return; }

    const children = childRes.Response?.Node || [];
    const arr = Array.isArray(children) ? children : [children];

    // Process albums in parallel; recurse into folders sequentially (to respect depth)
    const albumChildren = arr.filter(c => c && c.Type === 'Album');
    const folderChildren = arr.filter(c => c && c.Type === 'Folder');

    // Parallel album fetches
    const albumResults = await pmap(albumChildren, async child => {
      const albumUri = child.Uris?.Album?.Uri;
      if (!albumUri) return null;
      try {
        const albumRes = await smRequest(albumUri, accessToken, accessTokenSecret);
        const album = albumRes.Response?.Album;
        if (!album) return null;
        const webUrl = album.WebUri || '';
        const urlParts = webUrl.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
        const folderPath = urlParts.length > 1 ? urlParts.slice(0, -1).join('/') : '';
        return {
          album: {
            id: album.AlbumKey,
            name: album.Name,
            path: folderPath,
            url: webUrl,
            imageCount: album.ImageCount || 0,
            description: album.Description || '',
            keywords: album.Keywords || ''
          },
          folderPath
        };
      } catch (e) { return null; }
    });

    albumResults.forEach(r => {
      if (!r || r.__error) return;
      albums.push(r.album);
      if (r.folderPath) {
        const parts = r.folderPath.split('/');
        let cum = '';
        parts.forEach((p, i) => {
          cum = i === 0 ? p : cum + '/' + p;
          if (!folderSet.has(cum)) {
            folderSet.add(cum);
            folders.push({
              id: cum, name: p.replace(/-/g, ' '), path: cum,
              url: 'https://jordanhoffman.smugmug.com/' + cum
            });
          }
        });
      }
    });

    // Recurse into folders — also in parallel but limited depth
    await pmap(folderChildren, child => processNode(child.Uri, depth + 1), 3);
  }

  await processNode(rootNodeUri, 0);
  return { folders, albums };
}

// ── album-images: all images + description, paginated ─────────────────────
async function fetchAlbumImages(albumKey, accessToken, accessTokenSecret) {
  const albumRes = await smRequest('/album/' + albumKey, accessToken, accessTokenSecret);
  const album = albumRes.Response?.Album;
  if (!album) return { images: [], description: '' };

  const description = album.Description || '';
  const imagesUri = album.Uris?.AlbumImages?.Uri;
  if (!imagesUri) return { images: [], description };

  const all = [];
  let start = 1;
  while (true) {
    const imgRes = await smRequest(imagesUri, accessToken, accessTokenSecret,
      { count: '100', start: String(start) });
    const imgs = imgRes.Response?.AlbumImage || [];
    const arr = Array.isArray(imgs) ? imgs : [imgs];
    arr.forEach(img => {
      if (!img || !img.ImageKey) return;
      all.push({
        id: img.ImageKey, albumKey, albumName: album.Name,
        albumPath: '', albumUrl: album.WebUri || '',
        filename: img.FileName || '', title: img.Title || img.FileName || '',
        caption: img.Caption || '', keywords: img.Keywords || '',
        date: img.DateTimeOriginal || null,
        width: img.OriginalWidth || null, height: img.OriginalHeight || null,
        thumbUrl: img.ThumbnailUrl || null, webUri: img.WebUri || null,
        lat: img.Latitude || null, lng: img.Longitude || null,
        format: img.Format || null, size: img.ArchivedSize || null,
        isVideo: img.IsVideo || false
      });
    });
    if (arr.length < 100) break;
    start += 100;
    if (start > 5000) break;  // hard cap, prevents runaway
  }
  return { images: all, description };
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');  // OAuth callback needs to redirect cross-origin; consider locking after stable
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ── auth / callback (no Bearer needed) ─────────────────────────────────
    if (action === 'auth') {
      const host = req.headers.host || '';
      const proto = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${proto}://${host}/api/smugmug?action=callback`;
      const { requestToken, requestTokenSecret } = await getRequestToken(callbackUrl);
      const secureFlag = proto === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sm_rts=${requestTokenSecret}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=600`);
      const authUrl = `https://api.smugmug.com/services/oauth/1.0a/authorize?oauth_token=${requestToken}&Access=Full&Permissions=Read`;
      return res.json({ authUrl, requestToken });
    }

    if (action === 'callback') {
      const { oauth_token, oauth_verifier } = req.query;
      const cookieStr = req.headers.cookie || '';
      const rtsCookie = cookieStr.split(';').find(c => c.trim().startsWith('sm_rts='));
      const requestTokenSecret = rtsCookie ? rtsCookie.split('=')[1].trim() : '';
      if (!oauth_token || !oauth_verifier) return res.status(400).json({ error: 'Missing OAuth params' });
      const { accessToken, accessTokenSecret } = await getAccessToken(oauth_token, requestTokenSecret, oauth_verifier);
      const host = req.headers.host || '';
      const proto = host.includes('localhost') ? 'http' : 'https';
      const payload = pct(JSON.stringify({ accessToken, accessTokenSecret }));
      // Clear the sm_rts cookie
      res.setHeader('Set-Cookie', `sm_rts=; Path=/; HttpOnly; Max-Age=0`);
      res.writeHead(302, { Location: `${proto}://${host}/#sm_auth=${payload}` });
      return res.end();
    }

    // ── Auth required for everything below ─────────────────────────────────
    let accessToken = '', accessTokenSecret = '';
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
        accessToken = tokens.accessToken;
        accessTokenSecret = tokens.accessTokenSecret;
      } catch (e) {}
    }
    if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });

    if (action === 'test') {
      const data = await smRequest('/!authuser', accessToken, accessTokenSecret);
      return res.json({ ok: true, user: data.Response?.User?.Name });
    }

    if (action === 'crawl' || action === 'structure') {
      const lib = await crawlLibrary(accessToken, accessTokenSecret);
      return res.json({ ok: true, library: { ...lib, images: [] } });
    }

    if (action === 'album-images') {
      const { albumKey } = req.query;
      if (!albumKey) return res.status(400).json({ error: 'albumKey required' });
      const { images, description } = await fetchAlbumImages(albumKey, accessToken, accessTokenSecret);
      return res.json({ ok: true, images, description });
    }

    if (action === 'album-description') {
      const { albumKey } = req.query;
      if (!albumKey) return res.status(400).json({ error: 'albumKey required' });
      try {
        const albumRes = await smRequest('/album/' + albumKey, accessToken, accessTokenSecret);
        const album = albumRes.Response?.Album;
        return res.json({ ok: true, description: album?.Description || '' });
      } catch (e) {
        return res.json({ ok: true, description: '' });
      }
    }

    if (action === 'move_album') {
      const body = req.method === 'POST'
        ? (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}))
        : req.query;
      const { albumKey, destPath, tags, description } = body;
      if (!albumKey || !destPath) {
        return res.status(400).json({ error: 'albumKey and destPath required' });
      }
      try {
        const result = await moveAlbumByKey(
          albumKey,
          destPath,
          { tags: Array.isArray(tags) ? tags : [], description: description || '' },
          accessToken, accessTokenSecret
        );
        return res.json(result);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'move failed' });
      }
    }

    if (action === 'delete_folder') {
      const body = req.method === 'POST'
        ? (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}))
        : req.query;
      const { path } = body;
      if (!path) return res.status(400).json({ error: 'path required' });
      try {
        const result = await deleteFolderByPath(path, accessToken, accessTokenSecret);
        return res.json(result);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'delete failed' });
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('SmugMug error:', e.message);
    return res.status(500).json({ error: 'smugmug request failed' });
  }
};
