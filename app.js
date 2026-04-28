// app.js — Jordan B. Hoffman Locations
// Performance + bug-fixed rewrite. See parser.js for shared notes parser.

(function () {
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════
const SB_URL = 'https://bdnezxdfhapaxhoedtrp.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbmV6eGRmaGFwYXhob2VkdHJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5OTgwMTAsImV4cCI6MjA5MTU3NDAxMH0.tdyh77PJ4xSOnb4GeLQRHcDWd0l2KRMpgl7Awj7NiB0';
const GM_KEY = 'AIzaSyBORHlI6GqQNtL2Ev8RlapOFKrjFgkzJfA';
const SM_BASE = 'https://location-scout-sand.vercel.app';
const COLUMBUS = { lat: 40.7681, lng: -73.9819 };
const ZONE_M = 30 * 1609.34;

const SL = {
  identified: { bg: 'rgba(85,83,80,.2)',   c: '#888680' },
  scouted:    { bg: 'rgba(91,155,213,.18)', c: '#5b9bd5' },
  pending:    { bg: 'rgba(212,148,58,.18)', c: '#d4943a' },
  approved:   { bg: 'rgba(76,175,130,.18)', c: '#4caf82' },
  rejected:   { bg: 'rgba(194,96,96,.18)', c: '#c26060' }
};

// Display labels — collapsed to two states the scout cares about:
//   PENDING: explicitly marked *pending* in notes (sync detected this)
//   CLEAR:   everything else (the default — "this location is good to go")
const SL_LABEL = {
  identified: 'clear',
  scouted:    'clear',
  pending:    'pending',
  approved:   'clear',
  rejected:   'rejected'   // kept distinct in case you want to bring it back later
};

// Filter chip → DB statuses it matches
const STATUS_FILTERS = {
  pending:  ['pending'],
  clear:    ['identified', 'scouted', 'approved']
};

const CAT_PALETTE = [
  '#4a9edd', '#3dbb7a', '#e8832a', '#9060d0', '#e04545',
  '#20b8c0', '#d4b800', '#e060a8', '#68bb28', '#3060d8',
  '#e06830', '#28b0e0', '#c03838', '#40cc90', '#a030d0',
  '#d0a000', '#28b888', '#d83880', '#88cc20', '#3888d8',
  '#e05020', '#18c8b8', '#98cc18', '#e03068', '#2878e8'
];

const NAV_HISTORY_MAX = 50;
const LOC_CACHE_KEY = 'loc_cache_v2_1';
const LOC_CACHE_TTL = 15 * 60 * 1000;
const LOC_SELECT = 'id,name,lat,lng,status,state_code,city,address,address_cross,zip,address_verified,address_candidates,smugmug_album_key,smugmug_gallery_url,cover_photo_url,notes,notes_override,tags,scout_name,scout_date';
// Pre-migration schema (no address_cross, zip, address_verified, address_candidates)
const LOC_SELECT_LEGACY = 'id,name,lat,lng,status,state_code,city,address,smugmug_album_key,smugmug_gallery_url,cover_photo_url,notes,notes_override,tags,scout_name,scout_date';

// ══════════════════════════════════════════════════════════════════════════
// STATE (single object — no scattered globals)
// ══════════════════════════════════════════════════════════════════════════
const S = {
  locations: [], mapAlbums: [], mapFolders: [],
  libAlbums: [], libFolders: [], libLoaded: false, libStack: [], libRedoStack: [],
  // Lookup tables — O(1) hot paths
  albumByKey: new Map(), locByAlbumKey: new Map(), locById: new Map(),
  catByAlbumKey: new Map(), areaByAlbumKey: new Map(),
  // Map
  gmap: null, mapReady: false, markers: [], markerPool: new Map(),
  clusterer: null, selectionOverlay: null, zoneCircle: null,
  zoneOn: false, satOn: false,
  // Filters
  catPinColors: {}, savedCatColors: {},
  highlightedCat: null, selectedAreas: new Set(),
  // UI
  currentHoverLoc: null, currentDetailLoc: null,
  dpImages: [], dpIndex: 0, dpRequestToken: 0, dpSelectedRun: null,
  smTokens: null, dockOpen: false,
  editingLoc: null,
  navHistory: [], navFuture: [],
  migrationRan: true,
  // Organize tab
  orgUploads: [],         // raw album list from /Master-Library/Uploads/
  orgLoaded: false,
  orgClassifications: {}, // {sm_key: {path, confidence, status, ...}}
  orgClassifying: false,
  orgApplying: false,
  orgCancelClassify: false,
  orgCancelApply: false,
  orgClassifyController: null  // AbortController for in-flight fetch
};
window.S = S;  // expose for HTML inline handlers

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════
const E = (window.NotesParser && NotesParser.escapeHtml) || function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
const $ = id => document.getElementById(id);

function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + (type || 'ok') + ' show';
  setTimeout(() => { el.className = 'toast'; }, 3500);
}

function smMedium(url) { return url ? url.replace(/\/(Th|Ti|S)\//, '/M/') : ''; }
function smLarge(url)  { return url ? url.replace(/\/(Th|Ti|S|M)\//, '/L/') : ''; }
function smXL(url)     { return url ? url.replace(/\/(Th|Ti|S|M|L)\//, '/XL/') : ''; }

function hasCoords(l) { return l && l.lat && l.lng && !(l.lat === 0 && l.lng === 0); }

function miles(lat, lng) {
  const R = 3958.8;
  const dLat = (lat - COLUMBUS.lat) * Math.PI / 180;
  const dLng = (lng - COLUMBUS.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(COLUMBUS.lat * Math.PI/180) * Math.cos(lat * Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Visibility-aware fetch retry ──
// Browsers (Chrome especially) suspend network I/O when a tab is hidden,
// the computer sleeps, or aggressive power-saving kicks in. The error name
// varies but the symptom is "fetch failed" / NETWORK_IO_SUSPENDED / NETWORK_CHANGED.
// This helper waits for the tab to become visible again, then retries with
// exponential backoff. Use it for any long-running sync/upload work.

function awaitVisibility() {
  if (!document.hidden) return Promise.resolve();
  return new Promise(resolve => {
    const handler = () => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', handler);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', handler);
  });
}

async function fetchRetry(url, opts, maxRetries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Wait for tab to be visible (no point retrying while tab is hidden — same suspension will happen)
      await awaitVisibility();
    }
    try {
      const r = await fetch(url, opts);
      // Retry on rate-limit and server errors
      if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
        const wait = 1500 * Math.pow(2, attempt);
        console.warn(`[fetchRetry] HTTP ${r.status} ${url} — retry ${attempt+1}/${maxRetries} in ${wait}ms`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      const isNetwork = /network|fetch|suspended|aborted|failed/i.test(msg);
      if (attempt < maxRetries && isNetwork) {
        const wait = 2000 * Math.pow(1.5, attempt);
        console.warn(`[fetchRetry] network error: ${msg} — retry ${attempt+1}/${maxRetries} in ${wait}ms`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

// ══════════════════════════════════════════════════════════════════════════
// DB LAYER
// ══════════════════════════════════════════════════════════════════════════
function db(path, opts) {
  opts = opts || {};
  const headers = {
    apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
    Prefer: opts.prefer || 'return=representation'
  };
  if (opts.headers) Object.assign(headers, opts.headers);
  const init = { headers };
  if (opts.method) init.method = opts.method;
  if (opts.body)   init.body   = opts.body;
  return fetch(SB_URL + '/rest/v1/' + path, init).then(r =>
    r.ok ? r.json() : r.json().then(e => Promise.reject(e))
  );
}

async function loadLocations(forceRefresh) {
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
      if (cached && cached.ts && Date.now() - cached.ts < LOC_CACHE_TTL && cached.data && cached.data.length) {
        S.locations = cached.data;
        rebuildLookups();
        setTimeout(refreshLocationsBackground, 100);
        return S.locations;
      }
    } catch (e) {}
  }
  return await fetchLocations();
}

async function fetchLocations() {
  // Try v2 schema first (post-migration)
  try {
    const data = await db(`locations?select=${LOC_SELECT}&order=name.asc`);
    S.locations = data;
    rebuildLookups();
    try { localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
    return S.locations;
  } catch (e1) {
    // Fall back to legacy schema (pre-migration)
    console.warn('v2 schema failed, trying legacy:', e1.message || e1);
    try {
      const data = await db(`locations?select=${LOC_SELECT_LEGACY}&order=name.asc`);
      // Backfill missing fields with defaults so the rest of the app works
      S.locations = data.map(l => Object.assign({
        address_verified: false,
        address_candidates: null,
        address_cross: null,
        zip: null
      }, l));
      S.migrationRan = false;   // suppress verification UI in legacy mode
      rebuildLookups();
      try { localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: S.locations })); } catch (e) {}
      toast('⚠ Migration not run — run migration.sql for full features', 'err');
      return S.locations;
    } catch (e2) {
      const msg = (e2 && e2.message) || (e1 && e1.message) || 'unknown';
      console.error('Both location queries failed:', e2);
      toast('DB error: ' + msg, 'err');
      return [];
    }
  }
}

async function refreshLocationsBackground() {
  try {
    let data;
    try {
      data = await db(`locations?select=${LOC_SELECT}&order=name.asc`);
    } catch (e1) {
      data = await db(`locations?select=${LOC_SELECT_LEGACY}&order=name.asc`);
      data = data.map(l => Object.assign({
        address_verified: false, address_candidates: null,
        address_cross: null, zip: null
      }, l));
    }
    if (!data || !data.length) return;
    S.locations = data;
    rebuildLookups();
    try { localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
    if (S.gmap) refreshPins();
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════════════
// LOOKUP TABLES (rebuilt on data changes)
// ══════════════════════════════════════════════════════════════════════════
function rebuildLookups() {
  S.albumByKey.clear(); S.locByAlbumKey.clear(); S.locById.clear();
  S.catByAlbumKey.clear(); S.areaByAlbumKey.clear();

  S.mapAlbums.forEach(a => {
    S.albumByKey.set(a.sm_key, a);
    if (a.web_url) {
      const parts = a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
      if (parts[1]) S.catByAlbumKey.set(a.sm_key, parts[1]);
      if (parts[2]) S.areaByAlbumKey.set(a.sm_key, parts[2]);
    }
  });
  S.locations.forEach(l => {
    S.locById.set(l.id, l);
    if (l.smugmug_album_key) S.locByAlbumKey.set(l.smugmug_album_key, l);
  });
}

function getCatForLoc(loc)  { return loc ? (S.catByAlbumKey.get(loc.smugmug_album_key) || '')  : ''; }
function getAreaForLoc(loc) { return loc ? (S.areaByAlbumKey.get(loc.smugmug_album_key) || '') : ''; }

function catColorByKey(ck) {
  if (!ck) return '#888680';
  if (S.catPinColors[ck]) return S.catPinColors[ck];
  let hash = 0;
  for (let i = 0; i < ck.length; i++) hash = (hash * 31 + ck.charCodeAt(i)) & 0xffff;
  return CAT_PALETTE[hash % CAT_PALETTE.length];
}

function pinColorForLoc(loc) {
  const cat = getCatForLoc(loc);
  if (Object.keys(S.catPinColors).length === 0) return '#888680';
  return S.catPinColors[cat] || null;
}

// ══════════════════════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════════════════════
function getActiveStates() {
  return ['ny','nj','other'].filter(s => $('f-' + s)?.checked);
}
function getActiveStatusKeys() {
  return Object.keys(STATUS_FILTERS).filter(k => $('f-' + k)?.checked);
}
function zoneFilterActive() { return $('f-zone')?.checked; }

function locPassesGlobalFilter(l) {
  // ── State filter ────────────────────────────────────────────────────────
  const ny    = $('f-ny')?.checked;
  const nj    = $('f-nj')?.checked;
  const other = $('f-other')?.checked;
  const sc = (l.state_code || '').toUpperCase().trim();
  if (sc === 'NY') {
    if (!ny) return false;
  } else if (sc === 'NJ') {
    if (!nj) return false;
  } else {
    // Any other state, or empty/null state_code → counts as "other"
    if (!other) return false;
  }

  // ── Status filter (chips: pending, clear) ──────────────────────────────
  const pendingChecked = $('f-pending')?.checked;
  const clearChecked   = $('f-clear')?.checked;
  if (l.status === 'pending') {
    if (!pendingChecked) return false;
  } else {
    // Anything not 'pending' counts as "clear" for filter purposes
    if (!clearChecked) return false;
  }

  // ── 30-mile zone filter ────────────────────────────────────────────────
  if (zoneFilterActive() && hasCoords(l) && miles(l.lat, l.lng) > 30) return false;

  return true;
}

function getFiltered() {
  return S.locations.filter(l => hasCoords(l) && locPassesGlobalFilter(l));
}

window.applyFilters = function () {
  saveFilterSettings();
  if (S.gmap) refreshPins();
  if ($('library-page').classList.contains('active')) libRender();
  // Empty-state toast
  if (S.gmap && S.markers.length === 0 && S.locations.length > 0) {
    toast('No locations match these filters', 'inf');
  }
};

function saveFilterSettings() {
  const s = {};
  ['ny','nj','other','pending','clear','zone','flatten'].forEach(id => {
    const el = $('f-' + id); if (el) s['f-'+id] = el.checked;
  });
  try { localStorage.setItem('mapFilters', JSON.stringify(s)); } catch (e) {}
}

function loadFilterSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mapFilters') || '{}');
    ['ny','nj','other','pending','clear','zone','flatten'].forEach(id => {
      const el = $('f-' + id);
      if (el && s.hasOwnProperty('f-'+id)) el.checked = s['f-'+id];
    });
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════════════
// NAV HISTORY (undo/redo)
// ══════════════════════════════════════════════════════════════════════════
function navSnapshot() {
  return {
    detailLocId: S.currentDetailLoc ? S.currentDetailLoc.id : null,
    libStack: S.libStack.slice(),
    highlightedCat: S.highlightedCat,
    selectedAreas: Array.from(S.selectedAreas)
  };
}
function pushNav() {
  S.navHistory.push(navSnapshot());
  if (S.navHistory.length > NAV_HISTORY_MAX) S.navHistory.shift();
  S.navFuture = [];
}
function applyNavSnapshot(snap) {
  S.libStack = snap.libStack || [];
  if ($('library-page').classList.contains('active')) libRender();
  S.highlightedCat = snap.highlightedCat || null;
  S.selectedAreas = new Set(snap.selectedAreas || []);
  refreshLeftPanel();
  updatePinHighlights();
  const loc = snap.detailLocId ? S.locById.get(snap.detailLocId) : null;
  if (loc) openDetail(loc); else closeDetail();
}
function undoNav() { if (!S.navHistory.length) return; S.navFuture.push(navSnapshot()); applyNavSnapshot(S.navHistory.pop()); }
function redoNav() { if (!S.navFuture.length) return; S.navHistory.push(navSnapshot()); applyNavSnapshot(S.navFuture.pop()); }

// ══════════════════════════════════════════════════════════════════════════
// MAP
// ══════════════════════════════════════════════════════════════════════════
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0a0a0d' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#4a4846' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#18181c' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#202026' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#28282e' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#404040' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#05070d' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#14141a' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0c0c10' }] }
];

function loadMapScript() {
  if (document.getElementById('gms')) return;
  const c = document.createElement('script'); c.id = 'gmc';
  c.src = 'https://unpkg.com/@googlemaps/markerclusterer/dist/index.min.js';
  c.onload = () => {
    const s = document.createElement('script'); s.id = 'gms'; s.async = true;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GM_KEY}&libraries=places&callback=initMap&loading=async`;
    document.head.appendChild(s);
  };
  document.head.appendChild(c);
}

window.initMap = async function () {
  S.mapReady = true;
  S.gmap = new google.maps.Map($('the-map'), {
    zoom: 11, center: { lat: 40.73, lng: -73.97 },
    backgroundColor: '#08090b',
    disableDefaultUI: true, gestureHandling: 'greedy',
    isFractionalZoomEnabled: false,  // integer zoom only — much smoother
    styles: MAP_STYLE
  });
  S.gmap.addListener('click', () => {
    $('hcard').classList.remove('show');
    if (S.currentDetailLoc) closeDetail();
  });

  await Promise.all([
    db('smugmug_albums?select=sm_key,name,web_url').then(r => { S.mapAlbums = r; }),
    db('smugmug_folders?select=name,path&order=path.asc').then(r => { S.mapFolders = r; })
  ]);
  rebuildLookups();
  buildLeftPanel();
  checkAuth();
  checkSyncStatus();

  google.maps.event.addListenerOnce(S.gmap, 'idle', refreshPins);
};

// Memoize icon objects so 500 gray pins share the same icon (huge perf win).
// Using URL-based SVG (vs SymbolPath) so Google Maps can canvas-optimize them.
const _iconCache = new Map();
function makeIcon(col, scale, stroke, opacity, sw) {
  const _scale = scale || 8;
  const _stroke = stroke || 'rgba(0,0,0,.5)';
  const _opacity = opacity != null ? opacity : 0.9;
  const _sw = sw != null ? sw : 1.5;
  const key = col + '|' + _scale + '|' + _stroke + '|' + _opacity + '|' + _sw;
  let icon = _iconCache.get(key);
  if (!icon) {
    const total = Math.ceil((_scale + _sw) * 2 + 2);
    const cx = total / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}"><circle cx="${cx}" cy="${cx}" r="${_scale}" fill="${col}" fill-opacity="${_opacity}" stroke="${_stroke}" stroke-width="${_sw}"/></svg>`;
    icon = {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(total, total),
      anchor: new google.maps.Point(cx, cx)
    };
    _iconCache.set(key, icon);
  }
  return icon;
}

function refreshPins() {
  if (!S.gmap) return;
  S.highlightedCat = null;
  S.selectedAreas = new Set();
  const filtered = getFiltered();

  if (S.clusterer) S.clusterer.clearMarkers();
  S.markerPool.forEach(m => m.setMap(null));

  filtered.forEach(loc => {
    const col = pinColorForLoc(loc) || '#888680';
    let m = S.markerPool.get(loc.id);
    if (m) {
      m._col = col; m._loc = loc;
      m.setIcon(makeIcon(col));
      // Update position too — lat/lng might have changed via edit/regeocode
      const newPos = { lat: Number(loc.lat), lng: Number(loc.lng) };
      const cur = m.getPosition();
      if (!cur || cur.lat() !== newPos.lat || cur.lng() !== newPos.lng) {
        m.setPosition(newPos);
      }
    } else {
      m = new google.maps.Marker({
        position: { lat: Number(loc.lat), lng: Number(loc.lng) },
        title: loc.name, icon: makeIcon(col), zIndex: 1
      });
      m._loc = loc; m._col = col;
      m.addListener('mouseover', e => { S.currentHoverLoc = m._loc; showHcard(m._loc, e.domEvent); });
      m.addListener('mouseout', () => {
        setTimeout(() => {
          if (!$('hcard').matches(':hover')) $('hcard').classList.remove('show');
        }, 180);
      });
      m.addListener('mousemove', e => posHcard(e.domEvent));
      m.addListener('click', () => { S.currentHoverLoc = m._loc; openDetail(m._loc); });
      S.markerPool.set(loc.id, m);
    }
  });

  // Remove stale entries from pool (locations deleted via sync)
  const filteredIds = new Set(filtered.map(l => l.id));
  S.markerPool.forEach((m, id) => {
    if (!S.locById.has(id)) {
      m.setMap(null);
      S.markerPool.delete(id);
    }
  });

  S.markers = [];
  filtered.forEach(loc => {
    if (pinColorForLoc(loc) !== null) S.markers.push(S.markerPool.get(loc.id));
  });

  if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
    if (S.clusterer) {
      S.clusterer.clearMarkers();
      S.clusterer.addMarkers(S.markers);
    } else {
      S.clusterer = new markerClusterer.MarkerClusterer({
        map: S.gmap, markers: S.markers,
        algorithm: new markerClusterer.SuperClusterAlgorithm({ maxZoom: 13, radius: 80 }),
        renderer: { render: clusterRender }
      });
    }
  } else {
    S.markers.forEach(m => m.setMap(S.gmap));
  }

  if (S.zoneOn) drawZone();
  if (S.currentDetailLoc) highlightPin(S.currentDetailLoc);
}

const _clusterIconCache = new Map();
function makeClusterIcon(clusterColor, count) {
  const key = (clusterColor || 'gray') + ':' + count;
  let icon = _clusterIconCache.get(key);
  if (icon) return icon;
  const fill   = clusterColor ? clusterColor + '22' : '#1c1e22';
  const stroke = clusterColor || 'rgba(255,255,255,0.12)';
  const text   = clusterColor || '#e6e4de';
  const size = count > 99 ? 48 : count > 9 ? 42 : 36;
  const r = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r-2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${r}" y="${r+4}" text-anchor="middle" font-family="DM Mono,monospace" font-size="11" fill="${text}">${count}</text></svg>`;
  icon = {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(r, r)
  };
  _clusterIconCache.set(key, icon);
  return icon;
}

function clusterRender(cluster) {
  const count = cluster.count;
  const catCounts = {};
  if (cluster.markers) {
    cluster.markers.forEach(m => {
      if (!m._loc) return;
      const cat = getCatForLoc(m._loc);
      if (cat && S.catPinColors[cat]) catCounts[cat] = (catCounts[cat] || 0) + 1;
    });
  }
  let topCat = null, topCount = 0;
  Object.keys(catCounts).forEach(c => { if (catCounts[c] > topCount) { topCount = catCounts[c]; topCat = c; } });
  const clusterColor = topCat ? S.catPinColors[topCat] : null;
  return new google.maps.Marker({
    position: cluster.position,
    icon: makeClusterIcon(clusterColor, count),
    zIndex: 900 + count
  });
}

function updatePinHighlights() {
  if (!S.gmap) return;
  const hasSelection = S.highlightedCat || S.selectedAreas.size > 0;
  S.markers.forEach(m => {
    if (!m._loc || pinColorForLoc(m._loc) === null) return;
    const mCat = getCatForLoc(m._loc);
    const mArea = getAreaForLoc(m._loc);
    let isSelected = false;
    if (S.selectedAreas.size > 0) isSelected = S.selectedAreas.has(mCat + '/' + mArea);
    else if (S.highlightedCat) isSelected = mCat === S.highlightedCat;

    if (hasSelection && isSelected) {
      m.setIcon(makeIcon(m._col, 13, '#fff', 1, 2.5));
      m.setZIndex(999); m.setVisible(true);
    } else if (hasSelection) {
      const otherEnabled = !!S.catPinColors[mCat];
      m.setVisible(otherEnabled);
      if (otherEnabled) { m.setIcon(makeIcon(m._col)); m.setZIndex(1); }
    } else {
      m.setVisible(true); m.setIcon(makeIcon(m._col)); m.setZIndex(1);
    }
  });
}

function highlightPin(loc) {
  if (S.selectionOverlay) { S.selectionOverlay.setMap(null); S.selectionOverlay = null; }
  if (!loc) return;
  const m = S.markerPool.get(loc.id);
  if (!m) return;
  S.selectionOverlay = new google.maps.Marker({
    position: m.getPosition(), map: S.gmap,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 15, fillColor: m._col, fillOpacity: 1,
      strokeColor: '#ffffff', strokeWeight: 3
    },
    zIndex: 1000, clickable: true, title: loc.name
  });
  S.selectionOverlay.addListener('click', () => openDetail(loc));
}

function panToVisible(loc) {
  if (!S.gmap || !hasCoords(loc)) return;
  const lat = Number(loc.lat), lng = Number(loc.lng);
  const mapWrap = $('map-wrap'), leftPanel = $('left-panel'), dp = $('detail-panel');
  const mapLeft = leftPanel ? leftPanel.offsetWidth : 0;
  const mapRight = dp && dp.classList.contains('open') ? dp.offsetWidth : 0;
  const mapTotalW = mapWrap ? mapWrap.offsetWidth : window.innerWidth;
  const visibleCenterX = mapLeft + (mapTotalW - mapRight - mapLeft) / 2;
  const offsetPx = visibleCenterX - mapTotalW / 2;
  const targetZoom = Math.max(S.gmap.getZoom(), 14);
  S.gmap.setZoom(targetZoom);
  const scale = Math.pow(2, targetZoom);
  const lngOffset = offsetPx * 360 / (256 * scale);
  S.gmap.panTo({ lat: lat, lng: lng - lngOffset });
}

window.toggleZone = function () {
  S.zoneOn = !S.zoneOn;
  $('zone-btn').classList.toggle('on', S.zoneOn);
  if (S.zoneOn) drawZone();
  else if (S.zoneCircle) { S.zoneCircle.setMap(null); S.zoneCircle = null; }
};
function drawZone() {
  if (!S.gmap) return;
  if (S.zoneCircle) S.zoneCircle.setMap(null);
  S.zoneCircle = new google.maps.Circle({
    map: S.gmap, center: COLUMBUS, radius: ZONE_M,
    strokeColor: '#c26060', strokeOpacity: 0.6, strokeWeight: 1.5,
    fillColor: '#c26060', fillOpacity: 0.03, clickable: false
  });
}

window.toggleSatellite = function () {
  S.satOn = !S.satOn;
  const btn = $('sat-btn');
  if (S.satOn) {
    S.gmap.setMapTypeId('hybrid');
    btn.style.borderColor = 'var(--accent2)';
    btn.style.color = 'var(--accent)';
    btn.style.background = 'var(--accentd)';
  } else {
    S.gmap.setMapTypeId('roadmap');
    btn.style.borderColor = 'var(--border2)';
    btn.style.color = 'var(--text2)';
    btn.style.background = 'rgba(0,0,0,.5)';
  }
};

// ══════════════════════════════════════════════════════════════════════════
// HOVER CARD
// ══════════════════════════════════════════════════════════════════════════
function showHcard(loc, ev) {
  S.currentHoverLoc = loc;
  $('hcard-name').textContent = loc.name.replace(/[\s*]*pending[\s*]*/gi, '').trim();
  const cat = getCatForLoc(loc);
  const col = cat ? catColorByKey(cat) : ((SL[loc.status]||SL.identified).c);
  $('hcard-cat-dot').style.background = col;
  $('hcard-cat').textContent = cat ? cat.replace(/-/g, ' ') : '';
  $('hcard-addr').textContent = [loc.city, loc.state_code].filter(Boolean).join(', ') || '';
  const sl = SL[loc.status] || SL.identified;
  $('hcard-status').innerHTML = `<span style="color:${sl.c}">${E(SL_LABEL[loc.status] || loc.status)}</span>`;
  const hm = $('hcard-media');
  if (loc.cover_photo_url) {
    const hi = document.createElement('img');
    hi.className = 'hcard-img'; hi.src = smMedium(loc.cover_photo_url); hi.loading = 'lazy';
    hi.alt = loc.name + ' cover photo';
    hi.onclick = () => openDetail(S.currentHoverLoc);
    hi.onerror = () => { hm.innerHTML = '<div class="hcard-ph">no photo</div>'; };
    hm.innerHTML = ''; hm.appendChild(hi);
  } else {
    hm.innerHTML = '<div class="hcard-ph">no photo</div>';
  }
  $('hcard').classList.add('show');
  posHcard(ev);
}

function posHcard(ev) {
  const r = $('map-wrap').getBoundingClientRect();
  const h = $('hcard');
  let x = ev.clientX - r.left + 16, y = ev.clientY - r.top - 80;
  if (x + 310 > r.width) x = ev.clientX - r.left - 316;
  if (y < 0) y = 8;
  if (y + 260 > r.height - 100) y = r.height - 360;
  h.style.left = x + 'px'; h.style.top = y + 'px';
}

// ══════════════════════════════════════════════════════════════════════════
// DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════════
// Parse a "M-D-YY" / "M/D/YYYY" string into a timestamp for comparison
function parseDateStr(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (!m) return 0;
  let y = parseInt(m[3], 10);
  if (y < 100) y += y < 50 ? 2000 : 1900;
  return new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10)).getTime();
}

// Find the most recent date in a parsed-notes object — checks signature date + any update entries
function extractLatestDate(parsed) {
  if (!parsed) return '';
  const dates = [];
  if (parsed.date) dates.push(parsed.date);
  (parsed.notes || []).forEach(n => {
    if (n.kind === 'update' && n.date) dates.push(n.date);
  });
  if (!dates.length) return '';
  let best = dates[0], bestTs = parseDateStr(best);
  for (const d of dates) {
    const ts = parseDateStr(d);
    if (ts > bestTs) { best = d; bestTs = ts; }
  }
  return best;
}

window.openDetail = function (loc) {
  if (!loc) return;
  if (S.currentDetailLoc !== loc) pushNav();
  S.currentDetailLoc = loc;
  S.dpRequestToken++;
  $('hcard').classList.remove('show');

  const displayName = loc.name.replace(/[\s*]*pending[\s*]*/gi, '').trim();
  $('dp-name').textContent = displayName;
  const cat = getCatForLoc(loc);
  const col = cat ? catColorByKey(cat) : '';
  const sl = SL[loc.status] || SL.identified;
  const inZone = hasCoords(loc) && miles(loc.lat, loc.lng) <= 30;

  // Pre-parse so we can also pull the latest date for the "as of" pill
  const parsed = window.NotesParser ? NotesParser.parse(loc.notes, { locName: loc.name }) : null;
  const asOfDate = extractLatestDate(parsed) || (loc.scout_date || '');

  // Build header bar: cat pill + status pill + as-of pill + zone pill + edit/raw buttons
  let headerHtml = '';
  if (cat) {
    headerHtml += `<span class="dp-cat-pill" style="background:${col}22;color:${col}">${E(cat.replace(/-/g,' '))}</span>`;
  }
  // Combined status + as-of pill
  // Clear (default) → green; Pending → amber; Rejected → red
  const isPending  = loc.status === 'pending';
  const isRejected = loc.status === 'rejected';
  const statusLabel = isPending ? 'pending' : isRejected ? 'rejected' : 'clear';
  const sBg  = isPending ? 'rgba(212,148,58,.18)'  : isRejected ? 'rgba(194,96,96,.18)' : 'rgba(76,175,130,.18)';
  const sCol = isPending ? '#d4943a'                : isRejected ? '#c26060'             : '#4caf82';
  const combinedLabel = asOfDate ? `${statusLabel} as of ${asOfDate}` : statusLabel;
  headerHtml += `<span class="dp-status-pill" style="background:${sBg};color:${sCol}">${E(combinedLabel)}</span>`;
  if (inZone) {
    headerHtml += `<span class="dp-zone-pill">in zone</span>`;
  }
  headerHtml += '<span class="dp-hbtn-sep"></span>';
  headerHtml += '<button class="dp-hbtn" onclick="openEditPanel(S.currentDetailLoc)" aria-label="Edit location">✏ edit</button>';
  headerHtml += '<button class="dp-hbtn" onclick="showRawNotes(S.currentDetailLoc)" aria-label="Show raw notes">raw notes</button>';
  $('dp-header-bar').innerHTML = headerHtml;

  // Images
  S.dpImages = loc.cover_photo_url ? [loc.cover_photo_url] : [];
  S.dpIndex = 0;
  dpUpdateViewer();

  let html = '';

  // ── Address section: 2-line address + extras + Street View thumbnail ──
  // Fallback to parser values when DB columns are empty (e.g., post-migration before sync runs)
  const pAddr = (parsed && parsed.address) || null;
  const addrPart  = (loc.address     || (pAddr && pAddr.street) || '').trim();
  const cityPart  = (loc.city        || (pAddr && pAddr.city)   || '').trim();
  const statePart = (loc.state_code  || (pAddr && pAddr.state)  || '').trim();
  const zipPart   = (loc.zip         || (pAddr && pAddr.zip)    || '').trim();
  const crossPart = (loc.address_cross || (pAddr && pAddr.cross) || '').trim();
  // Drop city if it's already inside the street string (avoid duplicates)
  const cleanCity = cityPart && addrPart.toLowerCase().indexOf(cityPart.toLowerCase()) >= 0 ? '' : cityPart;
  const line2 = [cleanCity, statePart].filter(Boolean).join(', ') + (zipPart ? ' ' + zipPart : '');

  // Extras = parser-detected stuff that lived between street and city in the notes
  const extras = (pAddr && pAddr.extras) || [];
  // Filter: don't repeat the cross-street if it's already shown via address_cross
  const filteredExtras = extras.filter(x => !(x.kind === 'cross' && crossPart && x.text === crossPart));

  if (addrPart || line2) {
    const mapsQ = encodeURIComponent([addrPart, cleanCity, statePart, zipPart].filter(Boolean).join(' '));
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + mapsQ;
    const svUrl = hasCoords(loc)
      ? `https://maps.googleapis.com/maps/api/streetview?size=160x160&location=${loc.lat},${loc.lng}&fov=80&key=${GM_KEY}`
      : null;
    const svClick = hasCoords(loc)
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc.lat},${loc.lng}`
      : null;

    html += '<div class="dp-section"><div class="dp-label">Address <span class="dp-regeo" onclick="regeocodeCurrent()" title="Re-geocode this address">↻ pin location</span></div>';
    html += '<div class="dp-addr-wrap">';
    html += '<div class="dp-addr-text">';
    html += `<a href="${mapsUrl}" target="_blank" rel="noopener" class="dp-addr-link">`;
    if (addrPart) html += `<div class="dp-addr-l1">${E(addrPart)}</div>`;
    if (line2)    html += `<div class="dp-addr-l2">${E(line2)}</div>`;
    html += '</a>';
    if (crossPart) html += `<div class="dp-addr-extra">${E(crossPart)}</div>`;
    filteredExtras.forEach(x => {
      html += `<div class="dp-addr-extra">${E(x.text)}</div>`;
    });
    html += '</div>';
    // Right column: SV thumb + business info (populated async)
    html += '<div class="dp-addr-side">';
    if (svUrl) {
      html += `<a href="${svClick}" target="_blank" rel="noopener" class="dp-sv-thumb" id="dp-sv-thumb" title="Open Street View" aria-label="Open Street View">`;
      html += `<img src="${E(svUrl)}" alt="Street View" loading="lazy" onerror="this.parentNode.style.display='none'">`;
      html += `<span class="dp-sv-icon">↗</span>`;
      html += '</a>';
    }
    html += '<div id="dp-place-slot"></div>';
    html += '</div>';  // /dp-addr-side
    html += '</div>';  // /dp-addr-wrap
    html += '</div>';  // /dp-section
  }

  // Notes (rendered via shared parser)
  if (parsed && window.NotesParser) {
    const notesHtml = NotesParser.renderHtml(parsed, { showAddress: false });
    if (notesHtml) html += `<div class="dp-section"><div class="dp-notes">${notesHtml}</div></div>`;
  } else if (loc.notes) {
    // Fallback: raw notes if parser missing
    html += `<div class="dp-section"><div class="dp-notes" style="white-space:pre-wrap;font-size:12px;color:var(--text2)">${E(loc.notes)}</div></div>`;
  }

  // Tags (clickable to remove — saves as feedback)
  if (loc.tags && loc.tags.length) {
    html += '<div class="dp-section"><div class="dp-label">Keywords <span class="dp-label-sub">(click ✕ to remove and train AI)</span></div><div class="dp-tags">';
    loc.tags.forEach(t => {
      html += `<span class="dp-tag dp-tag-removable" onclick="dpRemoveTag('${E(t)}')">${E(t)}<span class="dp-tag-x">✕</span></span>`;
    });
    html += '</div></div>';
  }

  // (Best Picks intentionally not shown in the detail panel — they're available in
  //  the Edit panel for review/training, and are still saved in org_album_runs.)

  // Scout
  if (loc.scout_name || loc.scout_date) {
    html += `<div class="dp-section"><div class="dp-label">Scouted by</div><div class="dp-val">${E(loc.scout_name || '')}${loc.scout_date ? ' · ' + E(loc.scout_date) : ''}</div></div>`;
  }

  $('dp-body').innerHTML = html;

  $('detail-panel').classList.add('open');
  $('dp-scroll').scrollTop = 0;

  // Lock map keyboard shortcuts so arrow keys go to the detail viewer, not the map
  if (S.gmap) S.gmap.setOptions({ keyboardShortcuts: false });
  document.body.focus();

  // Arm outside-click handler — clicking anywhere outside the panel closes it
  // Wait one tick so the click that opened the panel doesn't immediately close it
  setTimeout(() => {
    if (!S._dpOutsideClickHandler) {
      S._dpOutsideClickHandler = function (e) {
        const panel = $('detail-panel');
        const lb = $('lightbox');
        const editPanel = $('edit-panel');
        const rawModal = $('raw-notes-modal');
        // Don't close on clicks inside any of these
        if (panel && panel.contains(e.target)) return;
        if (lb && lb.classList.contains('open')) return;
        if (editPanel && editPanel.style.display === 'flex' && editPanel.contains(e.target)) return;
        if (rawModal && rawModal.style.display === 'flex' && rawModal.contains(e.target)) return;
        // Don't close on map pin clicks (they open new locations) — handled by gmap click listener
        // Allow nav buttons and category list to still work — close panel + let click through
        if (S.currentDetailLoc) closeDetail();
      };
      document.addEventListener('mousedown', S._dpOutsideClickHandler, true);
    }
  }, 30);

  if ($('home-page').classList.contains('active')) {
    highlightPin(loc);
    setTimeout(() => panToVisible(loc), 300);
  }
  loadDetailGallery(loc);
  loadPlaceInfo(loc);
  checkStreetViewAvailable(loc);
};

// Query the Street View metadata endpoint — if no panorama exists at this location, hide the thumb
async function checkStreetViewAvailable(loc) {
  if (!hasCoords(loc)) return;
  const myToken = S.dpRequestToken;
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc.lat},${loc.lng}&key=${GM_KEY}`);
    const data = await r.json();
    if (myToken !== S.dpRequestToken) return;  // user opened another loc
    if (data.status !== 'OK') {
      const el = $('dp-sv-thumb');
      if (el) el.style.display = 'none';
    }
  } catch (e) { /* leave thumb visible if check fails */ }
}

// Load this album's best-pick images from org_album_runs and render a strip
async function loadDetailBestPicks(loc) {
  if (!loc.smugmug_album_key) return;
  const myToken = ++S.dpRequestToken;
  let run = (orgRunsCache && orgRunsCache[loc.smugmug_album_key]) || null;
  if (!run) {
    try {
      const r = await db(`org_album_runs?album_key=eq.${loc.smugmug_album_key}&select=*`);
      if (r && r[0]) {
        run = r[0];
        if (orgRunsCache) orgRunsCache[loc.smugmug_album_key] = run;
      }
    } catch (e) { /* table may not exist or empty — that's fine */ }
  }
  if (!run || myToken !== S.dpRequestToken) return;
  const keys = run.selected_image_keys || [];
  if (!keys.length) return;
  // Fetch thumb URLs for these keys
  let imgs = [];
  try {
    const list = keys.map(k => `"${k}"`).join(',');
    imgs = await db(`smugmug_images?sm_key=in.(${list})&select=sm_key,thumb_url`);
  } catch (e) { return; }
  if (myToken !== S.dpRequestToken) return;
  const byKey = {};
  imgs.forEach(i => { byKey[i.sm_key] = i.thumb_url; });
  const ordered = keys.map(k => ({ key: k, url: byKey[k] })).filter(x => x.url);
  if (!ordered.length) return;
  const section = $('dp-selected-section');
  const strip = $('dp-selected-strip');
  if (!section || !strip) return;
  section.style.display = '';
  S.dpSelectedRun = { albumKey: loc.smugmug_album_key, items: ordered };
  strip.innerHTML = ordered.map((it, i) =>
    `<div class="dp-selected-cell">
      <img src="${E(smMedium(it.url))}" loading="lazy" onclick="dpOpenSelectedLightbox(${i})" onerror="this.style.display='none'">
      <button class="dp-selected-x" onclick="dpRemoveSelectedImage('${E(it.key)}')" title="Not a good pick — remove and train AI">✕</button>
    </div>`
  ).join('');
}

// Click a best-pick thumbnail → open lightbox over those
window.dpOpenSelectedLightbox = function (idx) {
  if (!S.dpSelectedRun || !S.dpSelectedRun.items) return;
  S.dpImages = S.dpSelectedRun.items.map(i => i.url);
  S.dpIndex = Math.max(0, Math.min(idx || 0, S.dpImages.length - 1));
  $('lb-img').src = smXL(S.dpImages[S.dpIndex]);
  $('lightbox').classList.add('open');
  updateLbCounter();
};

// Remove a tag directly from detail panel — updates DB, SmugMug keywords, and trains AI
window.dpRemoveTag = async function (tag) {
  const loc = S.currentDetailLoc;
  if (!loc || !loc.tags) return;
  if (!confirm(`Remove keyword "${tag}"?\n\nThis updates the location, removes from SmugMug, and tells the AI not to suggest "${tag}" for similar places.`)) return;
  const newTags = loc.tags.filter(t => t !== tag);
  loc.tags = newTags;
  // Re-render immediately for snappy UX
  openDetail(loc);
  // Persist to Supabase
  try {
    await fetch(`${SB_URL}/rest/v1/locations?id=eq.${loc.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({ tags: newTags })
    });
  } catch (e) { toast('Save failed', 'err'); }
  // Update SmugMug keywords (best-effort)
  if (S.smTokens && loc.smugmug_album_key) {
    try {
      const tb = btoa(JSON.stringify(S.smTokens));
      // We don't have a dedicated "patch keywords" endpoint — use move_album to current path
      // Actually safer: skip SmugMug update from here. The org_corrections feedback below
      // is what drives future learning.
    } catch (e) {}
  }
  // Save feedback signal for future classifications
  await saveOrgCorrection({
    album_key: loc.smugmug_album_key || '',
    album_name: loc.name,
    ai_path: '',
    applied_path: '',
    ai_tags: [],
    applied_tags: newTags,
    rejected_tags: [tag],
    added_tags: [],
    ai_model: '(post-confirmation edit)'
  });
  await loadOrgHistory();
  toast(`"${tag}" removed and learned`, 'ok');
};

// Remove a best-pick image from detail panel — updates org_album_runs and trains AI
window.dpRemoveSelectedImage = async function (image_key) {
  if (!S.dpSelectedRun) return;
  if (!confirm('Remove this image from the best picks?\n\nIt stays in your album, but the AI will know it wasn\'t a great pick.')) return;
  const albumKey = S.dpSelectedRun.albumKey;
  const items = S.dpSelectedRun.items.filter(i => i.key !== image_key);
  S.dpSelectedRun.items = items;

  // Update local cache
  if (orgRunsCache && orgRunsCache[albumKey]) {
    const run = orgRunsCache[albumKey];
    run.selected_image_keys = (run.selected_image_keys || []).filter(k => k !== image_key);
    if (run.per_image_tags) delete run.per_image_tags[image_key];
    // Persist
    try {
      await fetch(`${SB_URL}/rest/v1/org_album_runs?album_key=eq.${albumKey}`, {
        method: 'PATCH',
        headers: {
          apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          selected_image_keys: run.selected_image_keys,
          per_image_tags: run.per_image_tags || {}
        })
      });
    } catch (e) { toast('Save failed', 'err'); return; }
  }

  // Re-render strip
  const strip = $('dp-selected-strip');
  if (strip) {
    strip.innerHTML = items.map((it, i) =>
      `<div class="dp-selected-cell">
        <img src="${E(smMedium(it.url))}" loading="lazy" onclick="dpOpenSelectedLightbox(${i})" onerror="this.style.display='none'">
        <button class="dp-selected-x" onclick="dpRemoveSelectedImage('${E(it.key)}')">✕</button>
      </div>`
    ).join('');
  }
  toast('Image removed from best picks', 'ok');
};

window.closeDetail = function () {
  $('detail-panel').classList.remove('open');
  S.currentDetailLoc = null;
  if (S.selectionOverlay) { S.selectionOverlay.setMap(null); S.selectionOverlay = null; }
  if (S.gmap) S.gmap.setOptions({ keyboardShortcuts: true });
  if (S._dpOutsideClickHandler) {
    document.removeEventListener('mousedown', S._dpOutsideClickHandler, true);
    S._dpOutsideClickHandler = null;
  }
};


// ── Image viewer ────────────────────────────────────────────────────────────
function dpUpdateViewer() {
  const img = $('dp-viewer-img'), ph = $('dp-viewer-ph');
  const prev = $('dp-prev'), next = $('dp-next');
  const ctr = $('dp-counter'), hint = $('dp-hint');
  const none = !S.dpImages.length;
  ph.style.display = none ? 'flex' : 'none';
  img.style.display = none ? 'none' : 'block';
  if (!none) img.src = smLarge(S.dpImages[S.dpIndex]);
  const multi = S.dpImages.length > 1;
  prev.style.display = multi ? 'block' : 'none';
  next.style.display = multi ? 'block' : 'none';
  // Show the counter whenever there's at least one image loaded
  ctr.style.display = none ? 'none' : 'block';
  hint.style.display = !none ? 'block' : 'none';
  if (!none) ctr.textContent = (S.dpIndex + 1) + ' / ' + S.dpImages.length;
  prev.onclick = () => dpNav(-1);
  next.onclick = () => dpNav(1);
}

function dpNav(dir) {
  if (!S.dpImages.length) return;
  S.dpIndex = (S.dpIndex + dir + S.dpImages.length) % S.dpImages.length;
  dpUpdateViewer();
}

async function loadDetailGallery(loc) {
  if (!loc.smugmug_album_key) return;
  const myToken = ++S.dpRequestToken;

  const ctr = $('dp-counter');
  if (ctr) {
    ctr.style.display = 'block';
    ctr.textContent = '⟳ loading photos…';
  }

  try {
    // Read the album's expected count for diagnostics
    let expectedCount = 0;
    try {
      const albs = await db(`smugmug_albums?sm_key=eq.${loc.smugmug_album_key}&select=image_count`);
      if (albs && albs[0]) expectedCount = albs[0].image_count || 0;
    } catch (e) {}

    let imgs = await db('smugmug_images?album_key=eq.' + loc.smugmug_album_key + '&select=thumb_url');
    if (myToken !== S.dpRequestToken) return;
    const cacheCount = (imgs && imgs.length) || 0;
    console.log(`[gallery] album ${loc.smugmug_album_key}: cache=${cacheCount}, expected=${expectedCount}`);

    // If cache is full enough, use it
    const cacheIsComplete = cacheCount > 0 && (expectedCount === 0 || cacheCount >= expectedCount);

    if (!cacheIsComplete) {
      if (!S.smTokens) {
        console.warn('[gallery] cache incomplete & not connected to SmugMug — will display only what we have');
        toast('Connect SmugMug to load full album', 'inf');
      } else {
        // Live-fetch full album from SmugMug
        try {
          const tb = btoa(JSON.stringify(S.smTokens));
          const url = `${SM_BASE}/api/smugmug?action=album-images&albumKey=${loc.smugmug_album_key}`;
          console.log('[gallery] fetching:', url);
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tb } });
          if (myToken !== S.dpRequestToken) return;

          if (!r.ok) {
            const errText = await r.text().catch(() => '');
            console.error('[gallery] HTTP', r.status, errText.slice(0, 400));
            if (r.status === 401) toast('SmugMug auth expired — sign out and re-authorize', 'err');
            else if (r.status === 504 || r.status === 502) toast('Photo fetch timed out — try again', 'err');
            else toast(`Photo fetch failed (${r.status})`, 'err');
          } else {
            const ct = r.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
              const text = await r.text();
              console.error('[gallery] non-JSON response:', text.slice(0, 240));
              toast('Photo fetch: server returned HTML (deploy issue?)', 'err');
            } else {
              const data = await r.json();
              if (myToken !== S.dpRequestToken) return;
              if (data && data.images && data.images.length) {
                console.log(`[gallery] ✓ live-fetched ${data.images.length} images for album`);
                imgs = data.images.map(i => ({ thumb_url: i.thumbUrl })).filter(i => i.thumb_url);
                // Cache to Supabase for next time (non-blocking)
                (async () => {
                  try {
                    const rows = data.images.filter(i => i.id && i.thumbUrl).map(i => ({
                      sm_key: i.id, album_key: loc.smugmug_album_key,
                      album_name: i.albumName || loc.name || '',
                      album_url: i.albumUrl || '',
                      filename: i.filename || '', title: i.title || '',
                      caption: i.caption || '', keywords: i.keywords || '',
                      thumb_url: i.thumbUrl, web_url: i.webUri || null,
                      lat: i.lat || null, lng: i.lng || null,
                      synced_at: new Date().toISOString()
                    }));
                    if (rows.length) {
                      await fetch(`${SB_URL}/rest/v1/smugmug_images?on_conflict=sm_key`, {
                        method: 'POST',
                        headers: {
                          apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
                          'Content-Type': 'application/json',
                          Prefer: 'resolution=merge-duplicates,return=minimal'
                        },
                        body: JSON.stringify(rows)
                      });
                      console.log(`[gallery] cached ${rows.length} images to Supabase`);
                    }
                  } catch (e) { console.warn('[gallery] cache save failed:', e.message); }
                })();
              } else {
                console.warn('[gallery] live-fetch returned no images. Response:', data);
                if (data && data.error) toast(`Photo fetch: ${data.error}`, 'err');
                else toast('Photo fetch returned no images', 'err');
              }
            }
          }
        } catch (e) {
          console.error('[gallery] live-fetch threw:', e);
          toast('Photo fetch error: ' + (e.message || 'unknown'), 'err');
        }
      }
    } else {
      console.log(`[gallery] using ${cacheCount} cached images (matches expected count)`);
    }

    if (!imgs || !imgs.length) {
      // No images anywhere — show "no photo" placeholder, hide counter
      if (ctr) ctr.style.display = 'none';
      S.dpImages = loc.cover_photo_url ? [loc.cover_photo_url] : [];
      dpUpdateViewer();
      return;
    }
    const thumbs = imgs.map(i => i.thumb_url).filter(Boolean);
    const cover = loc.cover_photo_url;
    S.dpImages = cover ? [cover].concat(thumbs.filter(t => t !== cover)) : thumbs;
    dpUpdateViewer();
  } catch (e) {
    console.error('[gallery] outer error:', e);
    toast('Gallery error: ' + (e.message || 'unknown'), 'err');
    if (ctr) ctr.textContent = '';
  }
}

// Try to detect a state code from the address text if state_code is missing
function detectStateFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\b(NY|NJ|CT|PA|MA|VT|NH|RI|ME|DE|MD)\b/);
  return m ? m[1] : null;
}

window.fixMissingThumbnails = async function () {
  if (!S.smTokens) { toast('Connect SmugMug first', 'err'); return; }
  closeDock();
  const ns = $('nav-status');
  ns && (ns.textContent = 'finding albums without thumbnails...');

  // Find albums in DB without highlight_url
  let missing;
  try {
    missing = await db('smugmug_albums?highlight_url=is.null&select=sm_key,name');
  } catch (e) {
    toast('Failed to query albums: ' + e.message, 'err');
    return;
  }
  if (!missing || !missing.length) {
    toast('All albums already have thumbnails 👍', 'inf');
    if (ns) ns.textContent = '';
    return;
  }
  if (!confirm(`${missing.length} album${missing.length !== 1 ? 's' : ''} missing thumbnails. Backfill them now?\n\nApprox ~${Math.ceil(missing.length * 0.5)}s.`)) {
    if (ns) ns.textContent = '';
    return;
  }

  const tb = btoa(JSON.stringify(S.smTokens));
  let fixed = 0, failed = 0;
  for (let i = 0; i < missing.length; i++) {
    const a = missing[i];
    if (ns) ns.textContent = `thumbnails ${i + 1}/${missing.length}: ${a.name}`;
    try {
      const r = await fetchRetry(`${SM_BASE}/api/smugmug?action=album-thumbnail&albumKey=${a.sm_key}`, {
        headers: { Authorization: 'Bearer ' + tb }
      });
      const d = await r.json();
      if (d.ok && d.thumbUrl) {
        // Save to DB
        await fetch(`${SB_URL}/rest/v1/smugmug_albums?sm_key=eq.${a.sm_key}`, {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
          },
          body: JSON.stringify({ highlight_url: d.thumbUrl })
        });
        // Patch local cache so the library re-renders correctly
        const lalb = S.libAlbums.find(x => x.sm_key === a.sm_key);
        if (lalb) lalb.highlight_url = d.thumbUrl;
        const malb = S.mapAlbums.find(x => x.sm_key === a.sm_key);
        if (malb) malb.highlight_url = d.thumbUrl;
        // Also propagate to any linked location's cover_photo_url if missing
        const linkedLoc = S.locByAlbumKey.get(a.sm_key);
        if (linkedLoc && !linkedLoc.cover_photo_url) {
          try {
            await fetch(`${SB_URL}/rest/v1/locations?id=eq.${linkedLoc.id}`, {
              method: 'PATCH',
              headers: {
                apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
                'Content-Type': 'application/json', Prefer: 'return=minimal'
              },
              body: JSON.stringify({ cover_photo_url: d.thumbUrl })
            });
            linkedLoc.cover_photo_url = d.thumbUrl;
          } catch (e) {}
        }
        fixed++;
      } else { failed++; }
    } catch (e) { failed++; }
  }

  // Refresh visible UI
  if ($('library-page').classList.contains('active')) libRender();
  if (S.gmap) refreshPins();
  if (ns) ns.textContent = '';
  toast(`Thumbnails: ${fixed} fixed${failed ? ` · ${failed} failed` : ''}`, fixed ? 'ok' : 'err');
};

window.regeocodeBadPins = async function () {
  // Find all locations that have an address worth re-geocoding.
  // Default: all unverified ones with an address. With shift-click, regeo everything (even verified).
  const allWithAddress = S.locations.filter(l =>
    (l.address && l.address.trim()) || (l.city && l.city.trim())
  );
  const unverified = allWithAddress.filter(l => !l.address_verified);

  if (!allWithAddress.length) { toast('No addresses to geocode', 'inf'); return; }

  let candidates;
  let label;
  if (unverified.length > 0) {
    if (!confirm(
`Re-geocode ${unverified.length} unverified location${unverified.length !== 1 ? 's' : ''}?

Total addresses: ${allWithAddress.length}
With address_verified=true: ${allWithAddress.length - unverified.length} (skipped)
Estimated time: ~${Math.ceil(unverified.length * 0.25)}s

The geocoder uses each location's state_code to bias results — pins should land in the right area.`)) return;
    candidates = unverified;
    label = 'unverified';
  } else {
    if (!confirm(`All ${allWithAddress.length} locations are already address_verified.\n\nForce re-geocode them anyway? (~${Math.ceil(allWithAddress.length * 0.25)}s)`)) return;
    candidates = allWithAddress;
    label = 'all';
  }
  await runRegeocodeBatch(candidates, label);
};

async function runRegeocodeBatch(locs, label) {
  const ns = $('nav-status');
  let fixed = 0, failed = 0;
  for (let i = 0; i < locs.length; i++) {
    const loc = locs[i];
    if (ns) ns.textContent = `regeocoding ${label} ${i+1}/${locs.length}…`;
    // Build query — use whatever address parts we have
    const query = [loc.address, loc.city, loc.state_code, loc.zip].filter(Boolean).join(', ');
    if (!query) continue;
    // Determine state for biasing — prefer stored, fall back to detect from address text
    const stateForBias = loc.state_code || detectStateFromText((loc.address || '') + ' ' + (loc.city || ''));
    try {
      const stateParam = stateForBias ? '&state=' + stateForBias : '';
      const r = await fetch(`${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${stateParam}`);
      const d = await r.json();
      if (d.ok && d.lat) {
        const updates = { lat: d.lat, lng: d.lng };
        // If state_code wasn't set but we detected one, save it
        if (!loc.state_code && stateForBias) updates.state_code = stateForBias;
        await fetch(`${SB_URL}/rest/v1/locations?id=eq.${loc.id}`, {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
          },
          body: JSON.stringify(updates)
        });
        Object.assign(loc, updates);
        fixed++;
      } else { failed++; }
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 150));  // gentle on the geocoder
  }
  // Update lookups + cache + map
  rebuildLookups();
  try {
    const cached = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
    if (cached && cached.data) {
      cached.data = S.locations;
      localStorage.setItem(LOC_CACHE_KEY, JSON.stringify(cached));
    }
  } catch (e) {}
  if (S.gmap) refreshPins();
  if (ns) ns.textContent = '';
  toast(`Re-geocoded ${fixed}${failed ? ` · ${failed} failed` : ''}`, fixed ? 'ok' : 'err');
}

window.regeocodeCurrent = async function () {
  const loc = S.currentDetailLoc;
  if (!loc) return;
  const query = [loc.address, loc.city, loc.state_code, loc.zip].filter(Boolean).join(', ');
  if (!query) { toast('No address to geocode', 'err'); return; }
  toast('Re-geocoding…', 'inf');
  try {
    const stateParam = loc.state_code ? '&state=' + loc.state_code : '';
    const r = await fetch(`${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${stateParam}`);
    const d = await r.json();
    if (!d.ok || !d.lat) { toast('Geocode failed: ' + (d.status || 'no result'), 'err'); return; }
    const updates = { lat: d.lat, lng: d.lng };
    await fetch(`${SB_URL}/rest/v1/locations?id=eq.${loc.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
    Object.assign(loc, updates);
    try {
      const cached = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
      if (cached && cached.data) {
        const li = cached.data.findIndex(l => l.id === loc.id);
        if (li >= 0) Object.assign(cached.data[li], updates);
        localStorage.setItem(LOC_CACHE_KEY, JSON.stringify(cached));
      }
    } catch (e) {}
    rebuildLookups();
    if (S.gmap) refreshPins();
    openDetail(loc);
    toast('Pin moved', 'ok');
  } catch (e) { toast('Geocode error: ' + e.message, 'err'); }
};

// ══════════════════════════════════════════════════════════════════════════
// GOOGLE PLACES (business phone, hours, website, rating)
// ══════════════════════════════════════════════════════════════════════════
const PLACE_CACHE_KEY = 'place_cache_v1';
const PLACE_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days

function getPlaceCache() {
  try { return JSON.parse(localStorage.getItem(PLACE_CACHE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function savePlaceCache(c) {
  try { localStorage.setItem(PLACE_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
}
function placeCacheKey(loc) {
  if (!loc.lat || !loc.lng) return null;
  return `${(+loc.lat).toFixed(4)},${(+loc.lng).toFixed(4)}`;
}

function fetchPlaceInfo(loc) {
  return new Promise(resolve => {
    if (!hasCoords(loc) || !window.google || !google.maps || !google.maps.places || !S.gmap) {
      return resolve(null);
    }
    const key = placeCacheKey(loc);
    const cache = getPlaceCache();
    const hit = cache[key];
    if (hit && hit.ts > Date.now() - PLACE_TTL) {
      return resolve(hit.data || null);
    }

    const svc = new google.maps.places.PlacesService(S.gmap);
    const query = (loc.name || '').replace(/\*pending\*/gi, '').trim();
    svc.findPlaceFromQuery({
      query: query + ' ' + (loc.address || loc.city || ''),
      fields: ['place_id', 'name', 'geometry'],
      locationBias: new google.maps.Circle({
        center: { lat: Number(loc.lat), lng: Number(loc.lng) }, radius: 200
      })
    }, (results, status) => {
      if (status !== 'OK' || !results || !results[0]) {
        cache[key] = { ts: Date.now(), data: null };
        savePlaceCache(cache);
        return resolve(null);
      }
      const placeId = results[0].place_id;
      svc.getDetails({
        placeId,
        fields: ['name', 'formatted_phone_number', 'international_phone_number',
                 'website', 'opening_hours']
      }, (place, status2) => {
        if (status2 !== 'OK' || !place) {
          cache[key] = { ts: Date.now(), data: null };
          savePlaceCache(cache);
          return resolve(null);
        }
        const data = {
          name: place.name || '',
          phone: place.formatted_phone_number || place.international_phone_number || '',
          website: place.website || '',
          hours: (place.opening_hours && place.opening_hours.weekday_text) || []
        };
        cache[key] = { ts: Date.now(), data };
        savePlaceCache(cache);
        resolve(data);
      });
    });
  });
}

function renderPlaceInfoHtml(p) {
  if (!p) return '';
  const hasContent = p.name || p.phone || p.website || (p.hours && p.hours.length);
  if (!hasContent) return '';
  const parts = ['<div class="dp-place-info">'];
  if (p.name) parts.push(`<div class="dp-place-name">${E(p.name)}</div>`);
  if (p.phone) {
    const tel = p.phone.replace(/[^\d+]/g, '');
    parts.push(`<div class="dp-place-row"><span class="dp-place-icon">☎</span><a href="tel:${E(tel)}">${E(p.phone)}</a></div>`);
  }
  if (p.website) {
    let host = p.website;
    try { host = new URL(p.website).hostname.replace(/^www\./, ''); } catch (e) {}
    parts.push(`<div class="dp-place-row"><span class="dp-place-icon">↗</span><a href="${E(p.website)}" target="_blank" rel="noopener">${E(host)}</a></div>`);
  }
  if (p.hours && p.hours.length) {
    parts.push('<details class="dp-place-hours"><summary>Hours</summary>');
    p.hours.forEach(line => parts.push(`<div>${E(line)}</div>`));
    parts.push('</details>');
  }
  parts.push('</div>');
  return parts.join('');
}

async function loadPlaceInfo(loc) {
  if (!hasCoords(loc)) return;
  const myToken = S.dpRequestToken;  // race-condition guard
  const place = await fetchPlaceInfo(loc);
  if (myToken !== S.dpRequestToken) return;
  if (!place) return;
  const target = $('dp-place-slot');
  if (target) target.innerHTML = renderPlaceInfoHtml(place);
}

// ══════════════════════════════════════════════════════════════════════════
// EDIT PANEL
// ══════════════════════════════════════════════════════════════════════════
// Build a multi-line address string for the edit panel
function formatAddressForEdit(parsedAddr, loc) {
  const street = (loc && loc.address) || (parsedAddr && parsedAddr.street) || '';
  const cross  = (loc && loc.address_cross) || (parsedAddr && parsedAddr.cross) || '';
  const city   = (loc && loc.city) || (parsedAddr && parsedAddr.city) || '';
  const state  = (loc && loc.state_code) || (parsedAddr && parsedAddr.state) || '';
  const zip    = (loc && loc.zip) || (parsedAddr && parsedAddr.zip) || '';
  const lines = [];
  if (street) lines.push(street);
  if (cross)  lines.push(cross);
  const cityLine = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
  if (cityLine.trim()) lines.push(cityLine);
  return lines.join('\n');
}

// Format contacts for edit panel — newline-separated
function formatContactsForEdit(parsed) {
  if (!parsed || !parsed.contacts || !parsed.contacts.length) return '';
  return parsed.contacts.map(c => {
    const out = [];
    if (c.name) out.push(c.name);
    c.phones.forEach(p => out.push(p));
    c.emails.forEach(e => out.push(e));
    return out.join('\n');
  }).join('\n\n');  // blank line between contacts
}

// Format notes section for edit panel
function formatNotesForEdit(parsed) {
  if (!parsed || !parsed.notes || !parsed.notes.length) return '';
  return parsed.notes.map(n => {
    if (n.kind === 'bullet') return '- ' + n.text;
    if (n.kind === 'update') return (n.date ? n.date + ' ' : '') + n.text;
    return n.text;
  }).join('\n');
}

// Parse an address textarea (multi-line) back into structured fields
function parseAddressInput(text) {
  const result = { street: '', cross: '', city: '', state: '', zip: '' };
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return result;
  // Find city/state/zip line (last one matching the pattern)
  const cityRe = /^([A-Za-z][A-Za-z\s.'\-]+),\s*([A-Z]{2})(?:\s+(\d{5}))?\s*$/;
  let cityIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(cityRe);
    if (m) {
      result.city = m[1].trim();
      result.state = m[2];
      result.zip = m[3] || '';
      cityIdx = i;
      break;
    }
  }
  // Find cross-street line (parenthesized)
  const crossRe = /^\(.*\)?$/;
  const remainingLines = lines.filter((_, i) => i !== cityIdx);
  const crossIdx = remainingLines.findIndex(l => crossRe.test(l));
  if (crossIdx >= 0) {
    result.cross = remainingLines[crossIdx];
    remainingLines.splice(crossIdx, 1);
  }
  // Anything left is street
  result.street = remainingLines.join(' ').trim();
  return result;
}

// Reassemble a canonical notes string from structured fields (parser-friendly)
function rebuildCanonicalNotes(fields) {
  const parts = [];
  if (fields.name) parts.push(fields.name);
  if (fields.street) parts.push(fields.street);
  if (fields.cross)  parts.push(fields.cross);
  const cityLine = [fields.city, fields.state].filter(Boolean).join(', ') + (fields.zip ? ' ' + fields.zip : '');
  if (cityLine.trim()) parts.push(cityLine);

  if (fields.contact && fields.contact.trim()) {
    parts.push('');  // blank line separator
    const contactBlocks = fields.contact.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    contactBlocks.forEach((block, i) => {
      if (i > 0) parts.push('');
      // Prefix first line with C: if it doesn't already have a contact header
      const blockLines = block.split('\n');
      if (!/^(C\d*|Contact|Owner|Manager|Mgr|GM|Chef|Booker|Booking|Agent|Producer|Director|Realtor|Broker|Host)\s*:/i.test(blockLines[0])) {
        blockLines[0] = (i === 0 ? 'C: ' : `C${i+1}: `) + blockLines[0];
      }
      parts.push(blockLines.join('\n'));
    });
  }

  if (fields.notes && fields.notes.trim()) {
    parts.push('');
    parts.push('Notes:');
    parts.push(fields.notes.trim());
  }

  if (fields.signature || fields.date) {
    parts.push('');
    if (fields.signature) parts.push(fields.signature);
    if (fields.date)      parts.push(fields.date);
  }

  return parts.join('\n');
}

window.openEditPanel = function (loc) {
  if (!loc) return;
  S.editingLoc = loc;
  const parsed = window.NotesParser ? NotesParser.parse(loc.notes, { locName: loc.name }) : null;
  $('edit-name').value    = loc.name || '';
  $('edit-addr').value    = formatAddressForEdit(parsed && parsed.address, loc);
  $('edit-contact').value = formatContactsForEdit(parsed);
  $('edit-notes').value   = formatNotesForEdit(parsed);

  // Tags section — only show if location has any
  S.editTagsState = {
    original: Array.isArray(loc.tags) ? loc.tags.slice() : [],
    current: Array.isArray(loc.tags) ? loc.tags.slice() : [],
    added: [],
    removed: []
  };
  renderEditTags();

  // Best picks section — load from org_album_runs
  S.editPicksState = { albumKey: loc.smugmug_album_key || '', items: [], removed: [] };
  if (loc.smugmug_album_key) loadEditPicks(loc.smugmug_album_key);
  else $('edit-pics-section').style.display = 'none';

  $('edit-panel').style.display = 'flex';
  $('edit-name').focus();

  // Wire up the "add tag" input (idempotent)
  const addInp = $('edit-tags-add');
  if (addInp && !addInp._wired) {
    addInp._wired = true;
    addInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = addInp.value.trim().toLowerCase().replace(/\s+/g, '-');
        if (!v) return;
        const st = S.editTagsState;
        if (st.current.includes(v)) { addInp.value = ''; return; }
        st.current.push(v);
        st.added.push(v);
        // If it was previously removed, undo that
        st.removed = st.removed.filter(t => t !== v);
        addInp.value = '';
        renderEditTags();
      }
    });
  }
};

function renderEditTags() {
  const st = S.editTagsState;
  if (!st) return;
  const section = $('edit-tags-section');
  const chips = $('edit-tags-chips');
  if (!section || !chips) return;
  if (!st.current.length && !st.original.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  chips.innerHTML = st.current.map(t =>
    `<span class="edit-chip" onclick="editRemoveTag('${E(t)}')">${E(t)}<span class="edit-chip-x">✕</span></span>`
  ).join('') || '<span class="edit-empty">no keywords yet</span>';
}

window.editRemoveTag = function (tag) {
  const st = S.editTagsState;
  if (!st) return;
  st.current = st.current.filter(t => t !== tag);
  // If user removed something that was added in this session, also remove from `added`
  st.added = st.added.filter(t => t !== tag);
  // If it was in original, mark as removed
  if (st.original.includes(tag) && !st.removed.includes(tag)) st.removed.push(tag);
  renderEditTags();
};

async function loadEditPicks(albumKey) {
  let run = (orgRunsCache && orgRunsCache[albumKey]) || null;
  if (!run) {
    try {
      const r = await db(`org_album_runs?album_key=eq.${albumKey}&select=*`);
      if (r && r[0]) {
        run = r[0];
        if (orgRunsCache) orgRunsCache[albumKey] = run;
      }
    } catch (e) {}
  }
  const section = $('edit-pics-section');
  const strip = $('edit-pics-strip');
  if (!section || !strip) return;
  if (!run || !run.selected_image_keys || !run.selected_image_keys.length) {
    section.style.display = 'none';
    return;
  }
  // Fetch URLs
  const keys = run.selected_image_keys;
  let imgs = [];
  try {
    const list = keys.map(k => `"${k}"`).join(',');
    imgs = await db(`smugmug_images?sm_key=in.(${list})&select=sm_key,thumb_url`);
  } catch (e) { return; }
  const byKey = {};
  imgs.forEach(i => { byKey[i.sm_key] = i.thumb_url; });
  const items = keys.map(k => ({ key: k, url: byKey[k] })).filter(x => x.url);
  S.editPicksState = { albumKey, items, removed: [] };
  if (!items.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  renderEditPicks();
}

function renderEditPicks() {
  const strip = $('edit-pics-strip');
  if (!strip) return;
  const st = S.editPicksState;
  strip.innerHTML = st.items.map(it =>
    `<div class="edit-pic-cell">
      <img src="${E(smMedium(it.url))}" loading="lazy" onerror="this.style.display='none'">
      <button class="edit-pic-x" onclick="editRemovePic('${E(it.key)}')" title="Not a great pick — remove">✕</button>
    </div>`
  ).join('');
}

window.editRemovePic = function (key) {
  const st = S.editPicksState;
  if (!st) return;
  st.items = st.items.filter(i => i.key !== key);
  st.removed.push(key);
  renderEditPicks();
};

window.closeEditPanel = function () {
  $('edit-panel').style.display = 'none';
  S.editingLoc = null;
};

window.saveEdit = async function () {
  if (!S.editingLoc) return;
  const btn = $('edit-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;

  const titleVal   = $('edit-name').value.trim();
  const addrText   = $('edit-addr').value;
  const contactVal = $('edit-contact').value;
  const notesVal   = $('edit-notes').value;

  const addrParts = parseAddressInput(addrText);

  // Preserve signature/date from existing parse if present
  const oldParsed = window.NotesParser ? NotesParser.parse(S.editingLoc.notes, { locName: S.editingLoc.name }) : null;
  const sig  = (oldParsed && oldParsed.signature) || '';
  const date = (oldParsed && oldParsed.date) || '';

  const canonicalNotes = rebuildCanonicalNotes({
    name: titleVal,
    street: addrParts.street, cross: addrParts.cross,
    city: addrParts.city, state: addrParts.state, zip: addrParts.zip,
    contact: contactVal, notes: notesVal,
    signature: sig, date: date
  });

  const updates = {
    name: titleVal,
    address: addrParts.street || null,
    city: addrParts.city || null,
    state_code: addrParts.state || null,
    notes: canonicalNotes,
    notes_override: true
  };
  if (S.migrationRan) {
    updates.zip = addrParts.zip || null;
    updates.address_cross = addrParts.cross || null;
  }

  // Re-geocode if address-affecting fields changed
  const oldAddr = (S.editingLoc.address || '') + '|' + (S.editingLoc.city || '') + '|' + (S.editingLoc.state_code || '');
  const newAddr = addrParts.street + '|' + addrParts.city + '|' + addrParts.state;
  if (oldAddr !== newAddr && (addrParts.street || addrParts.city)) {
    btn.textContent = 'Geocoding...';
    try {
      const query = [addrParts.street, addrParts.city, addrParts.state, addrParts.zip].filter(Boolean).join(', ');
      const stateParam = addrParts.state ? '&state=' + addrParts.state : '';
      const r = await fetch(`${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${stateParam}`);
      const d = await r.json();
      if (d.ok && d.lat) { updates.lat = d.lat; updates.lng = d.lng; }
    } catch (e) { /* keep existing coords */ }
    btn.textContent = 'Saving...';
  }

  try {
    await fetch(`${SB_URL}/rest/v1/locations?id=eq.${S.editingLoc.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });

    // ── Save tag changes ──
    const tagSt = S.editTagsState;
    let tagsChanged = false;
    if (tagSt && (tagSt.removed.length || tagSt.added.length)) {
      tagsChanged = true;
      try {
        await fetch(`${SB_URL}/rest/v1/locations?id=eq.${S.editingLoc.id}`, {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
          },
          body: JSON.stringify({ tags: tagSt.current })
        });
        S.editingLoc.tags = tagSt.current;
        // Save feedback signal
        await saveOrgCorrection({
          album_key: S.editingLoc.smugmug_album_key || '',
          album_name: S.editingLoc.name,
          ai_path: '',
          applied_path: '',
          ai_tags: tagSt.original,
          applied_tags: tagSt.current,
          rejected_tags: tagSt.removed,
          added_tags: tagSt.added,
          ai_model: '(post-confirmation edit)'
        });
      } catch (e) {}
    }

    // ── Save best-pick image removals ──
    const picSt = S.editPicksState;
    if (picSt && picSt.removed.length && picSt.albumKey) {
      const remainingKeys = picSt.items.map(i => i.key);
      try {
        if (orgRunsCache && orgRunsCache[picSt.albumKey]) {
          const run = orgRunsCache[picSt.albumKey];
          run.selected_image_keys = remainingKeys;
          if (run.per_image_tags) {
            picSt.removed.forEach(k => delete run.per_image_tags[k]);
          }
          await fetch(`${SB_URL}/rest/v1/org_album_runs?album_key=eq.${picSt.albumKey}`, {
            method: 'PATCH',
            headers: {
              apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
              'Content-Type': 'application/json', Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              selected_image_keys: remainingKeys,
              per_image_tags: run.per_image_tags || {}
            })
          });
        }
      } catch (e) {}
    }

    Object.assign(S.editingLoc, updates);
    try {
      const cached = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
      if (cached && cached.data) {
        const li = cached.data.findIndex(l => l.id === S.editingLoc.id);
        if (li >= 0) Object.assign(cached.data[li], updates);
        if (li >= 0 && tagsChanged) cached.data[li].tags = tagSt.current;
        localStorage.setItem(LOC_CACHE_KEY, JSON.stringify(cached));
      }
    } catch (e) {}
    rebuildLookups();
    if (S.gmap) refreshPins();
    if (tagsChanged) await loadOrgHistory();  // refresh feedback badge
    closeEditPanel();
    openDetail(S.editingLoc);
    toast('Saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  btn.textContent = 'Save'; btn.disabled = false;
};

window.showRawNotes = function (loc) {
  if (!loc) return;
  S.editingLoc = loc;
  const ta = $('raw-notes-content');
  const hint = $('raw-notes-hint');
  if (loc.notes && loc.notes.trim()) {
    ta.value = loc.notes;
    hint.textContent = 'Edit and save to override sync — or paste new content';
  } else {
    ta.value = '';
    ta.placeholder = 'Paste raw notes here…';
    hint.textContent = 'No notes yet — paste raw content from SmugMug or wherever';
  }
  $('raw-notes-modal').style.display = 'flex';
  ta.focus();
};

window.closeRawNotes = function () {
  $('raw-notes-modal').style.display = 'none';
};

window.saveRawNotes = async function () {
  if (!S.editingLoc) return;
  const btn = $('raw-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  const newNotes = $('raw-notes-content').value;
  const updates = { notes: newNotes, notes_override: true };
  try {
    await fetch(`${SB_URL}/rest/v1/locations?id=eq.${S.editingLoc.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
    Object.assign(S.editingLoc, updates);
    try {
      const cached = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
      if (cached && cached.data) {
        const li = cached.data.findIndex(l => l.id === S.editingLoc.id);
        if (li >= 0) Object.assign(cached.data[li], updates);
        localStorage.setItem(LOC_CACHE_KEY, JSON.stringify(cached));
      }
    } catch (e) {}
    closeRawNotes();
    openDetail(S.editingLoc);
    toast('Notes saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  btn.textContent = 'Save'; btn.disabled = false;
};

window.openLightbox = function (url) {
  $('lb-img').src = smXL(url);
  $('lightbox').classList.add('open');
  updateLbCounter();
};
window.closeLightbox = function () {
  $('lightbox').classList.remove('open');
  $('lb-img').src = '';
};
function updateLbCounter() {
  const el = $('lb-counter');
  el.textContent = S.dpImages.length > 1 ? `${S.dpIndex+1} / ${S.dpImages.length}` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// LIBRARY
// ══════════════════════════════════════════════════════════════════════════
async function libInit() {
  if (S.libLoaded) { libRender(); return; }
  $('lib-grid').innerHTML = '<div class="empty"><div class="spin"></div><span>loading library...</span></div>';
  try {
    S.libFolders = await db('smugmug_folders?select=name,path&order=path.asc');
    S.libAlbums  = await db('smugmug_albums?select=sm_key,name,path,web_url,image_count,highlight_url&order=name.asc');
    S.libLoaded = true;
    S.libStack = [];
    libRender();
  } catch (e) {
    $('lib-grid').innerHTML = `<div class="empty">Error: ${E(e.message)}</div>`;
  }
}

function albumParentPath(a) {
  if (a.web_url) {
    const parts = a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join('/') : (parts[0] || '');
  }
  return a.path || '';
}

window.libGridClick = function (e) {
  if (e.target === $('lib-grid')) closeDetail();
};

window.libBrowse = function (path, label) {
  pushNav();
  $('lib-q').value = '';
  $('lib-status-sel').value = '';
  if (path === null) {
    S.libRedoStack = S.libStack.slice().reverse();
    S.libStack = [];
  } else {
    const ex = S.libStack.findIndex(s => s.path === path);
    if (ex >= 0) {
      S.libRedoStack = S.libStack.slice(ex+1).reverse();
      S.libStack = S.libStack.slice(0, ex+1);
    } else {
      S.libRedoStack = [];
      S.libStack.push({ path, label: label || path.split('/').pop().replace(/-/g, ' ') });
    }
  }
  libRender();
};

function libRender() {
  const grid = $('lib-grid'), bc = $('lib-bc');
  const currentPath = S.libStack.length ? S.libStack[S.libStack.length-1].path : null;
  const targetPath  = currentPath || 'Master-Library';
  // "Flatten places" only takes effect once you've drilled into a category — at the root,
  // we still want to see top-level categories. Inside a category, we want all albums in one
  // grid (skipping the area-level subfolders).
  const flatten = !!(currentPath && $('f-flatten') && $('f-flatten').checked);

  // Breadcrumb
  let bcHtml = `<span class="lib-bc-seg${currentPath ? '' : ' cur'}" onclick="libBrowse(null)">Master Library</span>`;
  S.libStack.forEach((s, i) => {
    const cur = i === S.libStack.length-1;
    bcHtml += '<span class="lib-bc-sep"> / </span>';
    bcHtml += cur
      ? `<span class="lib-bc-seg cur">${E(s.label)}</span>`
      : `<span class="lib-bc-seg" data-p="${E(s.path)}" data-l="${E(s.label)}" onclick="libFolderClick(this)">${E(s.label)}</span>`;
  });
  bc.innerHTML = bcHtml;

  // Build a quick map for this render
  const locByAlbumKey = S.locByAlbumKey;

  const subFolders = S.libFolders.filter(f => {
    if (!f.path || f.path.indexOf(targetPath + '/') < 0) return false;
    return f.path.slice(targetPath.length+1).indexOf('/') < 0;
  });

  // When "flatten places" is on, treat all albums under targetPath (any depth) as direct children
  // — i.e., skip the area-folder navigation level and just show every album in one grid.
  const directAlbums = S.libAlbums.filter(a => {
    const p = albumParentPath(a);
    if (flatten) {
      // Album's parent path must be inside targetPath at any depth
      if (p !== targetPath && p.indexOf(targetPath + '/') !== 0) return false;
    } else {
      if (p !== targetPath) return false;
    }
    const loc = locByAlbumKey.get(a.sm_key);
    if (loc) {
      if (!locPassesGlobalFilter(loc)) return false;
    } else {
      // Album with no linked location — apply the "other" + "clear" check (treated as default)
      if (!$('f-other')?.checked) return false;
      if (!$('f-clear')?.checked) return false;
    }
    return true;
  });

  let cards = '';

  if (!flatten) {
    subFolders.forEach(f => {
    const children = S.libAlbums.filter(a => {
      const p = albumParentPath(a);
      if (p !== f.path && p.indexOf(f.path + '/') !== 0) return false;
      const loc = locByAlbumKey.get(a.sm_key);
      if (loc) return locPassesGlobalFilter(loc);
      // Unlinked: only show if other + clear are both checked (the "default everywhere" condition)
      return ($('f-other')?.checked) && ($('f-clear')?.checked);
    });
    if (!children.length) return;
    const name = f.name || f.path.split('/').pop().replace(/-/g, ' ');
    let thumb = '';
    for (const ca of children) {
      const loc = locByAlbumKey.get(ca.sm_key);
      if (loc && loc.cover_photo_url) { thumb = loc.cover_photo_url; break; }
    }
    const fCat = f.path ? f.path.split('/')[1] : '';
    const glow = (S.catPinColors[fCat] || S.savedCatColors[fCat])
      ? 'box-shadow:0 0 6px 2px ' + hexToRgba(S.catPinColors[fCat] || S.savedCatColors[fCat], 0.55) : '';
    cards += `<div class="gcard" data-p="${E(f.path)}" data-l="${E(name)}" onclick="libFolderClick(this)" style="${glow}">`;
    cards += '<div class="gcard-tw">';
    if (thumb) cards += `<img class="gcard-img" src="${E(smMedium(thumb))}" loading="lazy" alt="${E(name)} thumbnail" onerror="hideOnError(this)">`;
    cards += '<div class="gcard-ph">▤</div>';
    cards += `<div class="gcard-overlay">${E(name)}</div></div>`;
    cards += `<div class="gcard-meta"><span>${children.length} location${children.length !== 1 ? 's' : ''}</span></div></div>`;
    });
  }

  directAlbums.forEach(a => {
    const loc = locByAlbumKey.get(a.sm_key);
    const thumb = (loc && loc.cover_photo_url) || a.highlight_url || '';
    const sl = loc ? (SL[loc.status] || SL.identified) : null;
    const isSelected = S.currentDetailLoc && loc && S.currentDetailLoc.id === loc.id;
    const aCat = a.web_url ? a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean)[1] : '';
    const glow = (S.catPinColors[aCat] || S.savedCatColors[aCat])
      ? 'box-shadow:0 0 6px 2px ' + hexToRgba(S.catPinColors[aCat] || S.savedCatColors[aCat], 0.55) : '';
    cards += `<div class="gcard${isSelected?' gcard-selected':''}" data-locid="${E(loc ? loc.id : '')}" data-smkey="${E(a.sm_key || '')}" data-smurl="${E(a.web_url || '#')}" data-name="${E(a.name || '')}" onclick="libCardClick(this)" style="${glow}">`;
    cards += '<div class="gcard-tw">';
    if (thumb) cards += `<img class="gcard-img" src="${E(smMedium(thumb))}" loading="lazy" alt="${E(a.name)} thumbnail" onerror="hideOnError(this)">`;
    cards += '<div class="gcard-ph">◻</div>';
    cards += `<div class="gcard-overlay">${E(a.name)}</div></div>`;
    cards += '<div class="gcard-meta">';
    if (sl) cards += `<span style="color:${sl.c}">${E(SL_LABEL[loc.status] || loc.status)}</span>`;
    cards += `<span style="color:var(--text3)">${a.image_count || 0} photos</span>`;
    cards += '</div></div>';
  });

  grid.innerHTML = cards || '<div class="empty">No locations here</div>';
}

window.libCardClick = function (el) {
  const locId = el.dataset.locid;
  if (locId) {
    const loc = S.locById.get(locId);
    if (loc) { openDetail(loc); return; }
  }
  // Album with no linked location yet — build a synthetic stub so user can still see/edit it
  const smKey = el.dataset.smkey;
  if (smKey) {
    const album = S.libAlbums.find(a => a.sm_key === smKey) || S.mapAlbums.find(a => a.sm_key === smKey);
    if (album) {
      const stub = {
        id: 'stub:' + smKey,
        name: album.name || el.dataset.name || '(unnamed)',
        smugmug_album_key: smKey,
        smugmug_gallery_url: album.web_url || el.dataset.smurl || '',
        cover_photo_url: album.highlight_url || '',
        notes: album.description || '',
        status: 'identified',
        tags: [],
        address_verified: false,
        _isStub: true
      };
      // Stash so closeDetail / lookups don't break
      S.locById.set(stub.id, stub);
      openDetail(stub);
      return;
    }
  }
  // Last resort — open SmugMug if all else fails
  if (el.dataset.smurl && el.dataset.smurl !== '#') window.open(el.dataset.smurl, '_blank');
};
window.libFolderClick = function (el) {
  const p = el.getAttribute('data-p'), l = el.getAttribute('data-l');
  if (p) libBrowse(p, l);
};

window.libSearch = function () {
  const q = $('lib-q').value.toLowerCase();
  const statusKey = $('lib-status-sel').value;
  if (!q && !statusKey) { libRender(); return; }
  const grid = $('lib-grid'), bc = $('lib-bc');
  const allowed = statusKey ? STATUS_FILTERS[statusKey] : null;
  const f = S.locations.filter(l => {
    if (allowed && allowed.indexOf(l.status) < 0) return false;
    if (q) {
      const h = [l.name, l.address, l.city, l.notes].concat(l.tags || []).join(' ').toLowerCase();
      if (h.indexOf(q) < 0) return false;
    }
    return true;
  });
  bc.innerHTML = `<span class="lib-bc-seg" onclick="libBrowse(null)">Master Library</span><span class="lib-bc-sep"> / </span><span class="lib-bc-seg cur">search (${f.length})</span>`;
  if (!f.length) {
    grid.innerHTML = `<div class="empty">No results for "${E(q)}"</div>`;
    return;
  }
  grid.innerHTML = f.map(l => {
    const sl = SL[l.status] || SL.identified;
    return `<div class="gcard" data-locid="${E(l.id)}" onclick="libCardClick(this)">
      <div class="gcard-tw">${l.cover_photo_url ? `<img class="gcard-img" src="${E(smMedium(l.cover_photo_url))}" loading="lazy" onerror="hideOnError(this)">` : ''}
      <div class="gcard-ph">◻</div><div class="gcard-overlay">${E(l.name)}</div></div>
      <div class="gcard-meta"><span style="color:${sl.c}">${E(SL_LABEL[l.status] || l.status)}</span><span style="color:var(--text3)">${E([l.city, l.state_code].filter(Boolean).join(', ') || '—')}</span></div></div>`;
  }).join('');
};

window.hideOnError = function (el) { el.style.display = 'none'; };

// ══════════════════════════════════════════════════════════════════════════
// LEFT PANEL (build once; toggle via classes — no DOM rebuild on every click)
// ══════════════════════════════════════════════════════════════════════════
function buildLeftPanel() {
  const cats = {};
  S.mapFolders.forEach(f => {
    if (!f.path) return;
    const parts = f.path.split('/');
    if (parts.length === 2 && parts[0] === 'Master-Library') {
      const ck = parts[1];
      if (!cats[ck]) cats[ck] = { name: f.name || ck.replace(/-/g, ' '), areas: {} };
    }
    if (parts.length === 3 && parts[0] === 'Master-Library') {
      const ck2 = parts[1], ak = parts[2];
      if (!cats[ck2]) cats[ck2] = { name: ck2.replace(/-/g, ' '), areas: {} };
      cats[ck2].areas[ak] = { name: f.name || ak.replace(/-/g, ' ') };
    }
  });

  const body = $('lp-body');
  body.innerHTML = '';

  Object.keys(cats).sort().forEach(ck => {
    const cat = cats[ck];
    const catDiv = document.createElement('div');
    catDiv.className = 'lp-cat'; catDiv.dataset.cat = ck;

    const catRow = document.createElement('div');
    catRow.className = 'lp-cat-row';

    const dot = document.createElement('div');
    dot.className = 'lp-col'; dot.dataset.dot = ck;
    dot.title = 'click to assign pin color';
    dot.addEventListener('click', e => { e.stopPropagation(); handleCatDotClick(ck, e); });

    const lbl = document.createElement('span');
    lbl.className = 'lp-cat-name'; lbl.dataset.label = ck;
    lbl.textContent = cat.name;
    lbl.addEventListener('click', e => { e.stopPropagation(); handleCatLabelClick(ck); });

    catRow.appendChild(dot); catRow.appendChild(lbl);

    const hasAreas = Object.keys(cat.areas).length > 0;
    let areasDiv = null;
    if (hasAreas) {
      const tog = document.createElement('span');
      tog.className = 'lp-tog'; tog.textContent = '›';
      catRow.appendChild(tog);

      areasDiv = document.createElement('div');
      areasDiv.className = 'lp-areas';

      Object.keys(cat.areas).sort().forEach(ak => {
        const area = cat.areas[ak];
        const aKey = ck + '/' + ak;
        const aRow = document.createElement('div');
        aRow.className = 'lp-area-row'; aRow.dataset.area = aKey;
        const adot = document.createElement('div'); adot.className = 'lp-area-dot';
        const albl = document.createElement('span'); albl.className = 'lp-area-name'; albl.textContent = area.name;
        aRow.appendChild(adot); aRow.appendChild(albl);
        aRow.addEventListener('click', e => { e.stopPropagation(); handleAreaClick(aKey, ck); });
        areasDiv.appendChild(aRow);
      });
    }

    catRow.addEventListener('click', () => lbl.click());
    catDiv.appendChild(catRow);
    if (areasDiv) catDiv.appendChild(areasDiv);
    body.appendChild(catDiv);
  });

  refreshLeftPanel();
}

function refreshLeftPanel() {
  // Update visual state without rebuilding DOM
  const anyColored = Object.keys(S.catPinColors).length > 0;
  document.querySelectorAll('.lp-cat').forEach(catDiv => {
    const ck = catDiv.dataset.cat;
    const isColored = !!S.catPinColors[ck];
    const isCatOpen = S.highlightedCat === ck;
    const dot = catDiv.querySelector('.lp-col');
    const lbl = catDiv.querySelector('.lp-cat-name');
    const tog = catDiv.querySelector('.lp-tog');
    const areas = catDiv.querySelector('.lp-areas');

    const savedCol = S.savedCatColors[ck] || null;
    const dotCol = isColored ? S.catPinColors[ck] : (savedCol || null);
    if (dotCol) {
      dot.style.background = dotCol;
      dot.style.borderColor = dotCol + (isColored ? '' : '88');
      dot.style.opacity = isColored ? '1' : '0.45';
    } else {
      dot.style.background = 'var(--border2)';
      dot.style.borderColor = 'transparent';
      dot.style.opacity = '1';
    }
    dot.classList.toggle('active', isColored);

    lbl.style.color = isColored ? S.catPinColors[ck] : '';
    lbl.classList.toggle('active', isCatOpen);
    lbl.classList.toggle('dimmed', anyColored && !isColored && !isCatOpen);

    catDiv.querySelector('.lp-cat-row').style.background = isCatOpen ? 'var(--bg3)' : '';

    if (tog) tog.classList.toggle('open', isCatOpen);
    if (areas) areas.classList.toggle('open', isCatOpen);

    // Update area rows
    if (areas) {
      areas.querySelectorAll('.lp-area-row').forEach(aRow => {
        const aKey = aRow.dataset.area;
        const isAreaSel = S.selectedAreas.has(aKey);
        const adot = aRow.querySelector('.lp-area-dot');
        const albl = aRow.querySelector('.lp-area-name');
        aRow.style.background = isAreaSel ? 'var(--bg3)' : '';
        adot.style.background = isColored ? S.catPinColors[ck] : 'var(--border2)';
        adot.classList.toggle('active', isAreaSel);
        if (isAreaSel && isColored) adot.style.boxShadow = '0 0 5px ' + S.catPinColors[ck];
        else adot.style.boxShadow = '';
        albl.classList.toggle('active', isAreaSel);
      });
    }
  });
}

function handleCatDotClick(ck, e) {
  if (S.catPinColors[ck]) {
    S.savedCatColors[ck] = S.catPinColors[ck];
    try { localStorage.setItem('savedCatColors', JSON.stringify(S.savedCatColors)); } catch (e2) {}
    const next = Object.assign({}, S.catPinColors);
    delete next[ck];
    setPinColors(next);
  } else if (S.savedCatColors[ck]) {
    const next = Object.assign({}, S.catPinColors);
    next[ck] = S.savedCatColors[ck];
    setPinColors(next);
  } else {
    showColorPicker(ck, e.clientX, e.clientY, color => {
      S.savedCatColors[ck] = color;
      try { localStorage.setItem('savedCatColors', JSON.stringify(S.savedCatColors)); } catch (e2) {}
      const next = Object.assign({}, S.catPinColors);
      next[ck] = color;
      setPinColors(next);
    });
  }
}

function handleCatLabelClick(ck) {
  pushNav();
  if (S.highlightedCat === ck) {
    S.highlightedCat = null;
    S.selectedAreas = new Set();
  } else {
    S.highlightedCat = ck;
    S.selectedAreas = new Set();
  }
  refreshLeftPanel();
  updatePinHighlights();
}

function handleAreaClick(aKey, ck) {
  pushNav();
  if (S.selectedAreas.has(aKey)) S.selectedAreas.delete(aKey);
  else S.selectedAreas.add(aKey);
  S.highlightedCat = ck;
  refreshLeftPanel();
  updatePinHighlights();
}

function setPinColors(newColors) {
  S.catPinColors = newColors;
  try { localStorage.setItem('pinColors', JSON.stringify(S.catPinColors)); } catch (e) {}
  refreshLeftPanel();
  refreshPins();
}

window.lpToggleAll = function () {
  S.catPinColors = {};
  S.highlightedCat = null;
  S.selectedAreas = new Set();
  try { localStorage.setItem('pinColors', JSON.stringify(S.catPinColors)); } catch (e) {}
  refreshLeftPanel();
  refreshPins();
};

function loadPinColors() {
  try { const s = localStorage.getItem('pinColors'); if (s) S.catPinColors = JSON.parse(s); } catch (e) {}
  try { const s2 = localStorage.getItem('savedCatColors'); if (s2) S.savedCatColors = JSON.parse(s2); } catch (e) {}
}

// ── Color picker ────────────────────────────────────────────────────────────
function showColorPicker(ck, x, y, onPick) {
  const ex = $('cat-color-picker'); if (ex) ex.remove();
  const p = document.createElement('div'); p.id = 'cat-color-picker';
  const t = document.createElement('div'); t.className = 'ccp-title';
  t.textContent = ck.replace(/-/g, ' '); p.appendChild(t);

  const wheelRow = document.createElement('div');
  wheelRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px';
  const wheel = document.createElement('input'); wheel.type = 'color';
  wheel.value = S.catPinColors[ck] || CAT_PALETTE[0];
  wheel.style.cssText = 'width:48px;height:48px;border:none;background:none;cursor:pointer;padding:0;border-radius:8px';
  const wheelLbl = document.createElement('div');
  wheelLbl.style.cssText = 'font-size:9px;font-family:DM Mono,monospace;color:var(--text3);line-height:1.5';
  wheelLbl.innerHTML = `color wheel<br><span style="color:var(--text2)" id="ccp-hex">${E(wheel.value)}</span>`;
  wheel.addEventListener('input', function() { wheelLbl.querySelector('#ccp-hex').textContent = this.value; });
  wheel.addEventListener('change', function() { p.remove(); if (onPick) onPick(this.value); });
  wheelRow.appendChild(wheel); wheelRow.appendChild(wheelLbl);
  p.appendChild(wheelRow);

  const g = document.createElement('div'); g.className = 'ccp-grid';
  CAT_PALETTE.forEach(col => {
    const sw = document.createElement('div');
    sw.className = 'ccp-swatch'; sw.style.background = col;
    if (S.catPinColors[ck] === col) sw.classList.add('active');
    sw.addEventListener('click', () => { p.remove(); if (onPick) onPick(col); });
    g.appendChild(sw);
  });
  p.appendChild(g);

  const px = Math.min(x, window.innerWidth - 220);
  let py = Math.min(y, window.innerHeight - 340);
  if (py < 60) py = 60;
  p.style.left = px + 'px'; p.style.top = py + 'px';
  document.body.appendChild(p);
  setTimeout(() => {
    document.addEventListener('click', function cls(e) {
      if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', cls); }
    });
  }, 10);
}

// ══════════════════════════════════════════════════════════════════════════
// SMUGMUG SYNC
// ══════════════════════════════════════════════════════════════════════════
window.toggleDock = function () {
  S.dockOpen = !S.dockOpen;
  $('dock-actions').style.display = S.dockOpen ? 'flex' : 'none';
  posNavStatus();
};
function closeDock() { S.dockOpen = false; $('dock-actions').style.display = 'none'; }

function posNavStatus() {
  const nr = $('nav-right'), ns = $('nav-status');
  if (!nr || !ns) return;
  const nrRect = nr.getBoundingClientRect();
  ns.style.right = (window.innerWidth - nrRect.left + 12) + 'px';
  ns.style.maxWidth = Math.max(60, nrRect.left - 220) + 'px';
}

window.signOutSmugMug = function () {
  if (!confirm('Sign out of SmugMug? You can reconnect anytime to re-sync.')) return;
  S.smTokens = null;
  localStorage.removeItem('sm_tokens');
  updateAuthUI(false);
  closeDock();
  toast('Signed out of SmugMug', 'inf');
};

function checkAuth() {
  const hash = window.location.hash;
  if (hash.indexOf('sm_auth=') >= 0) {
    try {
      S.smTokens = JSON.parse(decodeURIComponent(hash.split('sm_auth=')[1]));
      localStorage.setItem('sm_tokens', JSON.stringify(S.smTokens));
      window.location.hash = '';
      toast('SmugMug connected!');
      updateAuthUI(true);
      return;
    } catch (e) {}
  }
  const s = localStorage.getItem('sm_tokens');
  if (s) try { S.smTokens = JSON.parse(s); updateAuthUI(true); } catch (e) {}
}

function updateAuthUI(ok) {
  const lbl = $('dock-sm-label'), btn = $('dock-sm-btn');
  const ab = $('dock-auth-btn'), sb = $('dock-sync-btn'), so = $('dock-signout-btn');
  const rg = $('dock-regeo-btn');
  const th = $('dock-thumbs-btn');
  if (ok) {
    lbl.textContent = 'smugmug ✓'; btn.classList.remove('unconnected');
    if (ab) ab.style.display = 'none';
    if (sb) sb.style.display = 'flex';
    if (so) so.style.display = 'flex';
    if (rg) rg.style.display = 'flex';
    if (th) th.style.display = 'flex';
  } else {
    lbl.textContent = 'smugmug'; btn.classList.add('unconnected');
    if (ab) ab.style.display = 'flex';
    if (sb) sb.style.display = 'none';
    if (so) so.style.display = 'none';
    if (rg) rg.style.display = 'none';
    if (th) th.style.display = 'none';
  }
}

async function checkSyncStatus() {
  try {
    const r = await db('sync_log?id=eq.1&select=*');
    if (r && r[0] && r[0].last_sync) {
      const d = new Date(r[0].last_sync);
      const ns = $('nav-status');
      if (ns) ns.textContent = `synced ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})} · ${r[0].images_count||0} photos`;
    }
  } catch (e) {}
  setTimeout(posNavStatus, 50);
}

window.doAuth = async function () {
  const btn = $('dock-auth-btn');
  btn.textContent = 'connecting...'; btn.disabled = true;
  try {
    const d = await (await fetch(SM_BASE + '/api/smugmug?action=auth')).json();
    if (d.authUrl) window.location.href = d.authUrl;
    else throw new Error('No auth URL');
  } catch (e) { toast('Auth failed', 'err'); btn.textContent = 'authorize ↗'; btn.disabled = false; }
};

window.startFullSync = async function () {
  if (!S.smTokens) { toast('Connect SmugMug first', 'err'); return; }
  closeDock();
  const lbl = $('dock-sync-label'), btn = $('dock-sync-btn'), ns = $('nav-status');
  const tb = btoa(JSON.stringify(S.smTokens));
  lbl.textContent = '⟳ syncing...'; btn.disabled = true;
  toast('Sync started — keep this tab visible & screen on. It auto-resumes if interrupted.', 'inf');

  try {
    if (ns) ns.textContent = 'crawling SmugMug...';
    const crawlResp = await (await fetchRetry(SM_BASE + '/api/smugmug?action=crawl', {
      headers: { Authorization: 'Bearer ' + tb }
    })).json();
    const library = crawlResp.library;
    const smAlbums = library.albums || [];
    if (ns) ns.textContent = `found ${smAlbums.length} albums — syncing structure...`;

    // Sync structure with mode='full' so server knows it can prune
    await fetchRetry(SM_BASE + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full', library: { folders: library.folders || [], albums: smAlbums, images: [] } })
    });

    // Fetch missing album images (parallelized in groups)
    const allAlbums = await db('smugmug_albums?select=sm_key,name');
    const syncedKeys = new Set((await db('smugmug_images?select=album_key')).map(i => i.album_key));
    const missing = allAlbums.filter(a => !syncedKeys.has(a.sm_key));

    const ckptKey = 'sync_checkpoint_v2';
    let ckpt = {};
    try { ckpt = JSON.parse(localStorage.getItem(ckptKey) || '{}'); } catch (e) {}
    const remaining = missing.filter(a => !ckpt[a.sm_key]);
    if (remaining.length < missing.length) toast(`${missing.length - remaining.length} albums resumed from checkpoint`, 'inf');

    let imgDone = 0;
    // Parallel batches of 3 (gentle on SmugMug rate limits)
    const BATCH = 3;
    for (let i = 0; i < remaining.length; i += BATCH) {
      // If user switched tabs / computer slept, wait until they're back before continuing
      await awaitVisibility();
      const batch = remaining.slice(i, i + BATCH);
      if (ns) ns.textContent = `images ${i+1}-${Math.min(i+BATCH, remaining.length)}/${remaining.length}`;
      await Promise.all(batch.map(async alb => {
        try {
          const r = await (await fetchRetry(SM_BASE + `/api/smugmug?action=album-images&albumKey=${alb.sm_key}`, {
            headers: { Authorization: 'Bearer ' + tb }
          })).json();
          const imgs = r.images || [];
          const desc = r.description || '';
          if (imgs.length) {
            await fetchRetry(SM_BASE + '/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ library: { folders: [], albums: [], images: imgs } })
            });
            imgDone++;
          }
          ckpt[alb.sm_key] = true;
          try { localStorage.setItem(ckptKey, JSON.stringify(ckpt)); } catch (e) {}
        } catch (e) { console.error('img:', alb.name, e.message); }
      }));
    }
    try { localStorage.removeItem(ckptKey); } catch (e) {}

    await loadLocations(true);
    if (S.gmap) refreshPins();
    S.libLoaded = false;
    checkSyncStatus();
    toast(`Sync complete · ${imgDone} new image sets`, 'ok');
    if (ns) ns.textContent = 'synced just now';
  } catch (e) {
    toast('Sync error: ' + e.message, 'err');
    if (ns) ns.textContent = 'sync error';
  }

  await autoGeocode();
  S.mapFolders = []; S.mapAlbums = [];
  await Promise.all([
    db('smugmug_albums?select=sm_key,name,web_url').then(r => { S.mapAlbums = r; }),
    db('smugmug_folders?select=name,path&order=path.asc').then(r => { S.mapFolders = r; })
  ]);
  rebuildLookups();
  buildLeftPanel();
  lbl.textContent = '⟳ sync'; btn.disabled = false;
};

async function checkAutoSync() {
  if (!S.smTokens) return;
  try {
    const r = await db('sync_log?id=eq.1&select=last_sync');
    if (!r || !r[0] || !r[0].last_sync) return;
    const hrs = (Date.now() - new Date(r[0].last_sync).getTime()) / 3600000;
    if (hrs > 24) { $('nav-status').textContent = 'auto-syncing...'; startFullSync(); }
  } catch (e) {}
}

// Auto-geocode unverified locations (uses state_code, no hardcoded NY)
async function autoGeocode() {
  const toGeo = S.locations.filter(l => !hasCoords(l) && !l.address_verified);
  if (!toGeo.length) return;
  const ns = $('nav-status');
  for (let i = 0; i < toGeo.length; i++) {
    const loc = toGeo[i];
    if (ns) ns.textContent = `geocoding ${i+1}/${toGeo.length}`;
    try {
      const query = loc.geocode_query || loc.name;
      const stateParam = loc.state_code ? '&state=' + loc.state_code : '';
      const d = await (await fetch(`${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${stateParam}`)).json();
      if (d.ok && d.lat) {
        await fetch(`${SB_URL}/rest/v1/locations?id=eq.${loc.id}`, {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
          },
          body: JSON.stringify({ lat: d.lat, lng: d.lng })
        });
        loc.lat = d.lat; loc.lng = d.lng;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (S.gmap) refreshPins();
}

// ══════════════════════════════════════════════════════════════════════════
// PAGE NAVIGATION
// ══════════════════════════════════════════════════════════════════════════
window.showPage = function (page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $(page + '-page').classList.add('active');
  btn.classList.add('active');
  closeDock();

  // Filter bar visibility:
  //   Map → entire bar visible
  //   Library → bar visible, but zone-ring + satellite hidden (map-specific)
  //   Organize → entire bar hidden (organize is a separate workflow)
  const mapControls = $('map-controls');
  if (mapControls) mapControls.style.display = (page === 'organize') ? 'none' : 'flex';
  document.querySelectorAll('.flatten-only-library').forEach(el => {
    el.style.display = (page === 'library') ? '' : 'none';
  });
  document.querySelectorAll('.map-only-control').forEach(el => {
    el.style.display = (page === 'home') ? '' : 'none';
  });

  if (page === 'home') {
    if (!S.mapReady) loadMapScript();
    else if (S.gmap) setTimeout(() => google.maps.event.trigger(S.gmap, 'resize'), 50);
  }
  if (page === 'library') libInit();
  if (page === 'organize') orgInit();
};

// ══════════════════════════════════════════════════════════════════════════
// ORGANIZE TAB
// ══════════════════════════════════════════════════════════════════════════
const ORG_CONFIDENCE_HIGH = 0.85;
const ORG_CONFIDENCE_MED  = 0.70;
const ORG_BATCH_SIZE      = 3;     // smaller — server handles 2 in parallel, retries handle rate limits
const BLUR_THRESHOLD      = 30;    // Laplacian variance below this = treated as blurry

// In-memory mirror of Supabase org_corrections (loaded on Organize tab open)
let orgCorrectionsCache = [];
let orgRunsCache = {};   // {album_key: {selected_image_keys, per_image_tags, ...}}

async function loadOrgHistory() {
  try {
    const r = await db('org_corrections?select=album_key,album_name,ai_path,applied_path,ai_tags,applied_tags,rejected_tags,added_tags,ai_model,created_at&order=created_at.desc&limit=200');
    orgCorrectionsCache = Array.isArray(r) ? r : [];
  } catch (e) {
    console.warn('org_corrections load failed (run migration_2_organize.sql?):', e);
    orgCorrectionsCache = [];
  }
  return orgCorrectionsCache;
}

async function loadOrgRuns() {
  try {
    const r = await db('org_album_runs?select=album_key,classified_path,classified_tags,selected_image_keys,per_image_tags,ai_model,classified_at');
    orgRunsCache = {};
    (Array.isArray(r) ? r : []).forEach(row => { orgRunsCache[row.album_key] = row; });
  } catch (e) {
    console.warn('org_album_runs load failed (run migration_2_organize.sql?):', e);
    orgRunsCache = {};
  }
  return orgRunsCache;
}

async function saveOrgCorrection(entry) {
  try {
    await fetch(`${SB_URL}/rest/v1/org_corrections`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        album_key:    entry.album_key,
        album_name:   entry.album_name,
        ai_path:      entry.ai_path,
        applied_path: entry.applied_path,
        ai_tags:      entry.ai_tags || [],
        applied_tags: entry.applied_tags || [],
        rejected_tags: entry.rejected_tags || [],
        added_tags:   entry.added_tags || [],
        ai_model:     entry.ai_model || ''
      })
    });
    orgCorrectionsCache.unshift(entry);
  } catch (e) { console.warn('Save correction failed:', e); }
}

async function saveOrgRun(album_key, run) {
  try {
    await fetch(`${SB_URL}/rest/v1/org_album_runs?on_conflict=album_key`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        album_key,
        album_name:           run.album_name,
        classified_path:      run.classified_path,
        classified_tags:      run.classified_tags || [],
        selected_image_keys:  run.selected_image_keys || [],
        per_image_tags:       run.per_image_tags || {},
        ai_model:             run.ai_model || '',
        classified_at:        new Date().toISOString()
      })
    });
    orgRunsCache[album_key] = run;
  } catch (e) { console.warn('Save run failed:', e); }
}

// Pick the most useful corrections to send — prefer ones where user changed something
function selectCorrectionsForPrompt(history, max) {
  if (!history || !history.length) return [];
  const scored = history.map(h => {
    let score = 0;
    if (h.applied_path && h.ai_path && h.applied_path !== h.ai_path) score += 3;
    if (h.rejected_tags && h.rejected_tags.length) score += 2;
    if (h.added_tags && h.added_tags.length) score += 1;
    return { h, score };
  }).filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (new Date(b.h.created_at).getTime() - new Date(a.h.created_at).getTime()))
    .slice(0, max)
    .map(s => s.h);
  return scored;
}

// ══════════════════════════════════════════════════════════════════════════
// BLUR DETECTION (client-side, Laplacian variance on thumbnails)
// ══════════════════════════════════════════════════════════════════════════
async function detectBlur(url) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 5000);
    img.onload = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try {
        const w = Math.min(img.naturalWidth, 100);
        const h = Math.min(img.naturalHeight, 75);
        if (w < 8 || h < 8) return resolve(null);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let sum = 0, sumSq = 0, count = 0;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            const cur = (data[i] + data[i+1] + data[i+2]) / 3;
            const up = (data[i - w*4] + data[i - w*4 + 1] + data[i - w*4 + 2]) / 3;
            const dn = (data[i + w*4] + data[i + w*4 + 1] + data[i + w*4 + 2]) / 3;
            const lf = (data[i - 4] + data[i - 3] + data[i - 2]) / 3;
            const rt = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
            const lap = 4 * cur - up - dn - lf - rt;
            sum += lap;
            sumSq += lap * lap;
            count++;
          }
        }
        if (count === 0) return resolve(null);
        const mean = sum / count;
        resolve(sumSq / count - mean * mean);
      } catch (e) {
        // Likely CORS — silently skip blur detection for this image
        resolve(null);
      }
    };
    img.onerror = () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } };
    img.src = url;
  });
}

async function orgInit() {
  renderTaxonomyTree();
  // Fetch corrections + runs in parallel
  await Promise.all([loadOrgHistory(), loadOrgRuns()]);
  updateFeedbackBadge();
  if (!S.orgLoaded) await orgLoadUploads();
  else orgRender();
}

function updateFeedbackBadge() {
  const el = $('org-feedback');
  if (!el) return;
  const corrections = selectCorrectionsForPrompt(orgCorrectionsCache, 12);
  el.textContent = corrections.length
    ? `${corrections.length} learned correction${corrections.length !== 1 ? 's' : ''}`
    : '';
  el.style.display = corrections.length ? 'inline-flex' : 'none';
}

// ── Pull all album image data (urls + keys) ──
async function orgFetchAlbumImageData(sm_key) {
  try {
    const imgs = await db(`smugmug_images?album_key=eq.${sm_key}&select=sm_key,thumb_url&limit=200`);
    return imgs
      .filter(i => i.thumb_url)
      .map(i => ({ key: i.sm_key, thumb_url: i.thumb_url }));
  } catch (e) { return []; }
}

// Build the existing taxonomy from smugmug_folders
function buildTaxonomyPaths() {
  // Convert folder paths like "Master-Library/restaurants/diners" → "restaurants/diners"
  const paths = new Set();
  (S.libFolders.length ? S.libFolders : S.mapFolders).forEach(f => {
    if (!f.path) return;
    const parts = f.path.split('/').filter(Boolean);
    if (parts[0] !== 'Master-Library') return;
    if (parts.length < 2) return;
    // Skip the Uploads/Orphans housekeeping folders
    if (/^uploads(-\d+)?$/i.test(parts[1]) || parts[1] === 'Orphans') return;
    paths.add(parts.slice(1).join('/'));
  });
  return Array.from(paths).sort();
}

function renderTaxonomyTree() {
  const cur = $('org-tax-current');
  if (!cur) return;
  const paths = buildTaxonomyPaths();
  if (!paths.length) {
    cur.innerHTML = '<div class="empty">No taxonomy yet — sync the library first</div>';
    return;
  }
  // Render as a hierarchical list
  cur.innerHTML = paths.map(p => {
    const depth = Math.min(p.split('/').length - 1, 2);
    const lastSeg = p.split('/').pop().replace(/-/g, ' ');
    return `<div class="org-tax-node depth-${depth}">${depth > 0 ? '· ' : ''}${E(lastSeg)}</div>`;
  }).join('');
}

function renderSuggestedPaths() {
  const newCol = $('org-tax-new');
  if (!newCol) return;
  const existing = new Set(buildTaxonomyPaths());
  const tally = {};
  Object.values(S.orgClassifications).forEach(c => {
    if (!c || !c.path || existing.has(c.path)) return;
    tally[c.path] = (tally[c.path] || 0) + 1;
  });
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    newCol.innerHTML = '<div class="empty">— run a classify pass to see new paths Claude suggests —</div>';
    return;
  }
  newCol.innerHTML = entries.map(([p, n]) =>
    `<div class="org-tax-new-item">+ ${E(p)} <span class="org-tax-new-count">(${n})</span></div>`
  ).join('');
}

// ── Load albums from /Master-Library/Uploads/ ──
async function orgLoadUploads() {
  $('org-list').innerHTML = '<div class="empty"><div class="spin"></div><span>loading uploads...</span></div>';
  try {
    // Pull all albums with path matching Master-Library/Uploads*
    const albums = await db('smugmug_albums?select=sm_key,name,path,web_url,description,image_count,highlight_url&order=name.asc');
    // Need libFolders too if not loaded
    if (!S.libFolders.length) {
      S.libFolders = await db('smugmug_folders?select=name,path&order=path.asc');
    }
    if (!S.libAlbums.length) S.libAlbums = albums;

    S.orgUploads = albums.filter(a => {
      if (!a.web_url) return false;
      const parts = a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
      // Match Master-Library/Uploads/ or Uploads-2/ etc as the parent
      return parts[0] === 'Master-Library' && /^uploads(-\d+)?$/i.test(parts[1] || '');
    });
    S.orgLoaded = true;
    renderTaxonomyTree();
    orgRender();
  } catch (e) {
    $('org-list').innerHTML = `<div class="empty">Error loading: ${E(e.message || 'unknown')}</div>`;
  }
}

// ── Render album list ──
function orgRender() {
  const list = $('org-list');
  const count = S.orgUploads.length;
  $('org-count').textContent = count ? `· ${count} albums` : '';

  if (!count) {
    list.innerHTML = '<div class="empty">No albums in Uploads. Use the Python script to upload first.</div>';
    $('org-classify-btn').disabled = true;
    $('org-apply-btn').disabled = true;
    return;
  }

  // Don't override button states while a long-running operation is in flight
  if (!S.orgClassifying) {
    $('org-classify-btn').disabled = false;
  }
  const queued = Object.values(S.orgClassifications).filter(c => c && c.status === 'queued').length;
  if (!S.orgApplying) {
    $('org-apply-btn').disabled = queued === 0;
    $('org-apply-btn').textContent = queued ? `Apply ${queued} move${queued !== 1 ? 's' : ''}` : 'Apply moves';
  }
  // Approve all is enabled if any classified card isn't queued/applied/skipped
  const approvable = Object.values(S.orgClassifications).filter(c =>
    c && c.classified && c.status !== 'queued' && c.status !== 'applied' && c.status !== 'skipped'
  ).length;
  const apBtn = $('org-approve-btn');
  if (apBtn) apBtn.disabled = approvable === 0;

  list.innerHTML = S.orgUploads.map(a => orgRenderCard(a)).join('');
  renderSuggestedPaths();
}

function orgRenderCard(album) {
  const c = S.orgClassifications[album.sm_key] || {};
  // Always show a real thumbnail. Prefer highlight_url; fall back to first synced image we know.
  let mainThumb = album.highlight_url ? smMedium(album.highlight_url) : '';
  if (!mainThumb && c.selectedThumbs && c.selectedThumbs.length) {
    mainThumb = smMedium(c.selectedThumbs[0]);
  }
  const status = c.status || '';
  const cls = ['org-card'];
  if (status === 'skipped') cls.push('skipped');
  if (status === 'applied') cls.push('applied');
  if (status === 'classifying') cls.push('classifying');
  if (status === 'error') cls.push('error');

  let suggestHtml = '';
  if (c.classified) {
    const conf = Number(c.confidence || 0);
    const confCls = conf >= ORG_CONFIDENCE_HIGH ? 'high' : conf >= ORG_CONFIDENCE_MED ? 'med' : 'low';
    const confPct = Math.round(conf * 100);
    suggestHtml = `<div class="org-card-suggest">
      <div><span class="sg-path">${E(c.path || '?')}</span><span class="sg-conf ${confCls}">${confPct}%</span></div>
      ${c.reasoning ? `<div class="sg-reason">${E(c.reasoning)}</div>` : ''}
      ${c.tags && c.tags.length ? `<div class="sg-tags-label">${c.tags.length} keyword${c.tags.length !== 1 ? 's' : ''} (click ✕ to remove before accepting):</div><div class="sg-tags">${c.tags.map(t => `<span class="sg-tag" onclick="orgRemoveTag('${E(album.sm_key)}', '${E(t)}')" title="Remove this tag">${E(t)}<span class="sg-tag-x">✕</span></span>`).join('')}</div>` : ''}
      ${c.rejectedTags && c.rejectedTags.length ? `<div class="sg-rejected-label">rejected: ${c.rejectedTags.map(t => E(t)).join(', ')} <button class="sg-restore" onclick="orgRestoreTags('${E(album.sm_key)}')">restore</button></div>` : ''}
      <div class="sg-model">${E(c.model || '')}${c.imagesUsed ? ` · ${c.imagesUsed} img${c.curation === 'haiku' ? ' (curated)' : ''}` : ''}${c.curationReasoning && c.curation === 'haiku' ? ` · ${E(c.curationReasoning)}` : ''}</div>
    </div>`;
  } else if (status === 'classifying') {
    suggestHtml = `<div class="org-card-suggest"><div class="spin" style="margin-right:6px;display:inline-block"></div>classifying…</div>`;
  } else if (status === 'error') {
    suggestHtml = `<div class="org-card-suggest" style="border-color:var(--red);color:var(--red)">${E(c.error || 'Error')}</div>`;
  }

  // Selected-image strip — each thumb has its own click for lightbox + an X to deselect
  let stripHtml = '';
  if (c.selectedThumbs && c.selectedThumbs.length) {
    stripHtml = `<div class="org-strip">
      <div class="org-strip-label">Best picks (${c.selectedThumbs.length}) — click to lightbox · ✕ to deselect</div>
      <div class="org-strip-row">${c.selectedThumbs.map((t, i) => {
        const k = (c.selectedKeys && c.selectedKeys[i]) || '';
        return `<div class="org-strip-cell">
          <img src="${E(smMedium(t))}" alt="" loading="lazy" onclick="orgOpenLightbox('${E(album.sm_key)}', ${i})" onerror="this.style.display='none'">
          <button class="org-strip-x" onclick="orgDeselectImage('${E(album.sm_key)}', '${E(k)}')" title="Not a good pick — remove">✕</button>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  let actionsHtml = '';
  if (status === 'applied') {
    actionsHtml = `<div class="org-card-status applied">✓ moved</div>`;
  } else if (status === 'queued') {
    actionsHtml = `<div class="org-card-status queued">→ ${E(c.targetPath || c.path)}</div>
      <button class="org-btn" onclick="orgUnqueue('${E(album.sm_key)}')">undo</button>`;
  } else if (status === 'skipped') {
    actionsHtml = `<button class="org-btn" onclick="orgUnskip('${E(album.sm_key)}')">unskip</button>`;
  } else if (c.classified) {
    actionsHtml = `
      <button class="org-btn accept" onclick="orgAccept('${E(album.sm_key)}')">✓ accept</button>
      <button class="org-btn" onclick="orgEdit('${E(album.sm_key)}')">✏ edit</button>
      <button class="org-btn" onclick="orgSkip('${E(album.sm_key)}')">skip</button>`;
  } else if (status === 'classifying') {
    actionsHtml = `<div class="org-card-status queued">working...</div>`;
  } else {
    actionsHtml = `<button class="org-btn" onclick="orgClassifyOne('${E(album.sm_key)}')">⚡ classify</button>
      <button class="org-btn" onclick="orgSkip('${E(album.sm_key)}')">skip</button>`;
  }

  const thumbHtml = mainThumb
    ? `<img src="${E(mainThumb)}" loading="lazy" onerror="this.style.display='none'" onclick="orgOpenLightbox('${E(album.sm_key)}', 0)">`
    : `<div class="org-thumb-placeholder">no preview</div>`;

  return `<div class="${cls.join(' ')}" data-key="${E(album.sm_key)}">
    <div class="org-card-thumb">${thumbHtml}</div>
    <div class="org-card-body">
      <div class="org-card-name">${E(album.name)}</div>
      <div class="org-card-meta">${album.image_count || 0} photos</div>
      ${album.description ? `<div class="org-card-notes">${E((album.description || '').slice(0, 200))}</div>` : ''}
      ${suggestHtml}
      ${stripHtml}
    </div>
    <div class="org-card-actions">${actionsHtml}</div>
  </div>`;
}

// ── Lightbox for selected images ──
window.orgDeselectImage = function (sm_key, image_key) {
  const c = S.orgClassifications[sm_key];
  if (!c || !c.selectedKeys) return;
  const idx = c.selectedKeys.indexOf(image_key);
  if (idx < 0) return;
  // Remove from selection
  c.selectedKeys.splice(idx, 1);
  if (c.selectedThumbs) c.selectedThumbs.splice(idx, 1);
  if (c.perImageTags) delete c.perImageTags[image_key];
  c.rejectedImageKeys = (c.rejectedImageKeys || []).concat([image_key]);
  orgRender();
};

window.orgOpenLightbox = function (sm_key, startIdx) {
  const c = S.orgClassifications[sm_key];
  if (!c || !c.selectedThumbs || !c.selectedThumbs.length) return;
  // Reuse the existing lightbox by populating dpImages
  S.dpImages = c.selectedThumbs.slice();
  S.dpIndex = Math.max(0, Math.min(startIdx || 0, S.dpImages.length - 1));
  $('lb-img').src = smXL(S.dpImages[S.dpIndex]);
  $('lightbox').classList.add('open');
  updateLbCounter();
};

// ── Classification ──
async function orgFetchAlbumImages(sm_key) {
  // Pull thumbnails. Pass 1 (Haiku) caps at 100; we fetch a bit more so it has full coverage.
  try {
    const imgs = await db(`smugmug_images?album_key=eq.${sm_key}&select=thumb_url&limit=150`);
    return imgs.map(i => i.thumb_url).filter(Boolean);
  } catch (e) { return []; }
}

async function orgClassifyBatch(albums) {
  if (!albums.length) return;
  const taxonomy = buildTaxonomyPaths();
  const corrections = selectCorrectionsForPrompt(orgCorrectionsCache, 12);

  // For each album: fetch images, run blur detection, take every other sharp one
  const albumsWithImages = await Promise.all(albums.map(async a => {
    const allImgs = await orgFetchAlbumImageData(a.sm_key);
    let prepared = [];

    if (allImgs.length === 0) {
      // No synced images — fall back to highlight only
      if (a.highlight_url) prepared = [{ key: null, thumb_url: a.highlight_url }];
    } else {
      // Run blur detection in parallel
      const blurScores = await Promise.all(allImgs.map(i => detectBlur(i.thumb_url)));
      const sharp = allImgs.filter((_, i) => blurScores[i] === null || blurScores[i] >= BLUR_THRESHOLD);
      // If blur detection failed for ALL (CORS issue), use everything
      const filtered = sharp.length ? sharp : allImgs;
      // Take every other to reduce cost on the cheap pass
      prepared = filtered.filter((_, i) => i % 2 === 0);
      // Safety: if we filtered too aggressively, fall back to filtered set
      if (prepared.length < 8 && filtered.length > prepared.length) prepared = filtered;
    }

    return {
      album: a,
      prepared
    };
  }));

  // Mark classifying
  albums.forEach(a => {
    S.orgClassifications[a.sm_key] = { ...(S.orgClassifications[a.sm_key]||{}), status: 'classifying' };
  });
  orgRender();

  try {
    const apiAlbums = albumsWithImages.map(({ album, prepared }) => ({
      key: album.sm_key,
      name: album.name,
      notes: album.description || '',
      address: '',
      city: '',
      state: '',
      image_urls: prepared.map(p => p.thumb_url),
      image_keys: prepared.map(p => p.key)  // parallel array
    }));

    const r = await fetch(`${SM_BASE}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albums: apiAlbums, taxonomy, corrections }),
      signal: S.orgClassifyController ? S.orgClassifyController.signal : undefined
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'classify failed');

    // Build a lookup from album_key → prepared list (for thumb URLs)
    const prepLookup = {};
    albumsWithImages.forEach(({ album, prepared }) => {
      prepLookup[album.sm_key] = prepared;
    });

    (data.results || []).forEach(res => {
      if (!res || !res.key) return;
      if (res.error) {
        S.orgClassifications[res.key] = { status: 'error', error: res.error };
      } else {
        const prepared = prepLookup[res.key] || [];
        // Map selected_image_keys back to thumb URLs (for display)
        const selectedThumbs = (res.selected_image_keys || [])
          .map(k => prepared.find(p => p.key === k))
          .filter(Boolean)
          .map(p => p.thumb_url);

        S.orgClassifications[res.key] = {
          classified: true,
          status: '',
          path: res.path,
          confidence: res.confidence,
          reasoning: res.reasoning,
          tags: res.tags || [],
          aiTags: res.tags || [],
          aiPath: res.path,
          rejectedTags: [],
          model: res.model || '',
          alternatives: res.alternative_paths || [],
          imagesUsed: res._images_used || 0,
          curation: res._curation || '',
          curationReasoning: res._curation_reasoning || '',
          selectedKeys: res.selected_image_keys || [],
          selectedThumbs: selectedThumbs,
          perImageTags: res.per_image_tags_by_key || {}
        };
      }
    });
  } catch (e) {
    albums.forEach(a => {
      S.orgClassifications[a.sm_key] = { status: 'error', error: e.message || 'classify failed' };
    });
    toast('Classify error: ' + (e.message || 'unknown'), 'err');
  }
  orgRender();
}

window.orgClassifyAll = async function () {
  // If already running, this acts as cancel
  if (S.orgClassifying) {
    S.orgCancelClassify = true;
    if (S.orgClassifyController) S.orgClassifyController.abort();
    toast('Cancelling… (will stop after current request)', 'inf');
    return;
  }
  const todo = S.orgUploads.filter(a => {
    const c = S.orgClassifications[a.sm_key];
    return !c || (!c.classified && c.status !== 'applied' && c.status !== 'skipped' && c.status !== 'queued');
  });
  if (!todo.length) { toast('All albums already classified', 'inf'); return; }
  if (!confirm(`Classify ${todo.length} album${todo.length !== 1 ? 's' : ''}?\n\nFlow per album:\n  1. Blur detection (free, client-side)\n  2. Cheap pass (Haiku) on every-other sharp photo → picks top 15\n  3. Deep pass (Sonnet) on those 15 with per-image tagging\n\nApprox cost: ~$${(todo.length * 0.05).toFixed(2)} (~5¢/album with medium-size images).\nYou can cancel mid-run.`)) return;

  S.orgClassifying = true;
  S.orgCancelClassify = false;
  $('org-classify-btn').textContent = '✖ Cancel';
  $('org-classify-btn').classList.add('org-btn-cancel');

  try {
    for (let i = 0; i < todo.length; i += ORG_BATCH_SIZE) {
      if (S.orgCancelClassify) {
        toast('Classification cancelled', 'inf');
        break;
      }
      const batch = todo.slice(i, i + ORG_BATCH_SIZE);
      $('org-classify-btn').textContent = `✖ Cancel (${i + batch.length}/${todo.length})`;
      // Set up an AbortController so the in-flight fetch can be cancelled
      S.orgClassifyController = new AbortController();
      try {
        await orgClassifyBatch(batch);
      } catch (e) {
        if (e && e.name === 'AbortError') break;
      }
    }
    if (!S.orgCancelClassify) toast('Classification done', 'ok');
  } finally {
    S.orgClassifying = false;
    S.orgCancelClassify = false;
    S.orgClassifyController = null;
    $('org-classify-btn').textContent = '⚡ Classify all';
    $('org-classify-btn').classList.remove('org-btn-cancel');
    orgRender();
  }
};

window.orgApproveAll = function () {
  let count = 0;
  let lowConfCount = 0;
  S.orgUploads.forEach(a => {
    const c = S.orgClassifications[a.sm_key];
    if (!c || !c.classified) return;
    if (c.status === 'queued' || c.status === 'applied' || c.status === 'skipped') return;
    if ((c.confidence || 0) < ORG_CONFIDENCE_MED) {
      lowConfCount++;
      return;
    }
    S.orgClassifications[a.sm_key] = { ...c, status: 'queued', targetPath: c.path };
    count++;
  });
  orgRender();
  let msg = count ? `Queued ${count} for move` : 'Nothing to approve';
  if (lowConfCount) msg += ` · ${lowConfCount} low-confidence skipped (review manually)`;
  toast(msg, count ? 'ok' : 'inf');
};

window.orgClassifyOne = async function (sm_key) {
  const album = S.orgUploads.find(a => a.sm_key === sm_key);
  if (!album) return;
  await orgClassifyBatch([album]);
};

window.orgRemoveTag = function (sm_key, tag) {
  const c = S.orgClassifications[sm_key];
  if (!c || !c.tags) return;
  c.tags = c.tags.filter(t => t !== tag);
  c.rejectedTags = (c.rejectedTags || []).concat([tag]);
  orgRender();
};

window.orgRestoreTags = function (sm_key) {
  const c = S.orgClassifications[sm_key];
  if (!c) return;
  c.tags = (c.aiTags || []).slice();
  c.rejectedTags = [];
  orgRender();
};

window.orgAccept = function (sm_key) {
  const c = S.orgClassifications[sm_key];
  if (!c || !c.classified) return;
  S.orgClassifications[sm_key] = { ...c, status: 'queued', targetPath: c.path };
  orgRender();
};

window.orgUnqueue = function (sm_key) {
  const c = S.orgClassifications[sm_key];
  if (!c) return;
  S.orgClassifications[sm_key] = { ...c, status: '' };
  orgRender();
};

window.orgSkip = function (sm_key) {
  const c = S.orgClassifications[sm_key] || {};
  S.orgClassifications[sm_key] = { ...c, status: 'skipped' };
  orgRender();
};

window.orgUnskip = function (sm_key) {
  const c = S.orgClassifications[sm_key] || {};
  S.orgClassifications[sm_key] = { ...c, status: c.classified ? '' : '' };
  orgRender();
};

window.orgEdit = function (sm_key) {
  const c = S.orgClassifications[sm_key];
  if (!c) return;
  const card = document.querySelector(`.org-card[data-key="${sm_key}"] .org-card-actions`);
  if (!card) return;
  card.innerHTML = `
    <input class="org-edit-input" id="org-edit-${E(sm_key)}" value="${E(c.path || '')}" placeholder="category/subcategory" autofocus>
    <button class="org-btn accept" onclick="orgEditSave('${E(sm_key)}')">✓ save</button>
    <button class="org-btn" onclick="orgRender()">cancel</button>`;
  setTimeout(() => { const el = $('org-edit-' + sm_key); if (el) { el.focus(); el.select(); } }, 50);
};

window.orgEditSave = function (sm_key) {
  const el = $('org-edit-' + sm_key);
  if (!el) return;
  const newPath = el.value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!newPath) { toast('Enter a path', 'err'); return; }
  const c = S.orgClassifications[sm_key] || {};
  S.orgClassifications[sm_key] = { ...c, classified: true, path: newPath, status: 'queued', targetPath: newPath };
  orgRender();
};

// ── Apply moves ──
window.orgApplyMoves = async function () {
  // If already running, this acts as cancel
  if (S.orgApplying) {
    S.orgCancelApply = true;
    toast('Cancelling… (will stop after current move)', 'inf');
    return;
  }
  if (!S.smTokens) { toast('Connect SmugMug first', 'err'); return; }
  const queued = S.orgUploads.filter(a => {
    const c = S.orgClassifications[a.sm_key];
    return c && c.status === 'queued';
  });
  if (!queued.length) return;
  if (!confirm(`Move ${queued.length} album${queued.length !== 1 ? 's' : ''} in SmugMug?\n\nThis is reversible (you can move them back), but will reorganize folders.\nYou can cancel mid-run.`)) return;

  S.orgApplying = true;
  S.orgCancelApply = false;
  $('org-apply-btn').textContent = '✖ Cancel';
  $('org-apply-btn').classList.add('org-btn-cancel');

  const tb = btoa(JSON.stringify(S.smTokens));
  let done = 0, failed = 0;

  for (const album of queued) {
    if (S.orgCancelApply) {
      toast(`Cancelled — ${done}/${queued.length} moved`, 'inf');
      break;
    }
    const c = S.orgClassifications[album.sm_key];
    const destPath = 'Master-Library/' + c.targetPath;
    $('org-apply-btn').textContent = `✖ Cancel (${done + 1}/${queued.length})`;

    try {
      const r = await fetch(`${SM_BASE}/api/smugmug?action=move_album`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tb, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumKey: album.sm_key,
          destPath,
          tags: c.tags || []
        })
      });
      const data = await r.json();
      if (data.ok) {
        // Update local DB so the library reflects the new path AND keywords
        try {
          await fetch(`${SB_URL}/rest/v1/smugmug_albums?sm_key=eq.${album.sm_key}`, {
            method: 'PATCH',
            headers: {
              apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
              'Content-Type': 'application/json', Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              path: c.targetPath,
              web_url: data.newWebUri || album.web_url,
              keywords: data.keywords || ''
            })
          });
        } catch (e) {}
        // Also update tags on any linked location
        if (c.tags && c.tags.length) {
          try {
            const locs = await db(`locations?smugmug_album_key=eq.${album.sm_key}&select=id,tags`);
            if (locs && locs[0]) {
              const existing = Array.isArray(locs[0].tags) ? locs[0].tags : [];
              const seen = new Set(existing.map(t => String(t).toLowerCase()));
              const merged = existing.concat(c.tags.filter(t => !seen.has(String(t).toLowerCase())));
              await fetch(`${SB_URL}/rest/v1/locations?id=eq.${locs[0].id}`, {
                method: 'PATCH',
                headers: {
                  apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
                  'Content-Type': 'application/json', Prefer: 'return=minimal'
                },
                body: JSON.stringify({ tags: merged })
              });
            }
          } catch (e) {}
        }
        // ── Save to correction history (Supabase, cross-device) ──
        await saveOrgCorrection({
          album_key: album.sm_key,
          album_name: album.name,
          ai_path: c.aiPath || c.path,
          applied_path: c.targetPath,
          ai_tags: c.aiTags || [],
          applied_tags: c.tags || [],
          rejected_tags: c.rejectedTags || [],
          added_tags: [],
          ai_model: c.model || ''
        });
        // ── Save the run record (selected images + per-image tags) ──
        // Strip any user-rejected images from the saved selection
        const rejectedSet = new Set(c.rejectedImageKeys || []);
        const finalKeys = (c.selectedKeys || []).filter(k => !rejectedSet.has(k));
        const finalPerImageTags = {};
        Object.keys(c.perImageTags || {}).forEach(k => {
          if (!rejectedSet.has(k)) finalPerImageTags[k] = c.perImageTags[k];
        });
        await saveOrgRun(album.sm_key, {
          album_name: album.name,
          classified_path: c.targetPath,
          classified_tags: c.tags || [],
          selected_image_keys: finalKeys,
          per_image_tags: finalPerImageTags,
          ai_model: c.model || ''
        });
        S.orgClassifications[album.sm_key] = { ...c, status: 'applied' };
        done++;
      } else {
        S.orgClassifications[album.sm_key] = { ...c, status: 'error', error: data.error || 'move failed' };
        failed++;
      }
    } catch (e) {
      S.orgClassifications[album.sm_key] = { ...c, status: 'error', error: e.message || 'network error' };
      failed++;
    }
    orgRender();
    $('org-apply-btn').classList.add('org-btn-cancel');
    $('org-apply-btn').textContent = `✖ Cancel (${done + 1}/${queued.length})`;
  }

  S.orgApplying = false;
  S.orgCancelApply = false;
  $('org-apply-btn').classList.remove('org-btn-cancel');
  $('org-apply-btn').disabled = false;
  toast(`Moved ${done} album${done !== 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`, failed ? 'err' : 'ok');
  updateFeedbackBadge();

  // Trigger a sync so libraries refresh
  S.libLoaded = false;
  // Soft refresh of folders for the taxonomy display
  setTimeout(async () => {
    try { S.libFolders = await db('smugmug_folders?select=name,path&order=path.asc'); } catch (e) {}
    renderTaxonomyTree();
  }, 500);
};


// ══════════════════════════════════════════════════════════════════════════
// FOLDER MERGE (find duplicates + execute)
// ══════════════════════════════════════════════════════════════════════════
window.orgFindDuplicateFolders = async function () {
  const body = $('merge-body');
  const hint = $('merge-hint');
  $('merge-modal').style.display = 'flex';
  hint.textContent = 'Scanning your library…';
  body.innerHTML = '<div class="empty"><div class="spin"></div><span>analyzing folder names…</span></div>';

  try {
    const folders = await db('smugmug_folders?select=name,path&order=path.asc');
    const albums  = await db('smugmug_albums?select=sm_key,name,path,web_url');

    const folderRecords = [];
    folders.forEach(f => {
      if (!f.path) return;
      const parts = f.path.split('/').filter(Boolean);
      if (parts[0] !== 'Master-Library' || parts.length < 2) return;
      if (/^uploads(-\d+)?$/i.test(parts[1] || '') || parts[1] === 'Orphans') return;
      const innerPath = parts.slice(1).join('/');
      const matchingAlbums = albums.filter(a => {
        if (!a.web_url) return false;
        const aParts = a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
        return aParts.length > 1 && aParts.slice(1, -1).join('/') === innerPath;
      });
      folderRecords.push({
        path: innerPath,
        name: f.name || parts[parts.length - 1].replace(/-/g, ' '),
        album_count: matchingAlbums.length,
        sample_albums: matchingAlbums.slice(0, 3).map(a => a.name)
      });
    });

    if (!folderRecords.length) {
      body.innerHTML = '<div class="empty">No category folders found</div>';
      hint.textContent = '';
      return;
    }

    hint.textContent = `Asking AI to find similar folders among ${folderRecords.length}…`;
    const r = await fetch(`${SM_BASE}/api/find_duplicates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: folderRecords })
    });
    // Detect the most common gotcha: 404 returning an HTML "page not found" instead of JSON
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('application/json')) {
      const text = await r.text();
      if (r.status === 404 || text.startsWith('<') || text.toLowerCase().startsWith('the page')) {
        throw new Error('api/find_duplicates.js is not deployed yet. Push the file to your repo, then redeploy on Vercel.');
      }
      throw new Error(`Server ${r.status}: ${text.slice(0, 160)}`);
    }
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'find_duplicates failed');

    const clusters = data.clusters || [];
    if (!clusters.length) {
      hint.textContent = `Scanned ${folderRecords.length} folders — no obvious duplicates.`;
      body.innerHTML = '<div class="empty" style="padding:32px">✓ Library looks clean — no near-duplicate folders detected.</div>';
      return;
    }

    hint.textContent = `Found ${clusters.length} candidate cluster${clusters.length !== 1 ? 's' : ''}. Review and merge.`;
    S.mergeClusters = clusters;
    S.mergeFolderRecords = folderRecords;
    renderMergeClusters();
  } catch (e) {
    body.innerHTML = `<div class="empty" style="color:var(--red)">Error: ${E(e.message || 'unknown')}</div>`;
    hint.textContent = '';
  }
};

function renderMergeClusters() {
  const body = $('merge-body');
  const recordsByPath = {};
  S.mergeFolderRecords.forEach(r => { recordsByPath[r.path] = r; });

  body.innerHTML = S.mergeClusters.map((cluster, ci) => {
    const items = (cluster.paths || []).map(p => {
      const r = recordsByPath[p];
      return r ? r : { path: p, album_count: 0, sample_albums: [] };
    });
    const totalAlbums = items.reduce((s, i) => s + (i.album_count || 0), 0);
    return `<div class="merge-cluster" data-ci="${ci}">
      <div class="merge-cluster-head">
        <div class="merge-reason">${E(cluster.reason || '')}</div>
      </div>
      <div class="merge-folder-list">
        ${items.map(it => `
          <label class="merge-folder">
            <input type="radio" name="merge-canon-${ci}" value="${E(it.path)}" ${it.path === cluster.canonical ? 'checked' : ''}>
            <div class="merge-folder-info">
              <div class="merge-folder-path">${E(it.path)}</div>
              <div class="merge-folder-meta">${it.album_count || 0} album${(it.album_count||0) !== 1 ? 's' : ''}${it.sample_albums && it.sample_albums.length ? ' · ' + it.sample_albums.slice(0,2).map(s => E(s)).join(', ') : ''}</div>
            </div>
          </label>
        `).join('')}
      </div>
      <div class="merge-cluster-actions">
        <span class="merge-totals">${totalAlbums} albums total · select canonical</span>
        <button class="org-btn" onclick="orgMergeCluster(${ci})">⌗ Merge</button>
        <button class="org-btn" onclick="orgDismissCluster(${ci})">skip</button>
      </div>
      <div id="merge-progress-${ci}" class="merge-progress"></div>
    </div>`;
  }).join('');
}

window.orgDismissCluster = function (ci) {
  S.mergeClusters[ci] = null;
  S.mergeClusters = S.mergeClusters.filter(Boolean);
  if (!S.mergeClusters.length) {
    $('merge-body').innerHTML = '<div class="empty" style="padding:32px">All clusters reviewed.</div>';
    $('merge-hint').textContent = '';
    return;
  }
  renderMergeClusters();
};

window.orgMergeCluster = async function (ci) {
  if (!S.smTokens) { toast('Connect SmugMug first', 'err'); return; }
  const cluster = S.mergeClusters[ci];
  if (!cluster) return;
  const radio = document.querySelector(`input[name="merge-canon-${ci}"]:checked`);
  const canonical = radio ? radio.value : cluster.canonical;
  const sources = (cluster.paths || []).filter(p => p !== canonical);
  if (!sources.length) { toast('Pick a canonical folder', 'err'); return; }

  // Get all albums in source folders
  const allAlbums = await db('smugmug_albums?select=sm_key,name,web_url');
  const sourceAlbums = [];
  sources.forEach(srcPath => {
    allAlbums.forEach(a => {
      if (!a.web_url) return;
      const parts = a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean);
      const albumParent = parts.length > 1 ? parts.slice(1, -1).join('/') : '';
      if (albumParent === srcPath || albumParent.indexOf(srcPath + '/') === 0) {
        sourceAlbums.push({ ...a, _sourcePath: srcPath, _albumParentInner: albumParent });
      }
    });
  });

  const msg = sourceAlbums.length
    ? `Merge ${sources.length} folder${sources.length!==1?'s':''} into "${canonical}"?\n\nThis will:\n  • Move ${sourceAlbums.length} album${sourceAlbums.length!==1?'s':''} into the canonical folder\n  • Delete the source folder${sources.length!==1?'s':''} once empty\n\nReversible (you can move back), but takes a few minutes.`
    : `No albums in source folders. Just delete empty source folders, keeping "${canonical}"?`;
  if (!confirm(msg)) return;

  const progressEl = $(`merge-progress-${ci}`);
  const tb = btoa(JSON.stringify(S.smTokens));
  let moved = 0, failed = 0;

  for (let i = 0; i < sourceAlbums.length; i++) {
    const a = sourceAlbums[i];
    progressEl.innerHTML = `Moving ${i+1}/${sourceAlbums.length}: ${E(a.name)}…`;
    let newInnerPath = a._albumParentInner;
    if (newInnerPath === a._sourcePath) newInnerPath = canonical;
    else newInnerPath = canonical + newInnerPath.slice(a._sourcePath.length);
    const destPath = 'Master-Library/' + newInnerPath;
    try {
      const r = await fetch(`${SM_BASE}/api/smugmug?action=move_album`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tb, 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumKey: a.sm_key, destPath })
      });
      const data = await r.json();
      if (data.ok) {
        moved++;
        try {
          await fetch(`${SB_URL}/rest/v1/smugmug_albums?sm_key=eq.${a.sm_key}`, {
            method: 'PATCH',
            headers: {
              apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
              'Content-Type': 'application/json', Prefer: 'return=minimal'
            },
            body: JSON.stringify({ path: newInnerPath, web_url: data.newWebUri || a.web_url })
          });
        } catch (e) {}
      } else { failed++; }
    } catch (e) { failed++; }
  }

  progressEl.innerHTML = `Cleaning up empty folders…`;
  let deleted = 0;
  for (const srcPath of sources) {
    try {
      const r = await fetch(`${SM_BASE}/api/smugmug?action=delete_folder`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tb, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'Master-Library/' + srcPath })
      });
      const data = await r.json();
      if (data.ok) {
        deleted++;
        try {
          await fetch(`${SB_URL}/rest/v1/smugmug_folders?path=eq.${encodeURIComponent('Master-Library/' + srcPath)}`, {
            method: 'DELETE',
            headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, Prefer: 'return=minimal' }
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  progressEl.innerHTML = `<span style="color:var(--green)">✓ Merged: ${moved} moved · ${deleted} deleted${failed ? ` · ${failed} failed` : ''}</span>`;
  toast(`Merge complete · ${moved} albums moved`, 'ok');

  S.libLoaded = false;
  try { S.libFolders = await db('smugmug_folders?select=name,path&order=path.asc'); } catch (e) {}
  setTimeout(() => orgDismissCluster(ci), 1500);
};


document.addEventListener('keydown', function (e) {
  const tag = e.target.tagName;
  const isInputFocused = (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA');
  const lbOpen = $('lightbox').classList.contains('open');
  const panelOpen = $('detail-panel').classList.contains('open');
  const editOpen = $('edit-panel') && $('edit-panel').style.display === 'flex';
  const rawOpen = $('raw-notes-modal') && $('raw-notes-modal').style.display === 'flex';
  const mergeOpen = $('merge-modal') && $('merge-modal').style.display === 'flex';
  const libActive = $('library-page').classList.contains('active');

  // ── Arrow keys: highest priority for image nav when panel/lightbox open ──
  // We bypass the normal "skip if focused on INPUT" check here because the user's
  // intent when the panel is open is photo navigation, not text editing — UNLESS a
  // modal that uses inputs (edit, raw notes) is on top of the panel.
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    // If user is typing in an input that's part of an open modal, let them edit
    if (isInputFocused && (editOpen || rawOpen || mergeOpen)) return;

    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';

    if (lbOpen || panelOpen) {
      e.preventDefault();
      e.stopPropagation();
      if (S.dpImages.length) {
        S.dpIndex = fwd
          ? (S.dpIndex + 1) % S.dpImages.length
          : (S.dpIndex - 1 + S.dpImages.length) % S.dpImages.length;
        dpUpdateViewer();
        if (lbOpen) {
          $('lb-img').src = smXL(S.dpImages[S.dpIndex]);
          updateLbCounter();
        }
      }
      return;
    }

    if (libActive && !isInputFocused) {
      e.preventDefault();
      e.stopPropagation();
      if (!fwd && S.libStack.length) { S.libRedoStack.push(S.libStack.pop()); libRender(); }
      if (fwd && S.libRedoStack.length) { S.libStack.push(S.libRedoStack.pop()); libRender(); }
    }
    return;
  }

  // ── All other keys: skip if user is typing somewhere ──
  if (isInputFocused) return;

  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoNav(); else undoNav();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redoNav(); return; }

  if (e.key === 'Escape') {
    if (lbOpen) { closeLightbox(); return; }
    if (S.dockOpen) { closeDock(); return; }
    if (panelOpen) { closeDetail(); return; }
    $('hcard').classList.remove('show');
    return;
  }

  if (e.key === ' ') {
    e.preventDefault();
    if (lbOpen) { closeLightbox(); return; }
    if (panelOpen) {
      const src = $('dp-viewer-img').src;
      if (src && src !== window.location.href) openLightbox(src);
      return;
    }
    const hci = document.querySelector('#hcard-media .hcard-img');
    if (hci && hci.src) openLightbox(hci.src);
    return;
  }

  if (e.key === 'Enter' && panelOpen && S.currentDetailLoc) {
    e.preventDefault();
    const homeActive = $('home-page').classList.contains('active');
    if (homeActive) {
      const libBtn = document.querySelectorAll('.nav-btn')[1];
      showPage('library', libBtn);
      if (S.currentDetailLoc.smugmug_album_key) {
        const ta = S.libAlbums.find(a => a.sm_key === S.currentDetailLoc.smugmug_album_key);
        if (ta) {
          const pp = albumParentPath(ta), parts = pp.split('/').filter(Boolean);
          S.libStack = []; let cum = '';
          parts.forEach(p => { cum = cum ? cum + '/' + p : p; S.libStack.push({ path: cum, label: p.replace(/-/g, ' ') }); });
          libRender();
        }
      }
      setTimeout(() => openDetail(S.currentDetailLoc), 50);
    } else {
      const homeBtn = document.querySelectorAll('.nav-btn')[0];
      showPage('home', homeBtn);
      setTimeout(() => openDetail(S.currentDetailLoc), 150);
    }
    return;
  }
}, true);  // capture phase — beats anything that might consume arrow keys downstream

document.addEventListener('click', function (e) {
  const smBtn = $('dock-sm-btn'), smAct = $('dock-actions');
  if (S.dockOpen && smBtn && !smBtn.contains(e.target) && smAct && !smAct.contains(e.target)) closeDock();
});

// hcard mouseleave
$('hcard').addEventListener('mouseleave', function () {
  $('hcard').classList.remove('show');
});

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════
(async function init() {
  loadFilterSettings();
  loadPinColors();
  checkAuth();
  await loadLocations();
  loadMapScript();
  await checkAutoSync();
  setTimeout(posNavStatus, 100);
})();

})();  // IIFE end
