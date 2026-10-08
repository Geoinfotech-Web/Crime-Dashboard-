/* ═══════════════════════════════════════════════════════════════════════
   TRAVEL SAFETY — intercity corridors, route-risk map, incident timing,
   and departure/route recommendations.

   Any two towns on the network can be chosen. The corridors below are its
   edges; a trip is planned as a chain of them, and up to three genuinely
   different chains are offered side by side.

   Each chain is then laid on the real road network (/api/road-route — see
   route_roads.py): the line drawn, the distance, the driving time, the
   directions and the states crossed all come from the road as it is
   actually driven. The corridor waypoints stay as the
   risk knowledge, pinned to the nearest point of that road. If the routing
   server cannot be reached the corridor's own straight-line estimate is
   shown instead, and marked as approximate.

   Each route's assessment combines four things:
     • the corridor's baseline segment risk,
     • the hotspot index of the states it crosses,
     • the hour of departure,
     • what regional and national outlets have reported along the road in
       the last week (/api/route-news — see route_news.py).

   Loaded after app.js and hotspot.js (shares global scope). The hourly curve
   is a documented MODEL (daylight-safe / dusk-and-night elevated), nudged by
   the times of day that recent reports mention; it is not per-hour data.
   ═══════════════════════════════════════════════════════════════════════ */
let travelInitialized = false, travelMap = null, travelMapGroup = null, tvHourChart = null;
let tvMode = 'Car';
// The options for the trip on screen, and the one being looked at. The
// selected route keeps the name tvCurrentCorridor because app.js reads it.
let tvRoutes = [], tvSelectedRoute = 0, tvCurrentCorridor = null;
// News per route, keyed by the towns it passes: { status, data, error }.
const tvNewsStore = new Map();
// The road-network answer per route, same shape, keyed by the towns and — for
// a bus trip — the parks it runs between.
const tvRoadStore = new Map();
// Bus parks by town (bus_parks.json), and the two chosen for the trip on screen.
let tvParks = {};
const tvParkChoice = { from: null, to: null };
let tvNewsFilter = 'all';
let tvNewsTimer = null;

// Keyless Esri Canvas basemaps (same source the dashboard uses).
const TV_DARK_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_LIGHT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_TILE_OPTS = { attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors', maxZoom: 16 };
const TV_ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
// Basemaps the traveller can switch between. "dark" says whether labels drawn
// over it need to be light. Canvas follows the app's light/dark theme.
const TV_BASEMAPS = {
  canvas:    { label: 'Canvas', icon: 'ti-map', themed: true },
  streets:   { label: 'Streets', icon: 'ti-road', dark: false, maxNativeZoom: 19,
               url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors' },
  satellite: { label: 'Satellite', icon: 'ti-satellite', dark: true, maxNativeZoom: 18,
               url: `${TV_ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
               labels: `${TV_ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
               attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
  terrain:   { label: 'Terrain', icon: 'ti-mountain', dark: false, maxNativeZoom: 18,
               url: `${TV_ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors' }
};
let tvBasemap = 'canvas', tvBaseLayers = [];

// Relative incident likelihood by hour of day (0–23). Modelled: lowest mid-day,
// rising through late afternoon, peaking at dusk/evening, elevated overnight.
const TV_HOURLY = [42,38,34,33,36,42, 36,30,26,20,17,16, 18,20,24,34,48,66, 82,95,92,80,66,60];
// Hours a report means when it says "at night", "at dawn" and so on.
const TV_DAYPART_HOURS = {
  night: [20,21,22,23,0,1,2,3], evening: [17,18,19,20], dawn: [4,5,6],
  morning: [6,7,8,9,10,11], afternoon: [12,13,14,15,16]
};
const TV_SEG_WEIGHT = { low: 12, caution: 55, high: 100 };
const TV_SEG_COLOR  = { low: '#35d08a', caution: '#f5a623', high: '#ff5a5f' };
const TV_SEG_ORDER  = ['low', 'caution', 'high'];
const TV_MODE_FACTOR = { Car: 1.0, Bus: 0.93, Convoy: 0.82 };
const TV_NEWS_REFRESH_MS = 10 * 60 * 1000;
const TV_MAX_ROUTES = 3;        // options offered for one trip
const TV_MAX_LEGS = 12;         // longest chain of corridors considered
const TV_DETOUR_LIMIT = 1.7;    // an alternative may take this many times the quickest
const TV_JUNCTION_MIN = 10;     // minutes lost passing through a town between corridors
const TV_FIRST_LIGHT = 6;       // earliest hour worth recommending a departure
const TV_STATE_SAMPLE_KM = 5;   // how often the road is asked which state it is in
const TV_DIRECTION_MIN_KM = 3;  // shorter turns are folded into the road either side
// How the score is put together, with and without live reports.
const TV_SCORE_WEIGHTS = { segments: 0.45, states: 0.20, time: 0.15, live: 0.20 };
const TV_SCORE_WEIGHTS_OFFLINE = { segments: 0.60, states: 0.25, time: 0.15, live: 0 };

const TV_CATEGORY = {
  kidnapping:     { icon: 'ti-lock',            cls: 'c-red',    advice: 'Do not stop for anyone on open road, keep windows up, and avoid the road entirely after dark.' },
  armed_attack:   { icon: 'ti-crosshair',       cls: 'c-red',    advice: 'Travel in convoy if you can, keep to the main carriageway and do not take unfamiliar shortcuts.' },
  explosion:      { icon: 'ti-flame',           cls: 'c-red',    advice: 'Stay on tarred, well-used road and follow military or police direction at checkpoints.' },
  killing:        { icon: 'ti-alert-octagon',   cls: 'c-red',    advice: 'Avoid the towns named in the reports and do not stop overnight along the way.' },
  robbery:        { icon: 'ti-shield-off',      cls: 'c-orange', advice: 'Keep valuables out of sight and avoid stopping at isolated spots or unofficial checkpoints.' },
  unrest:         { icon: 'ti-speakerphone',    cls: 'c-orange', advice: 'Expect roadblocks and diversions; avoid town centres and turn back rather than drive through a crowd.' },
  road_crash:     { icon: 'ti-car-crash',       cls: 'c-orange', advice: 'Keep your speed down, leave room around tankers and trucks, and expect delays.' },
  road_condition: { icon: 'ti-road-off',        cls: 'c-blue',   advice: 'Check the road is passable before you set off and allow extra time.' }
};

// Waypoint: [lat, lng, baseline risk, name, state]. A null risk is derived
// from the state's hotspot index. A name makes the town searchable in the
// news, so a report that mentions it is pinned to that part of the road.
// Corridors without distanceKm/estMin/checkpoints have them worked out from
// the waypoints and the checkpoint layer.
const TV_CORRIDORS = [
  { from:'Kaduna', to:'Abuja (FCT)', road:'A2 corridor', distanceKm:188, estMin:160, checkpoints:7,
    waypoints:[[10.5105,7.4165,'low',null,'Kaduna'],[10.20,7.46,'low',null,'Kaduna'],[9.95,7.52,'caution','Rijana','Kaduna'],[9.78,7.56,'high','Katari','Kaduna'],[9.55,7.52,'high','Jere','Kaduna'],[9.30,7.45,'caution',null,'Niger'],[9.0765,7.3986,'low',null,'FCT (Abuja)']],
    stretch:{name:'Rijana–Katari', kmFrom:42, kmTo:58, at:[9.865,7.54]} },
  { from:'Abuja (FCT)', to:'Lokoja', road:'A2 south', distanceKm:165, estMin:150, checkpoints:5,
    waypoints:[[9.0765,7.3986,'low',null,'FCT (Abuja)'],[8.70,7.10,'caution','Kwali','FCT (Abuja)'],[8.30,6.90,'caution','Abaji','FCT (Abuja)'],[7.95,6.80,'high','Koton-Karfe','Kogi'],[7.80,6.74,'caution',null,'Kogi']],
    stretch:{name:'Koton-Karfe belt', kmFrom:95, kmTo:120, at:[8.00,6.82]}, alt:null },
  { from:'Lagos', to:'Ibadan', road:'Lagos–Ibadan expressway', distanceKm:128, estMin:120, checkpoints:6,
    waypoints:[[6.5244,3.3792,'low',null,'Lagos'],[6.75,3.45,'low','Mowe','Ogun'],[6.95,3.60,'caution','Sagamu','Ogun'],[7.15,3.80,'caution','Ogere','Ogun'],[7.3775,3.9470,'low',null,'Oyo']],
    stretch:{name:'Sagamu–Ogere axis', kmFrom:38, kmTo:60, at:[6.95,3.57]}, alt:null },
  { from:'Abuja (FCT)', to:'Jos', road:'Abuja–Jos road', distanceKm:270, estMin:255, checkpoints:8,
    waypoints:[[9.0765,7.3986,'low',null,'FCT (Abuja)'],[9.20,7.90,'caution','Keffi','Nasarawa'],[9.40,8.30,'caution','Akwanga','Nasarawa'],[9.55,8.60,'high','Riyom','Plateau'],[9.75,8.75,'caution','Barkin Ladi','Plateau'],[9.8965,8.8583,'low',null,'Plateau']],
    stretch:{name:'Riyom–Barkin Ladi', kmFrom:200, kmTo:235, at:[9.58,8.62]}, alt:null },
  { from:'Kaduna', to:'Zaria', road:'Kaduna–Zaria (A2)', distanceKm:80, estMin:65, checkpoints:3,
    waypoints:[[10.5105,7.4165,'low',null,'Kaduna'],[10.80,7.55,'caution',null,'Kaduna'],[11.07,7.70,'caution',null,'Kaduna']] },
  { from:'Zaria', to:'Kano', road:'Zaria–Kano (A2)', distanceKm:173, estMin:145, checkpoints:6,
    waypoints:[[11.07,7.70,'caution',null,'Kaduna'],[11.50,7.90,'high','Makarfi','Kaduna'],[11.80,8.20,'caution',null,'Kano'],[12.00,8.52,'low',null,'Kano']],
    stretch:{name:'Zaria–Makarfi fringe', kmFrom:15, kmTo:60, at:[11.48,7.92]} },
  { from:'Maiduguri', to:'Damaturu', road:'A3 Maiduguri–Damaturu', distanceKm:135, estMin:130, checkpoints:11,
    waypoints:[[11.8333,13.151,'high',null,'Borno'],[11.80,12.80,'high','Auno','Borno'],[11.78,12.40,'high','Benisheikh','Borno'],[11.76,12.10,'caution','Ngamdu','Borno'],[11.7466,11.9608,'caution',null,'Yobe']],
    stretch:{name:'Benisheikh corridor', kmFrom:45, kmTo:85, at:[11.79,12.50]}, alt:null },

  // South-West / South-South / South-East
  { from:'Lagos', to:'Benin City', road:'Lagos–Ore–Benin expressway',
    waypoints:[[6.5244,3.3792,null,null,'Lagos'],[6.84,3.65,null,'Sagamu','Ogun'],[6.82,3.92,null,'Ijebu-Ode','Ogun'],[6.75,4.88,null,'Ore','Ondo'],[6.72,5.15,null,'Ofosu','Edo'],[6.73,5.38,null,'Okada','Edo'],[6.335,5.6037,null,null,'Edo']] },
  { from:'Benin City', to:'Onitsha', road:'Benin–Asaba expressway',
    waypoints:[[6.335,5.6037,null,null,'Edo'],[6.28,5.95,null,'Abudu','Edo'],[6.25,6.20,null,'Agbor','Delta'],[6.20,6.73,null,'Asaba','Delta'],[6.1498,6.7857,null,null,'Anambra']] },
  { from:'Onitsha', to:'Enugu', road:'Onitsha–Enugu expressway',
    waypoints:[[6.1498,6.7857,null,null,'Anambra'],[6.21,7.07,null,'Awka','Anambra'],[6.27,7.27,null,'Oji River','Enugu'],[6.43,7.40,null,'Ninth Mile','Enugu'],[6.4584,7.5464,null,null,'Enugu']] },
  { from:'Enugu', to:'Port Harcourt', road:'Enugu–Port Harcourt expressway',
    waypoints:[[6.4584,7.5464,null,null,'Enugu'],[6.07,7.47,null,'Awgu','Enugu'],[5.83,7.35,null,'Okigwe','Imo'],[5.5333,7.4833,null,'Umuahia','Abia'],[5.1066,7.3667,null,'Aba','Abia'],[4.8156,7.0498,null,null,'Rivers']] },
  { from:'Port Harcourt', to:'Yenagoa', road:'East–West road',
    waypoints:[[4.8156,7.0498,null,null,'Rivers'],[5.08,6.65,null,'Ahoada','Rivers'],[5.05,6.45,null,'Mbiama','Rivers'],[4.9267,6.2676,null,null,'Bayelsa']] },
  { from:'Uyo', to:'Calabar', road:'Calabar–Itu highway',
    waypoints:[[5.0377,7.9128,null,null,'Akwa Ibom'],[5.20,7.98,null,'Itu','Akwa Ibom'],[5.12,8.33,null,'Odukpani','Cross River'],[4.9757,8.3417,null,null,'Cross River']] },
  { from:'Ibadan', to:'Ilorin', road:'Ibadan–Ilorin expressway',
    waypoints:[[7.3775,3.9470,null,null,'Oyo'],[7.85,3.93,null,null,'Oyo'],[8.13,4.24,null,'Ogbomoso','Oyo'],[8.4966,4.5421,null,null,'Kwara']] },

  // North-Central
  { from:'Abuja (FCT)', to:'Makurdi', road:'Keffi–Lafia–Makurdi road',
    waypoints:[[9.0765,7.3986,null,null,'FCT (Abuja)'],[8.85,7.87,null,'Keffi','Nasarawa'],[8.91,8.41,null,'Akwanga','Nasarawa'],[8.49,8.52,null,'Lafia','Nasarawa'],[7.7337,8.5214,null,null,'Benue']] },
  { from:'Abuja (FCT)', to:'Minna', road:'Suleja–Minna road',
    waypoints:[[9.0765,7.3986,null,null,'FCT (Abuja)'],[9.18,7.18,null,'Suleja','Niger'],[9.28,6.95,null,'Lambata','Niger'],[9.6139,6.5569,null,null,'Niger']] },
  { from:'Lokoja', to:'Benin City', road:'Lokoja–Okene–Auchi–Benin road',
    waypoints:[[7.80,6.74,null,null,'Kogi'],[7.55,6.23,null,'Okene','Kogi'],[7.07,6.27,null,'Auchi','Edo'],[6.74,6.14,null,'Ekpoma','Edo'],[6.335,5.6037,null,null,'Edo']] },

  // North-West / North-East
  { from:'Sokoto', to:'Gusau', road:'Sokoto–Gusau road',
    waypoints:[[13.0622,5.2339,null,null,'Sokoto'],[12.75,5.75,null,null,'Sokoto'],[12.57,6.06,null,'Talata Mafara','Zamfara'],[12.17,6.66,null,null,'Zamfara']] },
  { from:'Gusau', to:'Zaria', road:'Gusau–Funtua–Zaria road',
    waypoints:[[12.17,6.66,null,null,'Zamfara'],[11.96,6.92,null,'Tsafe','Zamfara'],[11.52,7.31,null,'Funtua','Katsina'],[11.07,7.70,null,null,'Kaduna']] },
  { from:'Kano', to:'Katsina', road:'Kano–Katsina road',
    waypoints:[[12.00,8.52,null,null,'Kano'],[12.55,7.83,null,'Kankia','Katsina'],[12.99,7.60,null,null,'Katsina']] },
  { from:'Bauchi', to:'Jos', road:'Bauchi–Jos road',
    waypoints:[[10.31,9.84,null,null,'Bauchi'],[10.06,9.07,null,'Toro','Bauchi'],[9.8965,8.8583,null,null,'Plateau']] },
  { from:'Yola', to:'Gombe', road:'Yola–Numan–Gombe road',
    waypoints:[[9.2035,12.4954,null,null,'Adamawa'],[9.47,12.03,null,'Numan','Adamawa'],[9.81,11.31,null,'Kaltungo','Gombe'],[10.29,11.17,null,null,'Gombe']] },

  // Links that join the corridors above into one network and give most
  // trips a second way round.
  { from:'Lagos', to:'Abeokuta', road:'Lagos–Abeokuta expressway',
    waypoints:[[6.5244,3.3792,null,null,'Lagos'],[6.70,3.24,null,'Sango-Ota','Ogun'],[7.1475,3.3619,null,null,'Ogun']] },
  { from:'Abeokuta', to:'Ibadan', road:'Abeokuta–Ibadan road',
    waypoints:[[7.1475,3.3619,null,null,'Ogun'],[7.28,3.62,null,null,'Ogun'],[7.3775,3.9470,null,null,'Oyo']] },
  { from:'Ibadan', to:'Akure', road:'Ibadan–Ife–Akure road',
    waypoints:[[7.3775,3.9470,null,null,'Oyo'],[7.48,4.56,null,'Ile-Ife','Osun'],[7.62,4.74,null,'Ilesa','Osun'],[7.25,5.19,null,null,'Ondo']] },
  { from:'Akure', to:'Benin City', road:'Akure–Owo–Benin road',
    waypoints:[[7.25,5.19,null,null,'Ondo'],[7.20,5.59,null,'Owo','Ondo'],[6.93,5.77,null,'Ifon','Ondo'],[6.335,5.6037,null,null,'Edo']] },
  { from:'Ilorin', to:'Minna', road:'Ilorin–Jebba–Mokwa–Bida road',
    waypoints:[[8.4966,4.5421,null,null,'Kwara'],[9.13,4.82,null,'Jebba','Kwara'],[9.29,5.05,null,'Mokwa','Niger'],[9.08,6.01,null,'Bida','Niger'],[9.6139,6.5569,null,null,'Niger']] },
  { from:'Ilorin', to:'Lokoja', road:'Ilorin–Omu-Aran–Kabba road',
    waypoints:[[8.4966,4.5421,null,null,'Kwara'],[8.14,5.10,null,'Omu-Aran','Kwara'],[7.83,6.07,null,'Kabba','Kogi'],[7.80,6.74,null,null,'Kogi']] },
  { from:'Minna', to:'Kaduna', road:'Minna–Sarkin Pawa–Kaduna road',
    waypoints:[[9.6139,6.5569,null,null,'Niger'],[10.02,7.11,null,'Sarkin Pawa','Niger'],[10.5105,7.4165,null,null,'Kaduna']] },
  { from:'Kaduna', to:'Jos', road:'Kaduna–Kafanchan–Jos road',
    waypoints:[[10.5105,7.4165,null,null,'Kaduna'],[9.87,7.95,null,'Kachia','Kaduna'],[9.58,8.29,null,'Kafanchan','Kaduna'],[9.8965,8.8583,null,null,'Plateau']] },
  { from:'Makurdi', to:'Enugu', road:'Makurdi–Otukpo–Enugu road',
    waypoints:[[7.7337,8.5214,null,null,'Benue'],[7.19,8.13,null,'Otukpo','Benue'],[6.92,7.51,null,'Obollo-Afor','Enugu'],[6.4584,7.5464,null,null,'Enugu']] },
  { from:'Onitsha', to:'Port Harcourt', road:'Onitsha–Owerri–Port Harcourt road',
    waypoints:[[6.1498,6.7857,null,null,'Anambra'],[5.85,6.86,null,'Ihiala','Anambra'],[5.4836,7.0333,null,'Owerri','Imo'],[5.10,6.81,null,'Elele','Rivers'],[4.8156,7.0498,null,null,'Rivers']] },
  { from:'Yenagoa', to:'Benin City', road:'East–West road via Warri',
    waypoints:[[4.9267,6.2676,null,null,'Bayelsa'],[5.23,6.19,null,'Patani','Delta'],[5.49,6.00,null,'Ughelli','Delta'],[5.52,5.75,null,'Warri','Delta'],[5.89,5.68,null,'Sapele','Delta'],[6.335,5.6037,null,null,'Edo']] },
  { from:'Port Harcourt', to:'Uyo', road:'Port Harcourt–Ikot Abasi–Uyo road',
    waypoints:[[4.8156,7.0498,null,null,'Rivers'],[4.72,7.35,null,'Bori','Rivers'],[4.57,7.56,null,'Ikot Abasi','Akwa Ibom'],[5.0377,7.9128,null,null,'Akwa Ibom']] },
  { from:'Kano', to:'Damaturu', road:'Kano–Azare–Potiskum road',
    waypoints:[[12.00,8.52,null,null,'Kano'],[11.81,8.84,null,'Wudil','Kano'],[11.68,10.19,null,'Azare','Bauchi'],[11.71,11.08,null,'Potiskum','Yobe'],[11.7466,11.9608,null,null,'Yobe']] },
  { from:'Bauchi', to:'Kano', road:'Bauchi–Ningi–Kano road',
    waypoints:[[10.31,9.84,null,null,'Bauchi'],[11.08,9.57,null,'Ningi','Bauchi'],[12.00,8.52,null,null,'Kano']] },
  { from:'Bauchi', to:'Gombe', road:'Bauchi–Alkaleri–Gombe road',
    waypoints:[[10.31,9.84,null,null,'Bauchi'],[10.27,10.33,null,'Alkaleri','Bauchi'],[10.29,11.17,null,null,'Gombe']] }
];

function tv12h(h){ const ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}:00 ${ap}`; }
function tvShortH(h){ const ap = h >= 12 ? 'p' : 'a'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}${ap}`; }
function tvHourColor(v){ return v >= 56 ? '#ff5a5f' : v >= 30 ? '#f5a623' : '#35d08a'; }
function tvPlural(n, word){ return `${n} ${word}${n === 1 ? '' : 's'}`; }

function tvAgo(hours){
  if (hours == null) return 'undated';
  if (hours < 1) return 'under an hour ago';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return tvPlural(Math.round(hours / 24), 'day') + ' ago';
}

function tvKm(a, b){
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function tvStateScore(stateName){
  const rows = (typeof cachedHotspots !== 'undefined' && cachedHotspots) || computeHotspots() || [];
  return rows.find(row => row.state === stateName)?.composite || 0;
}

function tvBaselineLevel(stateName){
  const score = tvStateScore(stateName);
  return score >= 45 ? 'high' : score >= 28 ? 'caution' : 'low';
}

// Fill in what a corridor leaves out, once, so the rest of the code can rely on it.
function tvPrepareCorridor(c){
  if (c.prepared) return c;
  c.states = [...new Set(c.waypoints.map(w => w[4]).filter(Boolean))];
  c.waypoints.forEach(w => { if (!w[2]) { w[2] = tvBaselineLevel(w[4]); c.derivedRisk = true; } });
  if (!c.distanceKm){
    let km = 0;
    for (let i = 0; i < c.waypoints.length - 1; i++) km += tvKm(c.waypoints[i], c.waypoints[i + 1]);
    c.distanceKm = Math.round(km * 1.22);            // roads wander; straight lines do not
    c.estMin = Math.round(c.distanceKm / 62 * 60 / 5) * 5;
    c.estimated = true;
  }
  if (c.checkpoints == null){
    c.checkpoints = checkpointRecords.filter(cp => c.waypoints.some(w => tvKm([cp.lat, cp.lng], w) <= 25)).length;
  }
  c.prepared = true;
  return c;
}

// Find a corridor for from→to in either direction (reversed copy if needed).
function tvFindCorridor(from, to){
  const direct = TV_CORRIDORS.find(c => c.from === from && c.to === to);
  if (direct) return tvPrepareCorridor(direct);
  const rev = TV_CORRIDORS.find(c => c.from === to && c.to === from);
  if (!rev) return null;
  tvPrepareCorridor(rev);
  const c = JSON.parse(JSON.stringify(rev));
  c.from = rev.to; c.to = rev.from;
  c.waypoints = c.waypoints.slice().reverse();
  if (c.alt) c.alt.waypoints = c.alt.waypoints.slice().reverse();
  if (c.stretch){ const a = c.distanceKm - rev.stretch.kmTo, b = c.distanceKm - rev.stretch.kmFrom; c.stretch.kmFrom = Math.max(0, a); c.stretch.kmTo = b; }
  return c;
}

function tvCorridorPlaces(corr){
  return corr.waypoints.slice(1, -1).map(w => w[3]).filter(Boolean);
}

// ── Road network ─────────────────────────────────────────────
// The corridors are the edges of a road network and their end towns are its
// junctions, so a trip between any two towns is a walk through that network —
// and usually there is more than one.

function tvTowns(){
  return [...new Set(TV_CORRIDORS.flatMap(c => [c.from, c.to]))].sort();
}

function tvNeighbours(town){
  return TV_CORRIDORS.flatMap(c => c.from === town ? [[c.to, c]] : c.to === town ? [[c.from, c]] : []);
}

// Every way of getting from A to B without passing through a town twice,
// dropping anything much slower than the quickest.
function tvEnumeratePaths(from, to){
  TV_CORRIDORS.forEach(tvPrepareCorridor);

  // Quickest time first (Dijkstra), so the search below knows when to give up.
  const best = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length){
    queue.sort((a, b) => best.get(a) - best.get(b));
    const town = queue.shift();
    tvNeighbours(town).forEach(([next, c]) => {
      const time = best.get(town) + c.estMin + TV_JUNCTION_MIN;
      if (time < (best.get(next) ?? Infinity)){ best.set(next, time); queue.push(next); }
    });
  }
  if (!best.has(to)) return [];
  const limit = best.get(to) * TV_DETOUR_LIMIT + 30;

  const paths = [];
  const walk = (town, towns, time) => {
    if (time > limit || towns.length > TV_MAX_LEGS + 1) return;
    if (town === to){ paths.push({ towns: towns.slice(), time }); return; }
    tvNeighbours(town).forEach(([next, c]) => {
      if (towns.includes(next)) return;
      towns.push(next);
      walk(next, towns, time + c.estMin + TV_JUNCTION_MIN);
      towns.pop();
    });
  };
  walk(from, [from], 0);
  return paths.sort((a, b) => a.time - b.time);
}

// Stitch a chain of towns into one route the rest of the code can treat
// exactly like a single corridor.
function tvBuildRoute(towns){
  const legs = towns.slice(0, -1).map((town, i) => tvFindCorridor(town, towns[i + 1]));
  const stateNames = new Set(stateData.map(s => s.state));
  const waypoints = [];
  const wpLeg = [];                               // which leg each waypoint belongs to
  const stretches = [];
  let km = 0;
  legs.forEach((leg, i) => {
    const points = leg.waypoints.map(w => w.slice());
    if (i > 0) points.shift();                    // the junction is already there
    waypoints.push(...points);
    points.forEach(() => wpLeg.push(i));
    if (leg.stretch) stretches.push({ ...leg.stretch, leg: i, kmFrom: km + leg.stretch.kmFrom, kmTo: km + leg.stretch.kmTo });
    km += leg.distanceKm;
    // A junction town is somewhere reports can name — unless its name is also
    // a state's, which would claim every story in that state for this road.
    if (i < legs.length - 1 && !stateNames.has(leg.to) && !leg.to.includes('(')){
      waypoints[waypoints.length - 1][3] = leg.to;
    }
  });
  const via = towns.slice(1, -1);
  return {
    key: towns.join('>'), roadKey: towns.join('>'), parkFrom: null, parkTo: null, from: towns[0], to: towns[towns.length - 1], towns, via, legs,
    legKeys: legs.map(leg => [leg.from, leg.to].sort().join('|')),
    road: legs.length === 1 ? legs[0].road : `via ${via.join(' · ')}`,
    waypoints, wpLeg, stretches,
    // The towns the road router is asked to pass through, in order.
    hubs: [legs[0].waypoints[0], ...legs.map(leg => leg.waypoints[leg.waypoints.length - 1])].map(w => [w[0], w[1]]),
    net: null,                                    // filled in by tvApplyRoad
    states: [...new Set(waypoints.map(w => w[4]).filter(Boolean))],
    distanceKm: km,
    estMin: legs.reduce((sum, leg) => sum + leg.estMin, 0) + TV_JUNCTION_MIN * (legs.length - 1),
    checkpoints: legs.reduce((sum, leg) => sum + leg.checkpoints, 0),
    estimated: legs.some(leg => leg.estimated),
    derivedRisk: legs.some(leg => leg.derivedRisk)
  };
}

// Up to three routes worth offering: the quickest, then whichever others are
// genuinely different roads rather than the same trip with one town swapped.
function tvPlanRoutes(from, to){
  const routes = [];
  for (const path of tvEnumeratePaths(from, to)){
    const route = tvBuildRoute(path.towns);
    const tooSimilar = routes.some(chosen => {
      const shared = route.legKeys.filter(key => chosen.legKeys.includes(key)).length;
      return shared / Math.min(route.legKeys.length, chosen.legKeys.length) > 0.6;
    });
    if (tooSimilar) continue;
    routes.push(route);
    if (routes.length === TV_MAX_ROUTES) break;
  }
  return routes;
}

// ── Real roads ───────────────────────────────────────────────

function tvRoadEntry(route){
  return (route && tvRoadStore.get(route.roadKey)) || { status: 'idle', data: null, error: '' };
}

function tvDecodePolyline(text){
  const line = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, byte;
    do { byte = text.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length){ lat += next(); lng += next(); line.push([lat / 1e5, lng / 1e5]); }
  return line;
}

function tvNearestIndex(line, point, from, to){
  const squeeze = Math.cos(point[0] * Math.PI / 180);
  let best = from, bestGap = Infinity;
  for (let i = from; i <= to; i++){
    const dLat = line[i][0] - point[0], dLng = (line[i][1] - point[1]) * squeeze;
    const gap = dLat * dLat + dLng * dLng;
    if (gap < bestGap){ bestGap = gap; best = i; }
  }
  return best;
}

function tvIndexAtKm(cum, km){
  const i = cum.findIndex(value => value >= km);
  return i < 0 ? cum.length - 1 : i;
}

// The router's turn-by-turn list is mostly roundabouts and slip roads. Fold it
// into the roads a driver would actually name: "A2 · Abuja-Kaduna Highway, 111 km".
function tvCondenseSteps(legs){
  const merge = items => items.reduce((out, item) => {
    const last = out[out.length - 1];
    if (last && last.label === item.label){ last.km += item.km; last.min += item.min; }
    else out.push({ ...item });
    return out;
  }, []);
  let items = merge(legs.flatMap(leg => leg.steps.map(step => ({
    label: step.ref && step.name ? `${step.ref} · ${step.name}` : step.ref || step.name,
    km: step.km, min: step.min, kind: step.kind || '', turn: step.turn || ''
  }))));
  for (let i = 0; i < items.length && items.length > 1;){
    if (items[i].km >= TV_DIRECTION_MIN_KM){ i++; continue; }
    const into = items[i > 0 ? i - 1 : 1];
    into.km += items[i].km; into.min += items[i].min;
    items.splice(i, 1);
    if (i > 0) i--;
  }
  items = merge(items);
  let km = 0;
  return items.map(item => {
    const row = { ...item, kmFrom: km, kmTo: km + item.km };
    km = row.kmTo;
    return row;
  });
}

// Icon and wording for joining a road, from the router's manoeuvre.
function tvTurn(step, first){
  if (first) return { icon: 'ti-navigation-filled', verb: 'Leave' };
  const turn = step.turn || '';
  const side = turn.includes('left') ? 'left' : turn.includes('right') ? 'right' : '';
  if (/roundabout|rotary/.test(step.kind)) return { icon: `ti-arrow-roundabout-${side || 'right'}`, verb: 'At the roundabout take' };
  if (step.kind === 'merge') return { icon: 'ti-arrow-merge', verb: 'Merge onto' };
  if (/ramp/.test(step.kind)) return { icon: `ti-arrow-ramp-${side || 'right'}`, verb: 'Take the slip road to' };
  if (turn === 'uturn') return { icon: 'ti-arrow-back-up', verb: 'Turn back onto' };
  if (side && turn.includes('sharp')) return { icon: `ti-arrow-sharp-turn-${side}`, verb: `Turn sharp ${side} onto` };
  if (side && turn.includes('slight')) return { icon: `ti-arrow-bear-${side}`, verb: `Keep ${side} onto` };
  if (side) return { icon: `ti-corner-up-${side}`, verb: `Turn ${side} onto` };
  return { icon: 'ti-arrow-narrow-up', verb: 'Continue on' };
}

// Lay a planned route on the road the router returned. Everything that was an
// estimate from straight lines becomes a fact about that road.
function tvApplyRoad(route, data){
  const line = tvDecodePolyline(data.geometry);
  if (line.length < 2 || data.legs.length !== route.legs.length) return;
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + tvKm(line[i - 1], line[i]));
  const total = cum[cum.length - 1];

  // Where each leg ends along the line.
  const legSum = data.legs.reduce((sum, leg) => sum + leg.distanceKm, 0) || 1;
  const bounds = [0];
  let run = 0;
  data.legs.forEach((leg, i) => {
    run += leg.distanceKm;
    bounds.push(i === data.legs.length - 1 ? line.length - 1 : tvIndexAtKm(cum, run / legSum * total));
  });

  // Pin every corridor waypoint to the road, keeping them in travel order.
  let last = 0;
  const wpAt = route.waypoints.map((w, j) => {
    const leg = route.wpLeg[j];
    const endsLeg = j === route.waypoints.length - 1 || route.wpLeg[j + 1] !== leg;
    const at = j === 0 ? 0 : endsLeg ? bounds[leg + 1]
      : tvNearestIndex(line, w, Math.max(last, bounds[leg]), bounds[leg + 1]);
    last = at;
    return at;
  });

  // Which states the road is in, and for how far.
  const stateKm = new Map();
  if (hsState.geo){
    let mark = 0;
    for (let i = 1; i < line.length; i++){
      if (cum[i] - cum[mark] < TV_STATE_SAMPLE_KM && i < line.length - 1) continue;
      const mid = line[Math.floor((mark + i) / 2)];
      const name = hsStateAtPoint(mid[0], mid[1]);
      if (name) stateKm.set(name, (stateKm.get(name) || 0) + cum[i] - cum[mark]);
      mark = i;
    }
    [...stateKm].forEach(([name, km]) => { if (km < TV_STATE_SAMPLE_KM) stateKm.delete(name); });
  }

  route.net = { line, cum, wpAt, stateKm, provider: data.provider, directions: tvCondenseSteps(data.legs) };
  route.distanceKm = Math.round(data.distanceKm);
  route.estMin = data.durationMin;
  route.estimated = false;
  route.legs = route.legs.map((leg, i) => ({ ...leg, distanceKm: Math.round(data.legs[i].distanceKm), estMin: data.legs[i].durationMin }));
  if (stateKm.size) route.states = [...stateKm.keys()];
  route.stretches = route.stretches.map(stretch => {
    const at = tvNearestIndex(line, stretch.at, bounds[stretch.leg], bounds[stretch.leg + 1]);
    const half = (stretch.kmTo - stretch.kmFrom) / 2;
    return { ...stretch, at: line[at], kmFrom: Math.max(0, Math.round(cum[at] - half)), kmTo: Math.min(Math.round(total), Math.round(cum[at] + half)) };
  });
}

// Kilometres of road between consecutive waypoints, or null without a road.
function tvSegmentKm(route){
  if (!route.net) return null;
  const { cum, wpAt } = route.net;
  return wpAt.slice(0, -1).map((at, i) => cum[wpAt[i + 1]] - cum[at]);
}

async function tvLoadRoad(route, force){
  const entry = tvRoadEntry(route);
  if (entry.status === 'loading' || (!force && entry.status === 'ready')) return;
  tvRoadStore.set(route.roadKey, { status: 'loading', data: null, error: '' });
  renderTravelDirections();
  try {
    const points = route.hubs.map(point => point.join(',')).join(';');
    const response = await fetch(`/api/road-route?points=${encodeURIComponent(points)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    tvRoadStore.set(route.roadKey, { status: 'ready', data, error: '' });
  } catch (error) {
    tvRoadStore.set(route.roadKey, { status: 'error', data: null, error: error.message });
  }
  // The same trip may have been planned again in the meantime.
  const shown = tvRoutes.find(candidate => candidate.roadKey === route.roadKey);
  if (!shown) return;
  const data = tvRoadStore.get(route.roadKey).data;
  if (data && !shown.net) tvApplyRoad(shown, data);
  tvRenderAssessment(true);
}

function retryTravelRoads(){
  tvRoutes.filter(route => !route.net).forEach(route => tvLoadRoad(route, true));
}

// ── Bus parks ────────────────────────────────────────────────
// By bus the trip runs from a park in the first town to a park in the last,
// so the traveller picks both and the road is routed between them. By car or
// in convoy there is nothing to pick: the route runs town to town.

function tvParksFor(town){
  return tvParks[town] || [];
}

function tvChosenPark(end){
  if (tvMode !== 'Bus') return null;
  const town = document.getElementById(end === 'from' ? 'tvFrom' : 'tvTo').value;
  return tvParksFor(town).find(park => park.id === tvParkChoice[end]) || null;
}

// The chosen park, in a line or two: where it is and how sure its position is.
function tvParkCardHtml(park, town){
  const facts = [`${park.kmFromCentre} km from the centre of ${escapeHtml(town)}`];
  if (park.operator) facts.push(escapeHtml(park.operator));
  facts.push(park.approx ? `position approximate (${escapeHtml(park.area || 'neighbourhood')})` : 'mapped position');
  return `<div class="tv-parkcard">
    <div class="tv-parkcard-name">${escapeHtml(park.name)}</div>
    <div class="tv-parkcard-facts">${facts.join(' · ')}</div>
  </div>`;
}

// In bus mode the parks of each town are listed under it — From, then To —
// with the chosen one described. A choice that still applies is kept; otherwise
// it starts on the nearest park with a mapped position.
function tvFillParks(){
  ['from', 'to'].forEach(end => {
    const box = document.getElementById(end === 'from' ? 'tvParksFrom' : 'tvParksTo');
    box.hidden = tvMode !== 'Bus';
    if (tvMode !== 'Bus') return;
    const town = document.getElementById(end === 'from' ? 'tvFrom' : 'tvTo').value;
    const parks = tvParksFor(town);
    if (!parks.some(park => park.id === tvParkChoice[end])) tvParkChoice[end] = (parks.find(park => !park.approx) || parks[0])?.id || null;
    if (!parks.length){
      box.innerHTML = `<div class="tv-park-hint"><i class="ti ti-info-circle"></i> No bus park is on record for ${escapeHtml(town)} yet, so this end of the route uses the town centre.</div>`;
      return;
    }
    const chosen = parks.find(park => park.id === tvParkChoice[end]);
    const keep = box.querySelector('.tv-parklist-rows')?.scrollTop || 0;
    box.innerHTML = `
      <div class="tv-parklist-hd"><span><i class="ti ti-bus"></i> ${end === 'from' ? 'Departure' : 'Arrival'} park</span><em>${tvPlural(parks.length, 'park')} · tap one, or tap it on the map</em></div>
      <div class="tv-parklist-rows" role="listbox" aria-label="${end === 'from' ? 'Departure' : 'Arrival'} parks in ${escapeHtml(town)}">
        ${parks.map(park => `<button type="button" role="option" aria-selected="${park === chosen}" class="tv-parkrow is-${end}${park === chosen ? ' is-chosen' : ''}" onclick="chooseTravelPark('${end}', '${escapeHtml(park.id)}')">
          <i class="ti ${park === chosen ? 'ti-check' : 'ti-bus'}"></i>
          <span class="tv-parkrow-name">${escapeHtml(park.name)}</span>
          <span class="tv-parkrow-km">${park.kmFromCentre} km</span>
        </button>`).join('')}
      </div>
      ${tvParkCardHtml(chosen, town)}`;
    // Stay where the list was scrolled, unless that hides the chosen park.
    const rows = box.querySelector('.tv-parklist-rows');
    const row = rows.querySelector('.is-chosen');
    rows.scrollTop = keep;
    const top = row.offsetTop - rows.offsetTop;
    if (top < rows.scrollTop || top + row.offsetHeight > rows.scrollTop + rows.clientHeight) rows.scrollTop = Math.max(0, top - row.offsetHeight);
  });
}

function chooseTravelPark(end, id){
  tvParkChoice[end] = id || null;
  assessRoute();
}

// Start and finish a planned route at the chosen parks.
function tvApplyParks(route){
  const from = tvChosenPark('from'), to = tvChosenPark('to');
  route.parkFrom = from;
  route.parkTo = to;
  if (from) route.hubs[0] = [from.lat, from.lng];
  if (to) route.hubs[route.hubs.length - 1] = [to.lat, to.lng];
  if (from || to) route.roadKey = `${route.key}#${from ? from.id : ''}>${to ? to.id : ''}`;
}

function tvEndName(route, end){
  const park = end === 'from' ? route.parkFrom : route.parkTo;
  const town = end === 'from' ? route.from : route.to;
  return park ? `${park.name}, ${town}` : town;
}

// ── Live reports ─────────────────────────────────────────────

function tvNewsEntry(route){
  return (route && tvNewsStore.get(route.key)) || { status: 'idle', data: null, error: '' };
}

// During a refresh the previous answer stays in use, so scores do not flicker.
function tvLiveData(route = tvCurrentCorridor){
  return tvNewsEntry(route).data;
}

async function tvLoadNews(route, force){
  const entry = tvNewsEntry(route);
  if (!force && (entry.status === 'ready' || entry.status === 'loading')) return;
  tvNewsStore.set(route.key, { status: 'loading', data: entry.data, error: '' });
  tvRenderAssessment();

  const params = new URLSearchParams({
    states: route.states.join('|'),
    places: tvCorridorPlaces(route).join('|'),
    hubs: route.via.join('|'),
    // Only a single road has a name the papers would use ("Kaduna-Abuja road").
    label: route.legs.length === 1 ? `${route.from} → ${route.to}` : ''
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`/api/route-news?${params}`, { cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    tvNewsStore.set(route.key, { status: 'ready', data, error: '' });
  } catch (error) {
    tvNewsStore.set(route.key, { status: 'error', data: null,
      error: error.name === 'AbortError' ? 'The news sources took too long to answer.' : error.message });
  } finally {
    clearTimeout(timeout);
  }
  // Compare by key: the same trip may have been planned again in the meantime.
  if (tvRoutes.some(shown => shown.key === route.key)) tvRenderAssessment();
}

// Segment levels after the news has had its say: a report naming a town on
// the road raises the stretch either side of it by one level.
function tvEffectiveLevels(corr){
  const levels = corr.waypoints.map(w => w[2]);
  const raised = new Set();
  const live = tvLiveData(corr);
  if (live){
    live.events.filter(e => e.onRoute && (e.ageHours ?? 999) <= 96 && e.category !== 'road_condition').forEach(e => {
      e.places.forEach(place => {
        const i = corr.waypoints.findIndex(w => w[3] === place);
        if (i < 0 || raised.has(i)) return;
        levels[i] = TV_SEG_ORDER[Math.min(2, TV_SEG_ORDER.indexOf(levels[i]) + 1)];
        raised.add(i);
      });
    });
  }
  return { levels, raised };
}

function tvHourlyCurve(corr){
  const curve = TV_HOURLY.slice();
  const mentions = tvLiveData(corr)?.counts.timeOfDay || {};
  let used = 0;
  Object.entries(mentions).forEach(([part, count]) => {
    used += count;
    (TV_DAYPART_HOURS[part] || []).forEach(h => { curve[h] = Math.min(100, curve[h] + Math.min(count, 4) * 6); });
  });
  return { curve, mentions: used };
}

function tvRouteRisk(corr, departHour){
  const { levels } = tvEffectiveLevels(corr);
  const weights = [];
  for (let i = 0; i < levels.length - 1; i++){
    weights.push(Math.max(TV_SEG_WEIGHT[levels[i]], TV_SEG_WEIGHT[levels[i+1]]));
  }
  const lengths = tvSegmentKm(corr) || weights.map(() => 1);
  const roadKm = lengths.reduce((a, b) => a + b, 0) || 1;
  const mean = weights.reduce((sum, weight, i) => sum + weight * lengths[i], 0) / roadKm;
  const stateKm = corr.net?.stateKm.size ? corr.net.stateKm : new Map(corr.states.map(s => [s, 1]));
  const stateTotal = [...stateKm.values()].reduce((a, b) => a + b, 0) || 1;
  const { curve } = tvHourlyCurve(corr);
  const live = tvLiveData(corr);
  // A long trip is still on the road hours after it set off, so it is judged
  // on the worst hour it passes through, not only the one it leaves in.
  let worstHour = 0;
  for (let h = 0; h <= Math.ceil(corr.estMin / 60); h++) worstHour = Math.max(worstHour, curve[(departHour + h) % 24]);
  const parts = {
    segments: (mean + Math.max(...weights)) / 2,
    states: [...stateKm].reduce((sum, [s, km]) => sum + tvStateScore(s) * km, 0) / stateTotal,
    time: worstHour / Math.max(...curve) * 100,
    live: live ? live.liveIndex : 0
  };
  const w = live ? TV_SCORE_WEIGHTS : TV_SCORE_WEIGHTS_OFFLINE;
  let score = Object.keys(w).reduce((sum, key) => sum + parts[key] * w[key], 0);
  score *= (TV_MODE_FACTOR[tvMode] || 1);
  score = Math.max(5, Math.min(99, Math.round(score)));
  const highSegs = weights.filter(v => v >= TV_SEG_WEIGHT.high).length;
  const highKm = corr.net ? weights.reduce((sum, weight, i) => sum + (weight >= TV_SEG_WEIGHT.high ? lengths[i] : 0), 0) : null;
  return { score, segCount: weights.length, highSegs, highKm, parts, weights: w, hasLive: Boolean(live) };
}

function tvRiskBand(score){
  if (score >= 70) return { label:'High Risk', cls:'is-crit' };
  if (score >= 50) return { label:'Elevated',  cls:'is-high' };
  if (score >= 30) return { label:'Moderate',  cls:'is-mod' };
  return { label:'Lower Risk', cls:'is-low' };
}

function tvWindow(curve, predicate){
  const hrs = []; for (let h = 0; h < 24; h++) if (predicate(curve[h])) hrs.push(h);
  if (!hrs.length) return '—';
  // Longest unbroken run, so "safest" reads as one window rather than first-to-last.
  let best = [hrs[0]], run = [hrs[0]];
  for (let i = 1; i < hrs.length; i++){
    run = hrs[i] === hrs[i-1] + 1 ? [...run, hrs[i]] : [hrs[i]];
    if (run.length > best.length) best = run;
  }
  return `${tvShortH(best[0])}–${tvShortH((best[best.length-1] + 1) % 24)}`;
}

function tvDuration(minutes){ return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`; }

function selectTravelMode(btn){
  tvMode = btn.dataset.mode;
  document.querySelectorAll('#tvModes .tv-mode').forEach(b => b.classList.toggle('active', b === btn));
  // Bus trips run park to park, so the road itself changes with the mode.
  assessRoute();
}

// Start and finish: lettered badges, the way a control-room map marks them.
function tvEndIcon(letter, end){
  return L.divIcon({ className:'', iconSize:[0,0], popupAnchor:[0,-16],
    html:`<div class="tv-end is-${end}"><span>${letter}</span></div>` });
}

// A route line with a dark casing under it, so it reads on any basemap.
function tvDrawLine(path, color, weight, options = {}){
  L.polyline(path, { color:'#0b1420', weight: weight + 4, opacity: options.casing ?? 0.85, lineCap:'round', lineJoin:'round', interactive:false })
    .addTo(travelMapGroup);
  return L.polyline(path, { color, weight, opacity: 1, lineCap:'round', lineJoin:'round', ...options }).addTo(travelMapGroup);
}

// Chevrons along the selected route, pointing the way it is travelled.
function tvDrawArrows(route){
  if (!route.net) return;
  const { line, cum } = route.net;
  const total = cum[cum.length - 1];
  const count = Math.max(3, Math.min(16, Math.round(total / 45)));
  for (let k = 1; k <= count; k++){
    const at = tvIndexAtKm(cum, total * k / (count + 1));
    const a = line[Math.max(0, at - 3)], b = line[Math.min(line.length - 1, at + 3)];
    const bearing = Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
    L.marker(line[at], { interactive:false, keyboard:false,
      icon: L.divIcon({ className:'', iconSize:[0,0],
        html:`<div class="tv-arrow" style="transform:translate(-50%,-50%) rotate(${bearing.toFixed(0)}deg)"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M2.5 9.5 7 4.5l4.5 5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` })
    }).addTo(travelMapGroup);
  }
}

// ── Basemap ──────────────────────────────────────────────────

function setTravelBasemap(key){
  if (!TV_BASEMAPS[key] || !travelMap) return;
  tvBasemap = key;
  try { localStorage.setItem('tv-basemap', key); } catch (error) { /* private window: the choice just is not remembered */ }
  const base = TV_BASEMAPS[key];
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  tvBaseLayers.forEach(layer => layer.remove());
  tvBaseLayers = base.themed
    ? [L.tileLayer(light ? TV_LIGHT_TILE : TV_DARK_TILE, { ...TV_TILE_OPTS, maxNativeZoom: 16, maxZoom: 18 })]
    : [L.tileLayer(base.url, { attribution: base.attribution, maxNativeZoom: base.maxNativeZoom, maxZoom: 18 })];
  if (base.labels) tvBaseLayers.push(L.tileLayer(base.labels, { maxNativeZoom: 18, maxZoom: 18 }));
  tvBaseLayers.forEach(layer => layer.addTo(travelMap));
  // Town names are drawn light on a dark map and dark on a light one.
  const dark = base.themed ? !light : base.dark;
  document.querySelector('.tv-map-wrap').classList.toggle('is-lightmap', !dark);
  document.querySelector('.tv-map-wrap').classList.toggle('is-darkmap', dark);
  document.getElementById('tvBasemapName').textContent = base.label;
  document.getElementById('tvBasemapMenu').innerHTML = Object.entries(TV_BASEMAPS).map(([name, item]) =>
    `<button type="button" role="menuitemradio" aria-checked="${name === key}" class="tv-basemap${name === key ? ' active' : ''}" onclick="setTravelBasemap('${name}'); toggleTravelBasemaps(false)"><i class="ti ${item.icon}"></i><span>${item.label}</span>${name === key ? '<i class="ti ti-check tv-basemap-tick"></i>' : ''}</button>`).join('');
}

// The map-layer button opens and closes the list of basemaps.
function toggleTravelBasemaps(open){
  const box = document.getElementById('tvBasemaps');
  const show = open ?? !box.classList.contains('is-open');
  box.classList.toggle('is-open', show);
  document.getElementById('tvBasemapBtn').setAttribute('aria-expanded', String(show));
}

// Called by app.js when the light/dark theme changes.
function refreshTravelTheme(){
  if (travelMap) setTravelBasemap(tvBasemap);
}

function fitTravelBounds(){
  if (!tvRoutes.length || !travelMap) return;
  const pts = tvRoutes.flatMap(route => route.net ? route.net.line : route.waypoints.map(w => [w[0], w[1]]));
  travelMap.invalidateSize();
  travelMap.fitBounds(L.latLngBounds(pts).pad(0.12), { animate: false });
}

// ── Route options ────────────────────────────────────────────

// What each option is best at, worked out from the scores as they stand.
function tvRouteLabels(scores){
  const quickest = tvRoutes.reduce((best, route, i) => route.estMin < tvRoutes[best].estMin ? i : best, 0);
  const safest = scores.reduce((best, score, i) => score < scores[best] ? i : best, 0);
  return tvRoutes.map((route, i) => {
    if (tvRoutes.length === 1) return 'Only route';
    if (i === quickest && i === safest) return 'Fastest · lowest risk';
    if (i === quickest) return 'Fastest';
    if (i === safest) return 'Lowest risk';
    return 'Alternative';
  });
}

function selectTravelRoute(index){
  if (!tvRoutes[index]) return;
  tvSelectedRoute = index;
  tvCurrentCorridor = tvRoutes[index];
  tvRenderAssessment(true);
}

function renderTravelOptions(risks, labels){
  const box = document.getElementById('tvRouteOptions');
  document.getElementById('tvOptionsLabel').textContent = tvRoutes.length > 1
    ? `${tvRoutes.length} routes · tap one for its details` : 'Route';
  const quickest = Math.min(...tvRoutes.map(route => route.estMin));
  box.innerHTML = tvRoutes.map((route, i) => {
    const risk = risks[i];
    const band = tvRiskBand(risk.score);
    const entry = tvNewsEntry(route);
    const live = entry.data;
    const extra = route.estMin - quickest;
    const news = entry.status === 'loading' && !live ? '<i class="ti ti-loader-2 tv-spin"></i> checking news'
      : entry.status === 'error' ? 'news unavailable'
      : live ? `${tvPlural(live.counts.events, 'report')}${live.counts.onRoute ? ` · <b>${live.counts.onRoute} on the road</b>` : ''}`
      : '';
    return `<button type="button" class="tv-option ${band.cls}${i === tvSelectedRoute ? ' active' : ''}" onclick="selectTravelRoute(${i})">
      <span class="tv-option-top">
        <span class="tv-option-tag">${labels[i]}</span>
        <span class="tv-option-score">${risk.score}<em>/100</em></span>
      </span>
      <span class="tv-option-road">${escapeHtml(route.legs.length === 1 ? route.road : `via ${route.via.join(' · ')}`)}</span>
      <span class="tv-option-facts">
        <span><i class="ti ti-road"></i> ${route.estimated ? '≈ ' : ''}${route.distanceKm} km</span>
        <span><i class="ti ti-clock"></i> ${tvDuration(route.estMin)}${extra > 0 ? ` <em>+${extra >= 60 ? tvDuration(extra) : `${extra} min`}</em>` : ''}</span>
        <span><i class="ti ti-map-2"></i> ${tvPlural(route.states.length, 'state')}</span>
      </span>
      <span class="tv-option-facts">
        <span class="${risk.highSegs ? 'is-bad' : ''}"><i class="ti ti-alert-triangle"></i> ${risk.highKm != null
          ? `${Math.round(risk.highKm)} km high-risk road` : `${risk.highSegs} high-risk of ${tvPlural(risk.segCount, 'segment')}`}</span>
        <span>${band.label}</span>
      </span>
      ${news ? `<span class="tv-option-news">${news}</span>` : ''}
    </button>`;
  }).join('');
}

function renderTravelRoute(corr, refit){
  travelMapGroup.clearLayers();

  // The options not chosen, drawn underneath and clickable.
  tvRoutes.forEach((route, i) => {
    if (route === corr) return;
    tvDrawLine(route.net ? route.net.line : route.waypoints.map(w => [w[0], w[1]]), '#5aa9ff', 3, { dashArray:'2 9', casing: 0.55 })
      .bindTooltip(`${route.legs.length === 1 ? route.road : `via ${route.via.join(' · ')}`} — tap to compare`, { sticky:true })
      .on('click', () => selectTravelRoute(i));
  });

  const { levels, raised } = tvEffectiveLevels(corr);
  for (let i = 0; i < corr.waypoints.length - 1; i++){
    const a = corr.waypoints[i], b = corr.waypoints[i+1];
    const risk = TV_SEG_WEIGHT[levels[i]] >= TV_SEG_WEIGHT[levels[i+1]] ? levels[i] : levels[i+1];
    const path = corr.net ? corr.net.line.slice(corr.net.wpAt[i], corr.net.wpAt[i+1] + 1) : [[a[0],a[1]],[b[0],b[1]]];
    // Without a road the line is only a sketch between towns, so it is drawn broken.
    if (path.length > 1) tvDrawLine(path, TV_SEG_COLOR[risk], 5, corr.net ? { interactive:false } : { dashArray:'2 10', casing: 0.4, interactive:false });
  }
  tvDrawArrows(corr);
  // Waypoints sit where the road actually passes them.
  const spot = j => corr.net ? corr.net.line[corr.net.wpAt[j]] : corr.waypoints[j].slice(0, 2);
  corr.stretches.forEach(stretch => {
    L.marker([stretch.at[0], stretch.at[1]], {
      icon: L.divIcon({ className:'', iconSize:[0,0], html:`<div class="tv-stretch-flag"><i class="ti ti-alert-triangle-filled"></i> ${escapeHtml(stretch.name)} · ambush-prone</div>` })
    }).addTo(travelMapGroup);
  });

  // Towns along the road, and what has been reported at each.
  const live = tvLiveData(corr);
  corr.waypoints.slice(1, -1).forEach((w, offset) => {
    if (!w[3]) return;
    const events = live ? live.events.filter(e => e.places.includes(w[3])) : [];
    const junction = corr.via.includes(w[3]);
    const marker = L.marker(spot(offset + 1), {
      icon: L.divIcon({ className:'', iconSize:[0,0],
        html:`<div class="tv-town${events.length ? ' has-news' : ''}${junction ? ' is-junction' : ''}${raised.has(offset + 1) ? ' is-raised' : ''}"><span class="tv-town-dot"></span>${escapeHtml(w[3])}${events.length ? ` <b>${events.length}</b>` : ''}</div>` })
    }).addTo(travelMapGroup);
    if (events.length){
      marker.bindPopup(`<div class="popup-title">${escapeHtml(w[3])} · ${tvPlural(events.length, 'report')}</div>` +
        events.slice(0, 3).map(e => `<div class="popup-detail"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a><br><span style="opacity:.7">${escapeHtml(e.source)} · ${tvAgo(e.ageHours)}</span></div>`).join(''));
    }
  });

  if (tvMode === 'Bus'){
    [['from', corr.from, corr.parkFrom], ['to', corr.to, corr.parkTo]].forEach(([end, town, chosen]) => {
      tvParksFor(town).forEach(park => {
        const isChosen = chosen && chosen.id === park.id;
        L.marker([park.lat, park.lng], {
          zIndexOffset: isChosen ? 400 : 0,
          icon: L.divIcon({ className:'', iconSize:[0,0],
            html:`<div class="tv-park is-${end}${isChosen ? ' is-chosen' : ''}"><i class="ti ti-bus"></i></div>` })
        }).bindTooltip(`<strong>${escapeHtml(park.name)}</strong><br>${isChosen ? (end === 'from' ? 'Departure park' : 'Arrival park') : (end === 'from' ? 'Tap to depart from here' : 'Tap to arrive here')}${park.operator ? `<br>${escapeHtml(park.operator)}` : ''}${park.approx ? '<br><em>Position approximate</em>' : ''}`, { direction:'top', offset:[0,-12] })
          .on('click', () => chooseTravelPark(end, park.id))
          .addTo(travelMapGroup);
      });
    });
  }

  const wp = corr.waypoints;
  L.marker(spot(0), { icon: tvEndIcon('A', 'from'), zIndexOffset: 600 }).bindPopup(`<div class="popup-title">${escapeHtml(tvEndName(corr, 'from'))} · start</div>`).addTo(travelMapGroup);
  L.marker(spot(wp.length - 1), { icon: tvEndIcon('B', 'to'), zIndexOffset: 600 }).bindPopup(`<div class="popup-title">${escapeHtml(tvEndName(corr, 'to'))} · destination</div>`).addTo(travelMapGroup);
  if (refit) fitTravelBounds();
}

function renderTravelRating(corr, risk, label){
  const band = tvRiskBand(risk.score);
  const entry = tvNewsEntry(corr);
  const live = entry.data;
  const stamp = entry.status === 'loading' ? 'checking news…'
    : live ? `news checked ${formatNewsDate(live.generatedAt)}`
    : 'baseline only';
  const rows = [
    ['segments', 'Road segments'], ['states', 'State hotspot index'],
    ['time', 'Hours on the road'], ['live', 'Live reports']
  ].map(([key, name]) => {
    const value = Math.round(risk.parts[key]);
    const off = key === 'live' && !risk.hasLive;
    return `<div class="tv-part${off ? ' is-off' : ''}">
      <span class="tv-part-lbl">${name}<em>${Math.round(risk.weights[key] * 100)}%</em></span>
      <span class="tv-part-track"><span class="tv-part-fill" style="width:${off ? 0 : value}%;background:${tvHourColor(value)}"></span></span>
      <span class="tv-part-val">${off ? '—' : value}</span>
    </div>`;
  }).join('');
  const approx = corr.estimated ? '≈ ' : '';
  const legRows = corr.legs.length > 1
    ? `<div class="tv-legs"><div class="tv-parts-hd">Leg by leg</div>${corr.legs.map(leg =>
        `<div class="tv-leg"><span>${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}</span><span>${leg.distanceKm} km · ${tvDuration(leg.estMin)}</span></div>`).join('')}</div>`
    : '';

  const approxPark = [corr.parkFrom, corr.parkTo].some(park => park && park.approx);
  const parkRows = tvMode === 'Bus'
    ? `<div class="tv-legs"><div class="tv-parts-hd">Park to park</div>
        <div class="tv-leg tv-leg-wide"><span>Depart</span><span>${escapeHtml(tvEndName(corr, 'from'))}${corr.parkFrom ? '' : ' (town centre)'}</span></div>
        <div class="tv-leg tv-leg-wide"><span>Arrive</span><span>${escapeHtml(tvEndName(corr, 'to'))}${corr.parkTo ? '' : ' (town centre)'}</span></div>
        <div class="tv-leg tv-leg-wide"><span>By road</span><span>${approx}${corr.distanceKm} km · ${tvDuration(corr.estMin)} driving, before stops</span></div>
        ${approxPark ? '<div class="tv-states">A park marked approximate is placed at the centre of its neighbourhood, so allow a few hundred metres.</div>' : ''}
      </div>`
    : '';

  const card = document.getElementById('tvRatingCard');
  card.className = `panel-card tv-rating-card ${band.cls}`;
  card.innerHTML = `
    <div class="tv-rating-top">
      <span class="tv-risk-badge ${band.cls}">${band.label}</span>
      <span class="tv-rating-live">${escapeHtml(stamp)}</span>
    </div>
    <div class="tv-score">${risk.score}<span class="tv-score-max"> /100</span></div>
    <div class="tv-corridor"><i class="ti ti-route"></i> ${escapeHtml(corr.from)} → ${escapeHtml(corr.to)} · ${escapeHtml(corr.road)}${label ? ` · ${escapeHtml(label)}` : ''}</div>
    <div class="tv-metrics">
      <div class="tv-metric"><div class="tv-metric-lbl">Distance</div><div class="tv-metric-val">${approx}${corr.distanceKm} km</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Est. time</div><div class="tv-metric-val">${approx}${tvDuration(corr.estMin)}</div></div>
      ${risk.highKm != null
        ? `<div class="tv-metric"><div class="tv-metric-lbl">High-risk road</div><div class="tv-metric-val ${risk.highSegs ? 'danger' : ''}">${Math.round(risk.highKm)} km</div></div>`
        : `<div class="tv-metric"><div class="tv-metric-lbl">Risk segments</div><div class="tv-metric-val ${risk.highSegs ? 'danger' : ''}">${risk.highSegs} of ${risk.segCount}</div></div>`}
      <div class="tv-metric"><div class="tv-metric-lbl">Checkpoints</div><div class="tv-metric-val">${corr.checkpoints}</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Reports · 7 days</div><div class="tv-metric-val">${live ? live.counts.events : '—'}</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">On this road</div><div class="tv-metric-val ${live && live.counts.onRoute ? 'danger' : ''}">${live ? live.counts.onRoute : '—'}</div></div>
    </div>
    <div class="tv-parts"><div class="tv-parts-hd">What the score is made of</div>${rows}</div>
    ${parkRows}
    ${legRows}
    <div class="tv-states">Crosses ${corr.states.map(s => escapeHtml(s) + (corr.net?.stateKm.has(s) ? ` ${Math.round(corr.net.stateKm.get(s))} km` : '')).join(' · ')}${corr.derivedRisk ? ' · some segment risk is taken from the state’s hotspot index' : ''}</div>
    <div class="tv-states">${corr.net
      ? `Distance, driving time and states crossed are measured on the road network (${escapeHtml(corr.net.provider)}). Driving time assumes a clear road.`
      : tvRoadEntry(corr).status === 'loading' ? 'Locating this route on the road network…'
      : 'Road network unavailable — distance and time are straight-line estimates.'}</div>`;
}

function tvFade(hex, alpha){
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Leave at this hour instead: everything on the page follows.
function setTravelDepartHour(hour){
  const h = ((Math.round(hour) % 24) + 24) % 24;
  document.getElementById('tvTime').value = `${String(h).padStart(2, '0')}:00`;
  if (tvCurrentCorridor) tvRenderAssessment();
}

// What leaving at the chosen hour means, and the hour that would score lowest.
function renderTravelHourDetail(corr, curve, departHour){
  const box = document.getElementById('tvHourDetail');
  if (!box) return;
  const risk = tvRouteRisk(corr, departHour);
  const band = tvRiskBand(risk.score);
  const arriveMin = departHour * 60 + corr.estMin;
  const arrive = `${tv12h(Math.floor(arriveMin / 60) % 24).replace(':00', `:${String(arriveMin % 60).padStart(2, '0')}`)}${arriveMin >= 1440 ? ' next day' : ''}`;
  let worst = departHour;
  for (let h = 0; h <= Math.ceil(corr.estMin / 60); h++){
    const hour = (departHour + h) % 24;
    if (curve[hour] > curve[worst]) worst = hour;
  }
  // Daylight departures only: nobody is being sent out at 2 a.m.
  let best = TV_FIRST_LIGHT, bestScore = Infinity;
  for (let h = TV_FIRST_LIGHT; h <= 20; h++){
    const score = tvRouteRisk(corr, h).score;
    if (score < bestScore){ best = h; bestScore = score; }
  }
  box.innerHTML = `
    <div class="tv-hour-hd"><strong>Leaving at ${tv12h(departHour)}</strong><span class="tv-risk-badge ${band.cls}">${risk.score}/100 · ${band.label}</span></div>
    <div class="tv-hour-facts">
      <span>On the road</span><b>${tv12h(departHour)} – ${arrive}</b>
      <span>Risk when you set off</span><b style="color:${tvHourColor(curve[departHour])}">${curve[departHour]} of 100</b>
      <span>Worst hour on the way</span><b style="color:${tvHourColor(curve[worst])}">${tv12h(worst)} · ${curve[worst]}</b>
    </div>
    <div class="tv-hour-actions">
      <button type="button" class="tv-inline-btn" onclick="setTravelDepartHour(${departHour - 1})"><i class="ti ti-chevron-left"></i> Earlier</button>
      <button type="button" class="tv-inline-btn" onclick="setTravelDepartHour(${departHour + 1})">Later <i class="ti ti-chevron-right"></i></button>
      ${best !== departHour && bestScore < risk.score
        ? `<button type="button" class="tv-inline-btn is-best" onclick="setTravelDepartHour(${best})"><i class="ti ti-clock-play"></i> Lowest risk: ${tv12h(best)} · ${bestScore}</button>`
        : '<span class="tv-hour-best"><i class="ti ti-circle-check"></i> This is the lowest-risk daylight departure</span>'}
    </div>`;
}

function renderTravelHourChart(corr, departHour){
  const canvas = document.getElementById('tvHourChart');
  const { curve, mentions } = tvHourlyCurve(corr);
  if (!canvas) return curve;
  const labels = Array.from({length:24}, (_,h) => [0,6,12,18,23].includes(h) ? (h===23?'11p':tvShortH(h)) : '');
  // Hours spent on the road stand out; the rest are dimmed.
  const onRoad = new Set();
  for (let h = 0; h <= Math.ceil(corr.estMin / 60); h++) onRoad.add((departHour + h) % 24);
  const fills = curve.map((value, h) => onRoad.has(h) ? tvHourColor(value) : tvFade(tvHourColor(value), 0.32));
  const borders = curve.map((_, h) => h === departHour ? 2 : 0);
  if (tvHourChart) {
    const set = tvHourChart.data.datasets[0];
    set.data = curve; set.backgroundColor = fills; set.borderWidth = borders;
    tvHourChart.update();
  } else {
    tvHourChart = new Chart(canvas, {
      type:'bar',
      data:{ labels, datasets:[{ data: curve, backgroundColor: fills, borderColor:'#ffffff', borderWidth: borders, borderRadius:3, barPercentage:0.9, categoryPercentage:0.94 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        // A tap anywhere in an hour's column picks that hour, not only on the bar.
        interaction:{ mode:'index', intersect:false },
        onClick:(event, elements) => { if (elements.length) setTravelDepartHour(elements[0].index); },
        onHover:(event, elements) => { event.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:(it)=>tv12h(it[0].dataIndex), label:(it)=>`Relative risk ${it.raw}`, footer:()=>'Tap to leave at this hour' } } },
        scales:{ x:{ grid:{display:false}, ticks:{ color:'#8a94a3', font:{size:9}, autoSkip:false, maxRotation:0 } },
                 y:{ display:false, beginAtZero:true } } }
    });
  }
  document.getElementById('tvSafeWindow').textContent = tvWindow(curve, v => v < 30);
  document.getElementById('tvPeakWindow').textContent = tvWindow(curve, v => v >= 56);
  document.getElementById('tvEstNote').innerHTML = `<i class="ti ti-info-circle"></i> Tap any hour to plan for it. Bright bars are the hours you would be on the road. Modelled daylight/dusk pattern${mentions
    ? `, raised for the times of day named in ${tvPlural(mentions, 'recent report')}` : ''} — not live per-hour data.`;
  renderTravelHourDetail(corr, curve, departHour);
  return curve;
}

function renderTravelDepart(corr, risk, curve){
  let peakStart = -1;
  for (let h = 12; h < 24; h++) if (curve[h] >= 56) { peakStart = h; break; }
  if (peakStart < 0) peakStart = 17;
  const live = tvLiveData(corr);
  const travelH = corr.estMin / 60;
  // A busy week on this road earns an extra hour's margin before dusk.
  const margin = live && live.liveIndex >= 50 ? 2 : 1;
  const leaveBy = Math.floor(peakStart - travelH - margin);
  const postpone = risk.score >= 80 && live && live.events.some(e => e.onRoute && (e.ageHours ?? 999) <= 48);
  // Too far to drive between first light and dusk: say so rather than
  // recommend a departure in the small hours.
  const tooLong = leaveBy < TV_FIRST_LIGHT;

  const box = document.getElementById('tvDepart');
  box.classList.toggle('is-warn', Boolean(postpone || tooLong));
  box.querySelector('.tv-depart-ico i').className = postpone ? 'ti ti-hand-stop' : tooLong ? 'ti ti-bed' : 'ti ti-circle-check';
  document.getElementById('tvDepartLbl').textContent = postpone || tooLong ? 'Recommendation' : 'Recommended departure';
  document.getElementById('tvDepartVal').textContent = postpone ? 'Postpone if you can'
    : tooLong ? 'Break the journey overnight'
    : `Leave before ${tv12h(leaveBy)}`;
  // Tapping the card plans for the hour it recommends.
  const suggested = tooLong ? TV_FIRST_LIGHT : Math.max(TV_FIRST_LIGHT, leaveBy - 1);
  box.onclick = postpone ? null : () => setTravelDepartHour(suggested);
  box.classList.toggle('is-clickable', !postpone);
  box.title = postpone ? '' : `Plan for a ${tv12h(suggested)} departure`;
  return { peakStart, leaveBy, postpone, tooLong, margin };
}

function tvSourceLine(e){
  const extra = e.sourceCount > 1 ? ` and ${tvPlural(e.sourceCount - 1, 'other outlet')}` : '';
  return `${escapeHtml(e.source)}${extra}, ${tvAgo(e.ageHours)}`;
}

// The safe-travel guide: what the score, the road and this week's reports add
// up to, in the order a traveller needs it.
function renderTravelRecs(corr, departHour, dep, risks, labels){
  const groups = { verdict: [], road: [], timing: [], mode: [], ready: [] };
  const add = (group, c, i, html) => groups[group].push({ c, i, html });
  const live = tvLiveData(corr);
  const mine = tvRoutes.indexOf(corr);
  const risk = risks[mine];
  const band = tvRiskBand(risk.score);
  const recent = live ? live.events.filter(e => (e.ageHours ?? 999) <= 96) : [];
  const has = category => recent.some(e => e.category === category);
  const violent = recent.filter(e => ['kidnapping', 'armed_attack', 'explosion', 'killing'].includes(e.category));

  // ── Verdict
  const verdict = {
    'is-crit': ['r-red', 'ti-alert-octagon', 'Travel only if you must — in daylight, and with others.'],
    'is-high': ['r-orange', 'ti-alert-triangle', 'Travel in daylight and follow the plan below closely.'],
    'is-mod':  ['r-blue', 'ti-info-circle', 'Normal precautions, with extra care on the flagged stretches.'],
    'is-low':  ['r-green', 'ti-circle-check', 'Nothing unusual is showing; ordinary road sense applies.']
  }[band.cls];
  const facts = [];
  if (risk.highKm != null) facts.push(`${Math.round(risk.highKm)} of ${corr.distanceKm} km is rated high-risk`);
  if (live) facts.push(`${tvPlural(live.counts.events, 'incident')} reported in the states it crosses this week, ${live.counts.onRoute} at towns on the road`);
  add('verdict', verdict[0], verdict[1], `<strong>${band.label} · ${risk.score}/100.</strong> ${verdict[2]}${facts.length ? ` ${facts.join('; ')}.` : ''}`);
  if (dep.postpone){
    add('verdict', 'r-red', 'ti-hand-stop', `<strong>Postpone non-essential travel on this road.</strong> The route scores in the highest band and incidents have been reported on it in the last two days.`);
  }
  if (tvRoutes.length > 1){
    const safest = risks.reduce((best, r, i) => r.score < risks[best].score ? i : best, 0);
    if (safest !== mine && risks[mine].score - risks[safest].score >= 4){
      const other = tvRoutes[safest];
      const delta = other.estMin - corr.estMin;
      add('verdict', 'r-blue', 'ti-arrows-shuffle', `<strong>The route ${escapeHtml(other.road)} scores ${risks[mine].score - risks[safest].score} points lower</strong> (${risks[safest].score} against ${risks[mine].score})${delta > 0 ? ` for about ${delta} minutes more driving` : delta < 0 ? ` and is about ${-delta} minutes quicker` : ''}. <button type="button" class="tv-inline-btn" onclick="selectTravelRoute(${safest})">Show it</button>`);
    } else if (safest === mine){
      add('verdict', 'r-green', 'ti-circle-check', `<strong>This is the lowest-risk of the ${tvRoutes.length} routes</strong> between ${escapeHtml(corr.from)} and ${escapeHtml(corr.to)}.`);
    }
  }

  // ── On this road now
  if (live){
    live.events.filter(e => e.onRoute).slice(0, 3).forEach(e => {
      add('road', TV_CATEGORY[e.category]?.cls === 'c-blue' ? 'r-blue' : 'r-red', TV_CATEGORY[e.category]?.icon || 'ti-alert-triangle',
        `<strong>Reported at ${escapeHtml(e.places.join(', '))}:</strong> <a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a> <span class="tv-rec-src">— ${tvSourceLine(e)}</span>`);
    });
  }
  corr.stretches.slice(0, 2).forEach(stretch => {
    add('road', 'r-red', 'ti-alert-triangle-filled', `<strong>Do not stop on the ${escapeHtml(stretch.name)} stretch (km ${stretch.kmFrom}–${stretch.kmTo}).</strong> It carries the highest ambush risk on this route, especially after dark.`);
  });
  if (live){
    // The kinds of incident being reported most, weighted by how recent and how close.
    const byCategory = new Map();
    recent.forEach(e => {
      const item = byCategory.get(e.category) || { weight: 0, events: [] };
      item.weight += e.weight; item.events.push(e);
      byCategory.set(e.category, item);
    });
    [...byCategory.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 3).forEach(([category, item]) => {
      const meta = TV_CATEGORY[category];
      const states = [...new Set(item.events.flatMap(e => e.states))];
      const lead = item.events[0];
      add('road', meta.cls === 'c-red' ? 'r-red' : meta.cls === 'c-blue' ? 'r-blue' : 'r-orange', meta.icon,
        `<strong>${tvPlural(item.events.length, `${lead.categoryLabel.toLowerCase()} report`)} in ${escapeHtml(states.join(', '))} in the last four days.</strong> ${meta.advice} <span class="tv-rec-src">Latest: <a href="${escapeHtml(lead.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.title)}</a> — ${tvSourceLine(lead)}</span>`);
    });
    if (!live.counts.events){
      add('road', 'r-green', 'ti-news', `<strong>No incident reports found for this route in the last ${live.windowDays} days</strong> across ${tvPlural(live.sources.answered, 'source')}. Quiet coverage is not proof of a safe road — the usual precautions still apply.`);
    }
    const kinds = Object.entries(live.sources.byMedium || {}).sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${count} ${(HS_MEDIUM[key]?.[1] || key).toLowerCase()}`).join(', ');
    add('road', 'r-blue', 'ti-rss', `<strong>What this is based on:</strong> ${live.sources.answered} of ${tvPlural(live.sources.checked, 'Nigerian source')} answered${kinds ? ` (${kinds})` : ''}, ${live.sources.regionalAnswered} of them local to these states. Headlines are leads, not verified counts.`);
  } else {
    add('road', 'r-orange', 'ti-news-off', `<strong>This week's reports are not in yet.</strong> The guide below rests on the road's baseline risk until the news sources answer.`);
  }

  // ── When to travel
  if (dep.tooLong){
    const stop = corr.via[Math.floor(corr.via.length / 2)];
    add('timing', 'r-orange', 'ti-bed', `<strong>At ${tvDuration(corr.estMin)} this is too long to finish in daylight.</strong> Leave at first light and stop overnight${stop ? ` in ${escapeHtml(stop)}` : ' at a major town'} rather than drive into the evening.`);
  } else {
    const entersPeak = departHour >= dep.peakStart || (departHour + corr.estMin/60) >= dep.peakStart;
    add('timing', entersPeak ? 'r-orange' : 'r-green', 'ti-sun-high', entersPeak
      ? `<strong>Leave earlier.</strong> A ${tv12h(departHour)} departure puts you on the road in the peak-risk window; set off before ${tv12h(Math.max(dep.leaveBy, TV_FIRST_LIGHT))} to arrive before dusk.`
      : `<strong>Your ${tv12h(departHour)} departure works.</strong> It keeps the whole ${tvDuration(corr.estMin)} drive clear of the dusk peak — do not let it slip.`);
  }
  if (live){
    const dark = (live.counts.timeOfDay.night || 0) + (live.counts.timeOfDay.evening || 0) + (live.counts.timeOfDay.dawn || 0);
    if (dark){
      add('timing', 'r-orange', 'ti-moon', `<strong>${tvPlural(dark, 'recent report')} describe${dark === 1 ? 's' : ''} incidents after dark or before dawn.</strong> Be off the road by ${tv12h(Math.max(dep.peakStart - 1, 12))}.`);
    }
  }
  if (has('road_condition')){
    add('timing', 'r-blue', 'ti-road-off', `<strong>Allow extra time.</strong> Flooding, closures or failed sections have been reported in the states on this route; check the road is passable before you set off.`);
  }

  // ── By bus, car or convoy
  if (tvMode === 'Bus'){
    add('mode', 'r-blue', 'ti-bus', corr.parkFrom
      ? `<strong>Board inside ${escapeHtml(corr.parkFrom.name)}.</strong> Use a registered operator's bay and ticket desk — not touts, and not a vehicle loading on the roadside outside the park.`
      : `<strong>Board at a recognised motor park.</strong> Use a registered operator's bay and ticket desk — not touts, and not a vehicle loading on the roadside.`);
    if (departHour >= 14 || dep.tooLong){
      add('mode', 'r-orange', 'ti-clock-hour-7', `<strong>Take a morning bus.</strong> Afternoon and night buses are on the road through the hours with the most incidents${dep.tooLong ? ', and this trip is too long for one daylight run' : ''}.`);
    }
    if (violent.length){
      add('mode', 'r-red', 'ti-shield-check', `<strong>Ask the operator how it runs this road.</strong> With ${tvPlural(violent.length, 'violent incident')} reported this week, prefer one that travels in convoy or with an escort, and that does not stop between towns.`);
    }
    if (has('road_crash')){
      add('mode', 'r-orange', 'ti-car-crash', `<strong>Pick the safer vehicle.</strong> Crashes have been reported on this route: choose an operator with speed-limited buses, wear the seat belt, and speak up if the driver is speeding.`);
    }
    add('mode', 'r-blue', 'ti-id', `<strong>Fill in the manifest properly</strong> with a next of kin who will answer, and send the operator's name and the bus registration number to someone before it leaves.`);
  } else if (tvMode === 'Convoy'){
    add('mode', 'r-green', 'ti-shield', `<strong>Good — you're moving in convoy.</strong> Agree a lead and a tail vehicle, keep them in sight of each other, and regroup at ${corr.via.length ? escapeHtml(corr.via.join(', ')) : 'each major town'} rather than on open road.`);
    add('mode', 'r-orange', 'ti-gas-station', `<strong>Fuel every vehicle before departure</strong> so the convoy never has to stop in a flagged stretch.`);
  } else {
    add('mode', 'r-orange', 'ti-shield', `<strong>Do not drive this alone if you can avoid it.</strong> Travel with another vehicle, keep doors locked, and do not stop for anyone on open road${corr.stretches.length ? ' — least of all in the flagged stretch' : ''}.`);
    add('mode', 'r-orange', 'ti-gas-station', `<strong>Fuel up and check tyres and the spare before you leave,</strong> so the only stops you make are in towns.`);
    if (has('road_crash')){
      add('mode', 'r-orange', 'ti-car-crash', `<strong>Keep your speed down.</strong> Crashes have been reported on this route this week; leave room around tankers and trucks.`);
    }
  }

  // ── Before you leave
  add('ready', 'r-blue', 'ti-share', `<strong>Share your trip</strong> with a trusted contact — route, ${tvMode === 'Bus' ? 'operator, ' : ''}departure time and expected arrival — and check in at ${corr.via.length ? escapeHtml(corr.via.join(', ')) : 'each major town'}.`);
  if (corr.checkpoints){
    add('ready', 'r-blue', 'ti-id-badge-2', `<strong>Carry ID${tvMode === 'Bus' ? '' : ' and the vehicle papers'}.</strong> About ${tvPlural(corr.checkpoints, 'checkpoint')} are on record along this route. Stop only at manned, marked ones.`);
  }
  add('ready', 'r-blue', 'ti-phone', `<strong>Charge your phone and save the emergency numbers:</strong> 112 for any emergency and 122 for road crashes (FRSC).`);

  const titles = {
    verdict: 'Route verdict', road: 'On this road now', timing: 'When to travel',
    mode: { Bus: 'Travelling by bus', Convoy: 'Travelling in convoy', Car: 'Travelling by car' }[tvMode] || 'On the road',
    ready: 'Before you leave'
  };
  document.getElementById('tvRecs').innerHTML = Object.keys(groups).filter(key => groups[key].length).map(key =>
    `<div class="tv-rec-group">${titles[key]}</div>` + groups[key].map(r =>
      `<div class="tv-rec ${r.c}"><i class="ti ${r.i} tv-rec-ico"></i><div class="tv-rec-txt">${r.html}</div></div>`).join('')).join('');
}

// ── Directions ───────────────────────────────────────────────

// The roads to follow, each with the risk of the stretch it covers and the
// towns on it where something has been reported.
function renderTravelDirections(){
  const list = document.getElementById('tvDirList');
  if (!list) return;
  const corr = tvCurrentCorridor;
  if (!corr){ list.innerHTML = '<div class="tv-empty">Assess a route to see the roads it follows.</div>'; return; }
  const entry = tvRoadEntry(corr);
  if (!corr.net){
    list.innerHTML = entry.status === 'error'
      ? `<div class="tv-empty"><strong>Could not reach the road network.</strong> ${escapeHtml(entry.error)} The map shows straight lines between towns and the figures are estimates. <button type="button" class="tv-inline-btn" onclick="retryTravelRoads()">Try again</button></div>`
      : '<div class="tv-news-wait"><i class="ti ti-loader-2"></i> Locating this route on the road network…</div>';
    return;
  }

  const { cum, wpAt, directions } = corr.net;
  const { levels } = tvEffectiveLevels(corr);
  const live = tvLiveData(corr);
  const lastTown = corr.to;
  const rows = directions.map((step, index) => {
    // Worst segment this road shares at least half a kilometre with.
    let level = 'low';
    for (let i = 0; i < wpAt.length - 1; i++){
      const overlap = Math.min(step.kmTo, cum[wpAt[i + 1]]) - Math.max(step.kmFrom, cum[wpAt[i]]);
      if (overlap < 0.5) continue;
      const worse = TV_SEG_WEIGHT[levels[i]] >= TV_SEG_WEIGHT[levels[i + 1]] ? levels[i] : levels[i + 1];
      if (TV_SEG_WEIGHT[worse] > TV_SEG_WEIGHT[level]) level = worse;
    }
    const towns = corr.waypoints
      .map((w, j) => ({ name: w[3], km: cum[wpAt[j]] }))
      .filter(town => town.name && town.km >= step.kmFrom && town.km < step.kmTo);
    const reports = live ? live.events.filter(e => e.places.some(place => towns.some(town => town.name === place))).length : 0;
    const ahead = corr.waypoints.find((w, j) => w[3] && cum[wpAt[j]] >= step.kmTo)?.[3] || lastTown;
    const where = towns.length ? `through ${towns.map(town => escapeHtml(town.name)).join(', ')}` : `towards ${escapeHtml(ahead)}`;
    const turn = tvTurn(step, index === 0);
    return `<li class="tv-dir is-${level}">
      <span class="tv-dir-num" title="Step ${index + 1}"><i class="ti ${turn.icon}"></i></span>
      <span class="tv-dir-body">
        <span class="tv-dir-road">${index === 0 ? 'Leave ' + escapeHtml(corr.parkFrom ? corr.parkFrom.name : corr.from) + ' on ' : turn.verb + ' '}<strong>${escapeHtml(step.label || 'an unnamed road')}</strong></span>
        <span class="tv-dir-meta">${step.km >= 10 ? Math.round(step.km) : step.km.toFixed(1)} km · ${tvDuration(Math.round(step.min))} · ${where}</span>
        <span class="tv-dir-tags"><span class="tv-dir-level">${{ low: 'Low risk', caution: 'Caution', high: 'High risk' }[level]}</span>${reports ? `<span class="tv-dir-reports">${tvPlural(reports, 'report')}</span>` : ''}<span class="tv-dir-km">km ${Math.round(step.kmFrom)}–${Math.round(step.kmTo)}</span></span>
      </span>
    </li>`;
  }).join('');
  list.innerHTML = `<ol class="tv-dirs">${rows}
    <li class="tv-dir is-end"><span class="tv-dir-num"><i class="ti ti-flag-filled"></i></span><span class="tv-dir-body"><span class="tv-dir-road">Arrive ${corr.parkTo ? 'at' : 'in'} <strong>${escapeHtml(tvEndName(corr, 'to'))}</strong></span><span class="tv-dir-meta">${corr.distanceKm} km · ${tvDuration(corr.estMin)} of driving</span></span></li>
  </ol>`;
}

// ── News panel ───────────────────────────────────────────────

function setTravelNewsFilter(btn){
  tvNewsFilter = btn.dataset.filter;
  renderTravelNews();
}

function refreshTravelNews(){
  tvRoutes.forEach(route => tvLoadNews(route, true));
}

function tvNewsItemHtml(e){
  const meta = TV_CATEGORY[e.category] || { icon: 'ti-news', cls: 'c-blue' };
  const tags = [];
  if (e.onRoute) tags.push(`<span class="tv-news-tag is-route"><i class="ti ti-map-pin"></i> On this road · ${escapeHtml(e.places.join(', '))}</span>`);
  else if (e.road) tags.push('<span class="tv-news-tag is-road"><i class="ti ti-road"></i> Road-related</span>');
  if (e.response) tags.push('<span class="tv-news-tag">Security response</span>');
  if (e.locatedBy === 'search') tags.push('<span class="tv-news-tag is-soft" title="The headline does not name the state; the article came up in a search for it.">Location from search</span>');
  const more = e.sourceCount > 1
    ? `<span class="tv-news-more" title="${escapeHtml(e.coverage.map(c => c.source).join(', '))}">+${e.sourceCount - 1} more</span>` : '';
  return `<a class="tv-news-item" href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">
    <span class="tv-news-ico ${meta.cls}"><i class="ti ${meta.icon}"></i></span>
    <span class="tv-news-body">
      <span class="tv-news-top"><span class="tv-news-cat ${meta.cls}">${escapeHtml(e.categoryLabel)}</span><span class="tv-news-where">${escapeHtml(e.states.join(' · '))}</span><span class="tv-news-age">${tvAgo(e.ageHours)}</span></span>
      <span class="tv-news-title">${escapeHtml(e.title)}</span>
      <span class="tv-news-meta"><span class="tv-news-src${e.regionalSources.length ? ' is-regional' : ''}">${e.regionalSources.length ? '<i class="ti ti-building-broadcast-tower"></i> ' : ''}${escapeHtml(e.source)}</span><span class="hs-media">${hsMediaIcons(e.media)}</span>${more}${tags.join('')}</span>
    </span>
  </a>`;
}

function renderTravelNews(){
  const list = document.getElementById('tvNewsList');
  const summary = document.getElementById('tvNewsSummary');
  const sourcesEl = document.getElementById('tvNewsSources');
  if (!list) return;
  const entry = tvNewsEntry(tvCurrentCorridor);
  document.querySelectorAll('#tvNewsFilters .tv-news-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === tvNewsFilter));
  document.getElementById('tvNewsRefresh').classList.toggle('is-busy', entry.status === 'loading');

  if (!tvCurrentCorridor || (entry.status === 'idle' && !entry.data)){
    summary.textContent = '';
    sourcesEl.innerHTML = '';
    list.innerHTML = '<div class="tv-empty">Assess a route to see what is being reported along it.</div>';
    return;
  }
  if (entry.status === 'loading' && !entry.data){
    summary.textContent = 'Checking regional and national sources…';
    sourcesEl.innerHTML = '';
    list.innerHTML = '<div class="tv-news-wait"><i class="ti ti-loader-2"></i> Reading the papers for the states on this route. The first check takes a few seconds.</div>';
    return;
  }
  if (entry.status === 'error'){
    summary.textContent = 'News unavailable';
    sourcesEl.innerHTML = '';
    list.innerHTML = `<div class="tv-empty"><strong>Could not load route news.</strong> ${escapeHtml(entry.error)} The rating is the baseline without live reports. <button type="button" class="tv-inline-btn" onclick="refreshTravelNews()">Try again</button></div>`;
    return;
  }

  const live = entry.data;
  const c = live.counts;
  summary.innerHTML = `<strong>${escapeHtml(tvCurrentCorridor.road)}</strong> · ${tvPlural(c.events, 'incident')} from ${tvPlural(c.reports, 'report')} · ${c.onRoute} on this road · ${c.roadRelated} road-related · ${c.last24h} in the last 24h`;

  const filters = {
    all: () => true,
    route: e => e.onRoute || e.road,
    regional: e => e.regionalSources.length > 0,
    day: e => (e.ageHours ?? 999) <= 24
  };
  const shown = live.events.filter(filters[tvNewsFilter] || filters.all);
  list.innerHTML = shown.length
    ? shown.map(tvNewsItemHtml).join('')
    : `<div class="tv-empty">${live.events.length ? 'Nothing matches this filter.' : `No incident reports found for the states on this route in the last ${live.windowDays} days.`}</div>`;

  const s = live.sources;
  const regional = s.list.filter(row => row.scope === 'regional');
  const row = r => `<li class="${r.ok ? '' : 'is-down'}"><span>${escapeHtml(r.name)}</span><span>${r.ok ? `${r.matched} of ${r.items} relevant${r.stale ? ' · cached' : ''}` : 'no answer'}</span></li>`;
  const wasOpen = sourcesEl.querySelector('details')?.open;
  sourcesEl.innerHTML = `<details${wasOpen ? ' open' : ''}>
    <summary><i class="ti ti-rss"></i> ${s.answered} of ${tvPlural(s.checked, 'source')} answered · ${s.regionalAnswered} regional${Object.entries(s.byMedium || {}).sort((a, b) => b[1] - a[1]).map(([key, count]) => ` · ${count} ${(HS_MEDIUM[key]?.[1] || key).toLowerCase()}`).join('')}${s.failed.length ? ` · ${s.failed.length} unreachable` : ''}${s.offline.length ? ` · ${s.offline.length} not online` : ''}</summary>
    <div class="tv-src-grid">
      <div><div class="tv-src-hd">Regional outlets for ${escapeHtml(live.route.zones.join(', '))}</div><ul>${regional.map(row).join('') || '<li><span>None with a feed for these states</span><span></span></li>'}</ul></div>
      <div><div class="tv-src-hd">National outlets and searches</div><ul>${s.list.filter(r => r.scope !== 'regional').map(row).join('')}</ul></div>
    </div>
    ${s.offline.length ? `<div class="tv-src-note">No working website or feed was found for ${s.offline.map(o => escapeHtml(o.name)).join(', ')}. Their states are still covered by the per-state searches.</div>` : ''}
    <div class="tv-src-note">Reports are matched to the route by the places their headlines name. They are media leads, not verified incident counts.</div>
  </details>`;
}

// ── Assessment ───────────────────────────────────────────────

function tvDepartHour(){
  const timeVal = (document.getElementById('tvTime').value || '16:30');
  const hour = parseInt(timeVal.split(':')[0], 10);
  return Number.isNaN(hour) ? 16 : hour;
}

// Draw everything for the routes on screen from what is known right now.
function tvRenderAssessment(refit){
  const corr = tvCurrentCorridor;
  if (!corr) return;
  const departHour = tvDepartHour();
  const risks = tvRoutes.map(route => tvRouteRisk(route, departHour));
  const labels = tvRouteLabels(risks.map(r => r.score));
  const mine = tvRoutes.indexOf(corr);
  const risk = risks[mine];
  const live = tvLiveData(corr);

  const notes = [];
  if (corr.stretches.length) notes.push(tvPlural(corr.stretches.length, 'high-risk stretch').replace('stretchs', 'stretches'));
  if (live && live.counts.onRoute) notes.push(`${tvPlural(live.counts.onRoute, 'report')} on this road`);
  document.getElementById('tvStretchNote').innerHTML = notes.length ? `<i class="ti ti-alert-triangle"></i> ${notes.join(' · ')}` : '';

  renderTravelOptions(risks, labels);
  renderTravelRoute(corr, refit);
  renderTravelRating(corr, risk, tvRoutes.length > 1 ? labels[mine] : '');
  renderTravelDirections();
  const curve = renderTravelHourChart(corr, departHour);
  const dep = renderTravelDepart(corr, risk, curve);
  renderTravelRecs(corr, departHour, dep, risks, labels);
  renderTravelNews();
}

function tvShowMessage(html){
  tvCurrentCorridor = null;
  tvRoutes = [];
  if (travelMapGroup) travelMapGroup.clearLayers();
  document.getElementById('tvStretchNote').textContent = '';
  document.getElementById('tvOptionsLabel').textContent = 'Route';
  document.getElementById('tvRouteOptions').innerHTML = '';
  const card = document.getElementById('tvRatingCard');
  card.className = 'panel-card tv-rating-card';
  card.innerHTML = `<div class="tv-empty">${html}</div>`;
  document.getElementById('tvRecs').innerHTML = '<div class="tv-empty">Pick a route to see recommendations.</div>';
  renderTravelDirections();
  renderTravelNews();
}

function assessRoute(){
  const from = document.getElementById('tvFrom').value;
  const to   = document.getElementById('tvTo').value;
  const titleEl = document.getElementById('tvRouteTitle');

  tvFillParks();
  if (from === to){
    titleEl.textContent = 'select a route';
    tvShowMessage('Origin and destination are the same — pick two different towns.');
    return;
  }
  const routes = tvPlanRoutes(from, to);
  if (!routes.length){
    titleEl.textContent = `${from} → ${to}`;
    tvShowMessage(`No mapped road links <strong>${escapeHtml(from)}</strong> and <strong>${escapeHtml(to)}</strong> yet.`);
    return;
  }
  // Same trip as before (a refresh, or only the time changed): keep the
  // traveller on the option they were looking at.
  const sameTrip = tvRoutes.length && tvRoutes[0].from === from && tvRoutes[0].to === to;
  const keepKey = sameTrip && tvCurrentCorridor ? tvCurrentCorridor.key : null;
  // By bus each route starts and ends at the chosen parks. A road already
  // fetched for the same towns and parks is used straight away.
  routes.forEach(route => {
    tvApplyParks(route);
    const road = tvRoadEntry(route).data;
    if (road) tvApplyRoad(route, road);
  });
  tvRoutes = routes;
  tvSelectedRoute = Math.max(0, routes.findIndex(route => route.key === keepKey));
  tvCurrentCorridor = routes[tvSelectedRoute];
  titleEl.textContent = `${from} → ${to}`;
  tvRenderAssessment(true);
  // The road first: it settles which states the route is really in, and the
  // news is searched by state.
  routes.forEach(route => tvLoadRoad(route, false).finally(() => tvLoadNews(route, false)));
}

// The destination menu offers everywhere except where you are starting.
function tvFillDestinations(){
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  const options = tvTowns().filter(town => town !== fromSel.value);
  const keep = options.includes(toSel.value) ? toSel.value : options[0];
  toSel.innerHTML = options.map(t => `<option value="${t}">${t}</option>`).join('');
  toSel.value = keep;
}

function swapTravelEnds(){
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  const from = fromSel.value, to = toSel.value;
  fromSel.value = to;
  tvFillDestinations();
  toSel.value = from;
  assessRoute();
}

function initTravelView(){
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  fromSel.innerHTML = tvTowns().map(t => `<option value="${t}">${t}</option>`).join('');
  fromSel.value = 'Kaduna';
  tvFillDestinations();
  toSel.value = 'Abuja (FCT)';
  fromSel.addEventListener('change', () => { tvFillDestinations(); assessRoute(); });
  toSel.addEventListener('change', assessRoute);
  document.getElementById('tvTime').addEventListener('change', () => { if (tvCurrentCorridor) tvRenderAssessment(); });
  const d = document.getElementById('tvDate'); if (d && !d.value) d.value = new Date().toISOString().slice(0,10);

  travelMap = L.map('travelMap', { center:[9.6,7.5], zoom:7, zoomControl:true, attributionControl:true, maxZoom:18 });
  let remembered = 'canvas';
  try { remembered = localStorage.getItem('tv-basemap') || 'canvas'; } catch (error) { /* storage blocked */ }
  setTravelBasemap(TV_BASEMAPS[remembered] ? remembered : 'canvas');
  // A click anywhere else, or Escape, closes the map-layer menu.
  document.addEventListener('click', event => { if (!event.target.closest('#tvBasemaps')) toggleTravelBasemaps(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') toggleTravelBasemaps(false); });
  travelMapGroup = L.layerGroup().addTo(travelMap);

  // Keep the reports current for as long as the tab stays open on a route.
  tvNewsTimer = setInterval(() => {
    const visible = document.getElementById('travelView').classList.contains('tv-active');
    if (visible && tvRoutes.length) refreshTravelNews();
  }, TV_NEWS_REFRESH_MS);

  // State boundaries tell a road which states it runs through.
  // The bus parks are needed before the first route is drawn.
  const parks = fetch('bus_parks.json').then(response => response.json()).then(data => { tvParks = data.towns || {}; });
  Promise.allSettled([hsLoadGeo(), parks]).then(() => setTimeout(() => { travelMap.invalidateSize(); assessRoute(); }, 120));
}
