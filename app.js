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

const CAT_PALETTE = [
  '#4a9edd', '#3dbb7a', '#e8832a', '#9060d0', '#e04545',
  '#20b8c0', '#d4b800', '#e060a8', '#68bb28', '#3060d8',
  '#e06830', '#28b0e0', '#c03838', '#40cc90', '#a030d0',
  '#d0a000', '#28b888', '#d83880', '#88cc20', '#3888d8',
  '#e05020', '#18c8b8', '#98cc18', '#e03068', '#2878e8'
];

const NAV_HISTORY_MAX = 50;
const LOC_CACHE_KEY = 'loc_cache_v2';
const LOC_CACHE_TTL = 15 * 60 * 1000;
const LOC_SELECT = 'id,name,lat,lng,status,state_code,city,address,address_cross,zip,address_verified,address_candidates,smugmug_album_key,smugmug_gallery_url,cover_photo_url,notes,notes_override,tags,scout_name,scout_date';

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
  zoneOn: false, satOn: false, miniMap: null, miniMarker: null,
  // Filters
  catPinColors: {}, savedCatColors: {},
  highlightedCat: null, selectedAreas: new Set(),
  // UI
  currentHoverLoc: null, currentDetailLoc: null,
  dpImages: [], dpIndex: 0, dpRequestToken: 0,
  smTokens: null, dockOpen: false,
  editingLoc: null, addrEditing: false,
  navHistory: [], navFuture: []
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
  try {
    const data = await db(`locations?select=${LOC_SELECT}&order=name.asc`);
    S.locations = data;
    rebuildLookups();
    try { localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
    return S.locations;
  } catch (e) { toast('DB error', 'err'); return []; }
}

async function refreshLocationsBackground() {
  try {
    const data = await db(`locations?select=${LOC_SELECT}&order=name.asc`);
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
function getActiveStates()   { return ['ny','nj','ct','pa'].filter(s => $('f-' + s)?.checked).map(s => s.toUpperCase()); }
function getActiveStatuses() { return ['approved','scouted','pending','identified'].filter(s => $('f-' + s)?.checked); }
function zoneFilterActive()  { return $('f-zone')?.checked; }

function locPassesGlobalFilter(l) {
  const states = getActiveStates(), statuses = getActiveStatuses();
  if (states.length && l.state_code && states.indexOf((l.state_code||'').toUpperCase()) < 0) return false;
  if (statuses.length && statuses.indexOf(l.status) < 0) return false;
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
  ['ny','nj','ct','pa','approved','scouted','pending','identified'].forEach(id => {
    const el = $('f-' + id); if (el) s['f-'+id] = el.checked;
  });
  try { localStorage.setItem('mapFilters', JSON.stringify(s)); } catch (e) {}
}

function loadFilterSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mapFilters') || '{}');
    ['ny','nj','ct','pa','approved','scouted','pending','identified'].forEach(id => {
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
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GM_KEY}&callback=initMap&loading=async`;
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
    isFractionalZoomEnabled: true, styles: MAP_STYLE
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

function makeIcon(col, scale, stroke, opacity, sw) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: scale || 8, fillColor: col,
    fillOpacity: opacity || 0.9,
    strokeColor: stroke || 'rgba(0,0,0,.5)',
    strokeWeight: sw || 1.5
  };
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
  const fill   = clusterColor ? clusterColor + '22' : '#1c1e22';
  const stroke = clusterColor || 'rgba(255,255,255,0.12)';
  const text   = clusterColor || '#e6e4de';
  const size = count > 99 ? 48 : count > 9 ? 42 : 36;
  const r = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r-2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${r}" y="${r+4}" text-anchor="middle" font-family="DM Mono,monospace" font-size="11" fill="${text}">${count}</text></svg>`;
  return new google.maps.Marker({
    position: cluster.position,
    icon: {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(r, r)
    },
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
  $('hcard-status').innerHTML = `<span style="color:${sl.c}">${E(loc.status)}</span>`;
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
window.openDetail = function (loc) {
  if (!loc) return;
  if (S.currentDetailLoc !== loc) pushNav();
  S.currentDetailLoc = loc;
  S.dpRequestToken++;  // invalidate any in-flight gallery loads
  $('hcard').classList.remove('show');

  // Header
  const displayName = loc.name.replace(/[\s*]*pending[\s*]*/gi, '').trim();
  $('dp-name').textContent = displayName;
  const cat = getCatForLoc(loc);
  const col = cat ? catColorByKey(cat) : '';
  const pill = $('dp-cat-pill');
  if (cat) {
    pill.textContent = cat.replace(/-/g, ' ');
    pill.style.background = col + '22';
    pill.style.color = col;
    pill.style.display = '';
  } else { pill.style.display = 'none'; }
  const zb = $('dp-zone-badge');
  zb.textContent = hasCoords(loc) && miles(loc.lat, loc.lng) <= 30 ? '· in zone' : '';
  zb.style.color = 'var(--green)';

  // Images
  S.dpImages = loc.cover_photo_url ? [loc.cover_photo_url] : [];
  S.dpIndex = 0;
  dpUpdateViewer();

  // Body
  const sl = SL[loc.status] || SL.identified;
  const parsed = window.NotesParser ? NotesParser.parse(loc.notes, { locName: loc.name }) : null;

  let html = '';

  // Address verification widget (top of body if unverified)
  const needsVerify = !loc.address_verified;
  if (needsVerify) {
    html += renderVerifyWidget(loc, parsed);
  }

  // Status badge
  html += `<div class="dp-status-row"><span class="dp-badge" style="background:${sl.bg};color:${sl.c}">${E(loc.status)}</span></div>`;

  // Saved address (if verified or has data)
  if ((loc.address_verified && loc.address) || loc.address || loc.city) {
    const addrPart = (loc.address || '').trim();
    const cityPart = (loc.city || '').trim();
    const statePart = (loc.state_code || '').trim();
    const zipPart = (loc.zip || '').trim();
    const cleanCity = cityPart && addrPart.toLowerCase().indexOf(cityPart.toLowerCase()) >= 0 ? '' : cityPart;
    const mapsQ = encodeURIComponent([addrPart, cleanCity, statePart, zipPart].filter(Boolean).join(' '));
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + mapsQ;
    html += `<div class="dp-section"><div class="dp-label">Address</div><div class="dp-val" style="line-height:1.8"><a href="${mapsUrl}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;border-bottom:1px solid var(--border2)">`;
    if (addrPart) html += E(addrPart);
    const cityState = [E(cleanCity), E(statePart)].filter(Boolean).join(', ');
    if (addrPart && cityState) html += '<br>';
    if (cityState) html += cityState;
    if (zipPart) html += ' ' + E(zipPart);
    html += '</a>';
    if (loc.address_cross) html += `<div style="font-size:11px;color:var(--text3);font-style:italic;margin-top:4px">${E(loc.address_cross)}</div>`;
    html += '</div></div>';
  }

  // Notes (rendered via shared parser)
  if (parsed && window.NotesParser) {
    const notesHtml = NotesParser.renderHtml(parsed, { showAddress: false });
    if (notesHtml) html += `<div class="dp-section"><div class="dp-notes">${notesHtml}</div></div>`;
  } else if (loc.notes) {
    // Fallback: raw notes if parser missing
    html += `<div class="dp-section"><div class="dp-notes" style="white-space:pre-wrap;font-size:12px;color:var(--text2)">${E(loc.notes)}</div></div>`;
  }

  // Tags
  if (loc.tags && loc.tags.length) {
    html += '<div class="dp-section"><div class="dp-label">Tags</div><div class="dp-tags">';
    loc.tags.forEach(t => { html += `<span class="dp-tag">${E(t)}</span>`; });
    html += '</div></div>';
  }

  // Scout
  if (loc.scout_name || loc.scout_date) {
    html += `<div class="dp-section"><div class="dp-label">Scouted by</div><div class="dp-val">${E(loc.scout_name || '')}${loc.scout_date ? ' · ' + E(loc.scout_date) : ''}</div></div>`;
  }

  // Actions
  html += '<div class="dp-actions">';
  html += '<button class="dp-btn" onclick="openEditPanel(S.currentDetailLoc)" aria-label="Edit location">✏ Edit</button>';
  if (loc.notes) html += '<button class="dp-btn" onclick="showRawNotes(S.currentDetailLoc)" aria-label="Show raw notes">raw notes</button>';
  if (loc.smugmug_gallery_url) html += `<button class="dp-btn" onclick="window.open('${E(loc.smugmug_gallery_url)}','_blank')" aria-label="Open in SmugMug">gallery ↗</button>`;
  html += '</div>';

  $('dp-body').innerHTML = html;

  $('detail-panel').classList.add('open');
  $('dp-scroll').scrollTop = 0;

  // Initialize the mini map preview if widget is showing
  if (needsVerify) setTimeout(() => initVerifyMiniMap(loc, parsed), 100);

  if ($('home-page').classList.contains('active')) {
    highlightPin(loc);
    setTimeout(() => panToVisible(loc), 300);
  }
  loadDetailGallery(loc);
};

window.closeDetail = function () {
  $('detail-panel').classList.remove('open');
  S.currentDetailLoc = null;
  if (S.selectionOverlay) { S.selectionOverlay.setMap(null); S.selectionOverlay = null; }
  S.miniMap = null; S.miniMarker = null;
};

// ── Address verification widget ────────────────────────────────────────────
function renderVerifyWidget(loc, parsed) {
  // Determine candidates: parsed candidates + saved candidates from DB
  const dbCandidates = Array.isArray(loc.address_candidates) ? loc.address_candidates : [];
  const parsedCandidates = (parsed && parsed.addressCandidates) || [];
  const candidates = parsedCandidates.length ? parsedCandidates : dbCandidates;
  const primary = candidates[0] || null;

  const street = primary ? (primary.street || loc.address || '') : (loc.address || '');
  const cross  = primary ? (primary.cross  || loc.address_cross || '') : (loc.address_cross || '');
  const city   = primary ? (primary.city   || loc.city || '') : (loc.city || '');
  const state  = primary ? (primary.state  || loc.state_code || '') : (loc.state_code || '');
  const zip    = primary ? (primary.zip    || loc.zip || '') : (loc.zip || '');

  const hasAny = street || city;
  if (!hasAny && !loc.notes) return '';  // nothing to verify, nothing parsed

  let html = '<div class="addr-verify" id="addr-verify-widget">';
  html += '<div class="av-header"><span class="av-icon">⚠</span><span>Address needs verification</span></div>';

  if (hasAny) {
    html += '<div class="av-body">';
    html += '<div class="av-suggest" id="av-suggest">';
    html += `<div class="av-row av-street" id="av-street">${E(street || '(no street)')}</div>`;
    if (cross) html += `<div class="av-row av-cross">${E(cross)}</div>`;
    const cityLine = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
    html += `<div class="av-row av-city" id="av-city">${E(cityLine || '(no city)')}</div>`;
    html += '</div>';
    html += '<div class="av-map" id="av-mini-map"><div class="av-map-placeholder">geocoding…</div></div>';
    html += '</div>';
    html += '<div class="av-actions">';
    html += '<button class="av-btn" onclick="addrEdit()" aria-label="Edit address">✏ edit</button>';
    if (candidates.length > 1) {
      html += '<button class="av-btn" onclick="addrCycleAlternate()" aria-label="Try alternate">↻ alternate</button>';
    }
    html += '<button class="av-btn av-primary" onclick="addrApprove()" aria-label="Approve address">✓ approve</button>';
    html += '</div>';
  } else {
    html += '<div class="av-body"><div class="av-suggest"><div class="av-row" style="color:var(--text3)">No address found in notes — please enter one manually.</div></div></div>';
    html += '<div class="av-actions"><button class="av-btn av-primary" onclick="addrEdit()">+ add address</button></div>';
  }

  html += '</div>';
  return html;
}

// Initialize a mini Google Map showing the geocoded address
async function initVerifyMiniMap(loc, parsed) {
  const container = $('av-mini-map');
  if (!container || !window.google || !google.maps) return;

  const candidates = (parsed && parsed.addressCandidates) || [];
  const primary = candidates[0] || {};
  const query = primary.query || [loc.address, loc.city, loc.state_code, loc.zip].filter(Boolean).join(', ');

  if (!query) {
    container.innerHTML = '<div class="av-map-placeholder">no address to preview</div>';
    return;
  }

  // Use existing lat/lng if available, otherwise geocode
  let lat = loc.lat, lng = loc.lng;
  if (!hasCoords(loc)) {
    try {
      const url = `${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${loc.state_code ? '&state=' + loc.state_code : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.ok) { lat = d.lat; lng = d.lng; }
      else throw new Error(d.error || 'geocode failed');
    } catch (e) {
      container.innerHTML = `<div class="av-map-placeholder" style="color:var(--red)">geocoding failed</div>`;
      return;
    }
  }

  if (!lat || !lng) {
    container.innerHTML = '<div class="av-map-placeholder">no coordinates</div>';
    return;
  }

  container.innerHTML = '';
  S.miniMap = new google.maps.Map(container, {
    zoom: 16, center: { lat: Number(lat), lng: Number(lng) },
    backgroundColor: '#08090b',
    disableDefaultUI: true, gestureHandling: 'cooperative',
    styles: MAP_STYLE
  });
  S.miniMarker = new google.maps.Marker({
    map: S.miniMap, position: { lat: Number(lat), lng: Number(lng) },
    icon: makeIcon('#c8a96e', 12, '#fff', 1, 2.5)
  });
  // Store geocoded coords for approve
  S.miniMap._geocodedLat = lat;
  S.miniMap._geocodedLng = lng;
}

window.addrEdit = function () {
  if (!S.currentDetailLoc) return;
  const loc = S.currentDetailLoc;
  const widget = $('addr-verify-widget');
  if (!widget) return;
  const candidates = Array.isArray(loc.address_candidates) ? loc.address_candidates : [];
  const primary = candidates[0] || {};
  const street = (primary.street || loc.address || '').trim();
  const city   = (primary.city   || loc.city || '').trim();
  const state  = (primary.state  || loc.state_code || '').trim();
  const zip    = (primary.zip    || loc.zip || '').trim();

  const editHtml = `
    <div class="av-edit-row">
      <input id="ave-street" placeholder="Street address" value="${E(street)}" aria-label="Street address">
    </div>
    <div class="av-edit-row" style="display:flex;gap:6px">
      <input id="ave-city" placeholder="City" value="${E(city)}" aria-label="City" style="flex:2">
      <input id="ave-state" placeholder="ST" value="${E(state)}" maxlength="2" aria-label="State" style="flex:0 0 50px;text-transform:uppercase">
      <input id="ave-zip" placeholder="Zip" value="${E(zip)}" maxlength="5" aria-label="Zip" style="flex:0 0 70px">
    </div>
    <div class="av-edit-actions">
      <button class="av-btn" onclick="addrEditCancel()">cancel</button>
      <button class="av-btn av-primary" onclick="addrEditSaveAndApprove()">✓ save & approve</button>
    </div>`;
  qs('.av-suggest', widget).innerHTML = editHtml;
  qs('.av-actions', widget).style.display = 'none';
  S.addrEditing = true;
};

window.addrEditCancel = function () {
  // Re-render the detail to restore the read-only verify widget
  if (S.currentDetailLoc) openDetail(S.currentDetailLoc);
};

window.addrEditSaveAndApprove = async function () {
  if (!S.currentDetailLoc) return;
  const street = $('ave-street').value.trim();
  const city   = $('ave-city').value.trim();
  const state  = $('ave-state').value.trim().toUpperCase();
  const zip    = $('ave-zip').value.trim();

  // Geocode the new address
  const query = [street, city, state, zip].filter(Boolean).join(', ');
  if (!query) { toast('Enter at least a city or street', 'err'); return; }

  toast('Verifying…', 'inf');
  let lat = null, lng = null;
  try {
    const url = `${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${state ? '&state=' + state : ''}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.ok) { lat = d.lat; lng = d.lng; }
  } catch (e) {}

  await saveVerified(S.currentDetailLoc, {
    address: street || null,
    city: city || null,
    state_code: state || null,
    zip: zip || null,
    lat: lat, lng: lng
  });
};

window.addrApprove = async function () {
  if (!S.currentDetailLoc) return;
  const loc = S.currentDetailLoc;
  const candidates = Array.isArray(loc.address_candidates) ? loc.address_candidates : [];
  const primary = candidates[0] || {};

  // Use values currently shown in the widget
  const street = primary.street || loc.address || null;
  const city   = primary.city   || loc.city || null;
  const state  = primary.state  || loc.state_code || null;
  const zip    = primary.zip    || loc.zip || null;
  const cross  = primary.cross  || loc.address_cross || null;

  let lat = (S.miniMap && S.miniMap._geocodedLat) || loc.lat;
  let lng = (S.miniMap && S.miniMap._geocodedLng) || loc.lng;

  // If we have no coordinates yet, geocode now
  if (!lat || !lng) {
    const query = [street, city, state, zip].filter(Boolean).join(', ');
    if (query) {
      try {
        const url = `${SM_BASE}/api/geocode?address=${encodeURIComponent(query)}${state ? '&state=' + state : ''}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d.ok) { lat = d.lat; lng = d.lng; }
      } catch (e) {}
    }
  }

  await saveVerified(loc, {
    address: street, city: city, state_code: state, zip: zip,
    address_cross: cross, lat: lat, lng: lng
  });
};

window.addrCycleAlternate = function () {
  if (!S.currentDetailLoc) return;
  const loc = S.currentDetailLoc;
  const candidates = Array.isArray(loc.address_candidates) ? loc.address_candidates : [];
  if (candidates.length < 2) { toast('No alternates', 'inf'); return; }
  // Rotate: move first to end
  const rotated = candidates.slice(1).concat(candidates.slice(0, 1));
  loc.address_candidates = rotated;
  openDetail(loc);  // re-render
};

async function saveVerified(loc, fields) {
  const updates = Object.assign({}, fields, {
    address_verified: true,
    updated_at: new Date().toISOString()
  });
  try {
    await fetch(`${SB_URL}/rest/v1/locations?id=eq.${loc.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
    Object.assign(loc, updates);
    // Update cache
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
    openDetail(loc);  // re-render without verify widget
    toast('✓ Address verified', 'ok');
  } catch (e) {
    toast('Save failed: ' + (e.message || 'unknown error'), 'err');
  }
}

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
  ctr.style.display = multi ? 'block' : 'none';
  hint.style.display = !none ? 'block' : 'none';
  if (multi) ctr.textContent = (S.dpIndex+1) + ' / ' + S.dpImages.length;
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
  try {
    const imgs = await db('smugmug_images?album_key=eq.' + loc.smugmug_album_key + '&select=thumb_url');
    if (myToken !== S.dpRequestToken) return;  // stale
    if (!imgs || !imgs.length) return;
    const thumbs = imgs.map(i => i.thumb_url).filter(Boolean);
    const cover = loc.cover_photo_url;
    S.dpImages = cover ? [cover].concat(thumbs.filter(t => t !== cover)) : thumbs;
    dpUpdateViewer();
  } catch (e) { console.error('gallery:', e); }
}

// ══════════════════════════════════════════════════════════════════════════
// EDIT PANEL
// ══════════════════════════════════════════════════════════════════════════
window.openEditPanel = function (loc) {
  if (!loc) return;
  S.editingLoc = loc;
  $('edit-name').value    = loc.name || '';
  $('edit-address').value = loc.address || '';
  $('edit-city').value    = loc.city || '';
  $('edit-notes').value   = loc.notes || '';
  $('edit-panel').style.display = 'flex';
  $('edit-name').focus();
};
window.closeEditPanel = function () {
  $('edit-panel').style.display = 'none';
  S.editingLoc = null;
};

window.saveEdit = async function () {
  if (!S.editingLoc) return;
  const btn = $('edit-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  const updates = {
    name:           $('edit-name').value.trim(),
    address:        $('edit-address').value.trim(),
    city:           $('edit-city').value.trim(),
    notes:          $('edit-notes').value,
    notes_override: true,
    address_verified: ($('edit-address').value.trim() ? true : S.editingLoc.address_verified)
  };
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
    rebuildLookups();
    closeEditPanel();
    openDetail(S.editingLoc);
    toast('Saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  btn.textContent = 'Save'; btn.disabled = false;
};

window.showRawNotes = function (loc) {
  if (!loc) return;
  $('raw-notes-content').textContent = loc.notes || '(no notes)';
  $('raw-notes-modal').style.display = 'flex';
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

  const directAlbums = S.libAlbums.filter(a => {
    if (albumParentPath(a) !== targetPath) return false;
    const loc = locByAlbumKey.get(a.sm_key);
    if (loc && !locPassesGlobalFilter(loc)) return false;
    return true;
  });

  let cards = '';

  subFolders.forEach(f => {
    const children = S.libAlbums.filter(a => {
      const p = albumParentPath(a);
      if (p !== f.path && p.indexOf(f.path + '/') !== 0) return false;
      const loc = locByAlbumKey.get(a.sm_key);
      return !loc || locPassesGlobalFilter(loc);
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

  directAlbums.forEach(a => {
    const loc = locByAlbumKey.get(a.sm_key);
    const thumb = (loc && loc.cover_photo_url) || a.highlight_url || '';
    const sl = loc ? (SL[loc.status] || SL.identified) : null;
    const isSelected = S.currentDetailLoc && loc && S.currentDetailLoc.id === loc.id;
    const aCat = a.web_url ? a.web_url.replace('https://jordanhoffman.smugmug.com/', '').split('/').filter(Boolean)[1] : '';
    const glow = (S.catPinColors[aCat] || S.savedCatColors[aCat])
      ? 'box-shadow:0 0 6px 2px ' + hexToRgba(S.catPinColors[aCat] || S.savedCatColors[aCat], 0.55) : '';
    cards += `<div class="gcard${isSelected?' gcard-selected':''}" data-locid="${E(loc ? loc.id : '')}" data-smurl="${E(a.web_url || '#')}" onclick="libCardClick(this)" style="${glow}">`;
    cards += '<div class="gcard-tw">';
    if (thumb) cards += `<img class="gcard-img" src="${E(smMedium(thumb))}" loading="lazy" alt="${E(a.name)} thumbnail" onerror="hideOnError(this)">`;
    cards += '<div class="gcard-ph">◻</div>';
    cards += `<div class="gcard-overlay">${E(a.name)}</div></div>`;
    cards += '<div class="gcard-meta">';
    if (sl) cards += `<span style="color:${sl.c}">${E(loc.status)}</span>`;
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
  if (el.dataset.smurl && el.dataset.smurl !== '#') window.open(el.dataset.smurl, '_blank');
};
window.libFolderClick = function (el) {
  const p = el.getAttribute('data-p'), l = el.getAttribute('data-l');
  if (p) libBrowse(p, l);
};

window.libSearch = function () {
  const q = $('lib-q').value.toLowerCase();
  const status = $('lib-status-sel').value;
  if (!q && !status) { libRender(); return; }
  const grid = $('lib-grid'), bc = $('lib-bc');
  const f = S.locations.filter(l => {
    if (status && l.status !== status) return false;
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
      <div class="gcard-meta"><span style="color:${sl.c}">${E(l.status)}</span><span style="color:var(--text3)">${E([l.city, l.state_code].filter(Boolean).join(', ') || '—')}</span></div></div>`;
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
  if (ok) {
    lbl.textContent = 'smugmug ✓'; btn.classList.remove('unconnected');
    if (ab) ab.style.display = 'none';
    if (sb) sb.style.display = 'flex';
    if (so) so.style.display = 'flex';
  } else {
    lbl.textContent = 'smugmug'; btn.classList.add('unconnected');
    if (ab) ab.style.display = 'flex';
    if (sb) sb.style.display = 'none';
    if (so) so.style.display = 'none';
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

  try {
    if (ns) ns.textContent = 'crawling SmugMug...';
    const crawlResp = await (await fetch(SM_BASE + '/api/smugmug?action=crawl', {
      headers: { Authorization: 'Bearer ' + tb }
    })).json();
    const library = crawlResp.library;
    const smAlbums = library.albums || [];
    if (ns) ns.textContent = `found ${smAlbums.length} albums — syncing structure...`;

    // Sync structure with mode='full' so server knows it can prune
    await fetch(SM_BASE + '/api/sync', {
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
      const batch = remaining.slice(i, i + BATCH);
      if (ns) ns.textContent = `images ${i+1}-${Math.min(i+BATCH, remaining.length)}/${remaining.length}`;
      await Promise.all(batch.map(async alb => {
        try {
          const r = await (await fetch(SM_BASE + `/api/smugmug?action=album-images&albumKey=${alb.sm_key}`, {
            headers: { Authorization: 'Bearer ' + tb }
          })).json();
          const imgs = r.images || [];
          const desc = r.description || '';
          if (imgs.length) {
            await fetch(SM_BASE + '/api/sync', {
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
  const zb = $('zone-btn');
  if (zb) zb.style.display = page === 'home' ? 'flex' : 'none';
  if (page === 'home') {
    if (!S.mapReady) loadMapScript();
    else if (S.gmap) setTimeout(() => google.maps.event.trigger(S.gmap, 'resize'), 50);
  }
  if (page === 'library') libInit();
};

// ══════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', function (e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const lbOpen = $('lightbox').classList.contains('open');
  const panelOpen = $('detail-panel').classList.contains('open');
  const libActive = $('library-page').classList.contains('active');

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

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    if (lbOpen || panelOpen) {
      if (S.dpImages.length) {
        S.dpIndex = fwd ? (S.dpIndex+1) % S.dpImages.length : (S.dpIndex - 1 + S.dpImages.length) % S.dpImages.length;
        dpUpdateViewer();
        if (lbOpen) {
          $('lb-img').src = smXL(S.dpImages[S.dpIndex]);
          updateLbCounter();
        }
      }
      return;
    }
    if (libActive) {
      if (!fwd && S.libStack.length) { S.libRedoStack.push(S.libStack.pop()); libRender(); }
      if (fwd && S.libRedoStack.length) { S.libStack.push(S.libRedoStack.pop()); libRender(); }
    }
  }
});

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
