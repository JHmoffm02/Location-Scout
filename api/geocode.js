// api/geocode.js — server-side geocoding with hardening
//
// Improvements over v1:
// - CORS locked to known origins (prevents quota theft)
// - Input validation (length, type)
// - 5-second fetch timeout (no hanging)
// - Region/state biasing for accuracy
// - In-memory cache (warm-function dedup)
// - Generic error responses (no leaked details)

const ALLOWED_ORIGINS = new Set([
  'https://location-scout-sand.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

// In-memory cache (resets on cold start, but helps within warm function)
const cache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours

function cacheKey(addr, state) {
  return `${addr}|${state || ''}`.toLowerCase();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), value });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const { address, state, lat, lng } = req.query;

  // Reverse geocoding mode: lat,lng → address
  if (lat && lng) {
    const flat = parseFloat(lat), flng = parseFloat(lng);
    if (!Number.isFinite(flat) || !Number.isFinite(flng)) {
      return res.status(400).json({ ok: false, error: 'invalid lat/lng' });
    }
    return doReverseGeocode(req, res, flat, flng);
  }

  // Places-by-name search: ?action=place&name=...&hint=...
  const { action, name, hint } = req.query;
  if (action === 'place') {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      return res.status(400).json({ ok: false, error: 'invalid name' });
    }
    return doPlaceSearch(req, res, name, hint);
  }

  if (typeof address !== 'string' || !address.trim() || address.length > 500) {
    return res.status(400).json({ ok: false, error: 'invalid address' });
  }

  const key = process.env.GMAPS_KEY;
  if (!key) {
    console.error('GMAPS_KEY not configured');
    return res.status(500).json({ ok: false, error: 'server misconfigured' });
  }

  const stateCode = (typeof state === 'string' && /^[A-Z]{2}$/i.test(state))
    ? state.toUpperCase() : '';

  const ck = cacheKey(address.trim(), stateCode);
  const cached = cacheGet(ck);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  const params = new URLSearchParams({
    address: address.trim(),
    key,
    region: 'us'
  });
  if (stateCode) {
    params.set('components', `country:US|administrative_area:${stateCode}`);
  } else {
    params.set('components', 'country:US');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`,
      { signal: ctrl.signal }
    );
    const data = await r.json();
    let response;
    if (data.status === 'OK' && data.results && data.results[0]) {
      const top = data.results[0];
      response = {
        ok: true,
        lat: top.geometry.location.lat,
        lng: top.geometry.location.lng,
        formatted: top.formatted_address,
        place_id: top.place_id,
        // Up to 3 alternates for the "try again" feature
        alternates: data.results.slice(1, 4).map(r => ({
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          formatted: r.formatted_address,
          place_id: r.place_id
        }))
      };
      cacheSet(ck, response);
    } else {
      response = { ok: false, status: data.status || 'UNKNOWN' };
    }
    return res.json(response);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'geocode timeout' });
    }
    console.error('geocode error:', e);
    return res.status(500).json({ ok: false, error: 'geocoding failed' });
  } finally {
    clearTimeout(timer);
  }
};

async function doPlaceSearch(req, res, name, hint) {
  const key = process.env.GMAPS_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'server misconfigured' });

  // Compose query: name + hint (state code or city). NYC metro bias keeps results local.
  const query = hint ? `${name} ${hint}` : name;
  const ck = `place:${query.toLowerCase()}`;
  const cached = cacheGet(ck);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    // Places Text Search v1
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&region=us&location=40.73,-73.97&radius=80000&key=${key}`;
    const r = await fetch(url, { signal: ctrl.signal });
    const data = await r.json();
    let response;
    if (data.status === 'OK' && data.results && data.results[0]) {
      const top = data.results[0];
      response = {
        ok: true,
        name: top.name || '',
        formatted: top.formatted_address || '',
        place_id: top.place_id,
        lat: top.geometry?.location?.lat,
        lng: top.geometry?.location?.lng,
        types: top.types || [],
        // Up to 3 alternates
        alternates: data.results.slice(1, 4).map(r => ({
          name: r.name || '',
          formatted: r.formatted_address || '',
          place_id: r.place_id,
          lat: r.geometry?.location?.lat,
          lng: r.geometry?.location?.lng
        }))
      };
      cacheSet(ck, response);
    } else {
      response = { ok: false, status: data.status || 'ZERO_RESULTS' };
    }
    return res.json(response);
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ ok: false, error: 'timeout' });
    console.error('place search error:', e);
    return res.status(500).json({ ok: false, error: 'place search failed' });
  } finally {
    clearTimeout(timer);
  }
}

async function doReverseGeocode(req, res, lat, lng) {
  const key = process.env.GMAPS_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'server misconfigured' });

  const ck = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = cacheGet(ck);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`,
      { signal: ctrl.signal }
    );
    const data = await r.json();
    let response;
    if (data.status === 'OK' && data.results && data.results[0]) {
      response = { ok: true, formatted: data.results[0].formatted_address };
      cacheSet(ck, response);
    } else {
      response = { ok: false, status: data.status || 'UNKNOWN' };
    }
    return res.json(response);
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ ok: false, error: 'timeout' });
    return res.status(500).json({ ok: false, error: 'reverse geocoding failed' });
  } finally {
    clearTimeout(timer);
  }
}
