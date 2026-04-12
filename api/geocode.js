// api/geocode.js — server-side geocoding, no browser key restrictions
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { address } = req.query;
  if (!address) { res.status(400).json({ error: 'address required' }); return; }

  const key = process.env.GMAPS_KEY;
  if (!key) { res.status(500).json({ error: 'GMAPS_KEY not configured' }); return; }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === 'OK' && data.results[0]) {
      const { lat, lng } = data.results[0].geometry.location;
      res.json({ ok: true, lat, lng, formatted: data.results[0].formatted_address });
    } else {
      res.json({ ok: false, status: data.status, error: data.error_message });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
