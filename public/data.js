// Data layer. Two modes, same answers:
//   server – local development: /api/* is answered live by server.js
//   static – the public site: scripts/build-data.js wrote data/*.json, read here
// config.js sets window.SITE_MODE ('static' only in the built site).

const STATIC = window.SITE_MODE === 'static';
const REGION_IDS = { 'Region Not Set': -1, Asia: 0, 'Middle East': 1, Oceania: 2, Americas: 3, Europe: 4 };

const jsonCache = new Map();
function getJson(url) {
  if (!jsonCache.has(url)) {
    jsonCache.set(url, fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { jsonCache.delete(url); throw e; }));
  }
  return jsonCache.get(url);
}

async function api(path) {
  if (!STATIC) {
    const r = await fetch(path);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');
  switch (p) {
    case '/api/versions': return getJson('data/versions.json');
    case '/api/stats': {
      const { latest } = await getJson('data/versions.json');
      return getJson(`data/stats-${q.get('v') || latest}.json`);
    }
    case '/api/collector': return getJson('data/collector.json');
    case '/api/characters': return getJson('data/characters.json');
    case '/api/icons': return getJson('data/icons.json');
    case '/api/matchups': return staticMatchups(q);
    default: throw new Error(`${p} isn't available on the static site`);
  }
}

// Same result as server.js matchups(): sum the per-patch rows [region, rank, ch, opp, games, wins]
// over the requested ranks, regions and patch(es), then name the characters.
async function staticMatchups(q) {
  const [meta, chars] = await Promise.all([getJson('data/collector.json'), getJson('data/characters.json')]);
  if (!meta.available) return { available: false };
  const version = q.get('version');
  const versions = version && version !== 'season' ? meta.versions.filter((v) => v === +version) : meta.versions;
  const regions = new Set((q.get('regions') || Object.keys(REGION_IDS).join('|')).split('|').map((r) => REGION_IDS[r]).filter((r) => r !== undefined));
  const lo = +(q.get('rankLo') ?? 0), hi = +(q.get('rankHi') ?? 37);
  const agg = new Map();
  for (const rows of await Promise.all(versions.map((v) => getJson(`data/mu-${v}.json`)))) {
    for (const [reg, rank, ch, opp, g, w] of rows) {
      if (rank < lo || rank > hi || !regions.has(reg)) continue;
      const k = ch * 1000 + opp;
      const a = agg.get(k);
      if (a) { a[0] += g; a[1] += w; } else agg.set(k, [g, w]);
    }
  }
  const name = (id) => chars.names[id] || `Character ${id}`;
  const cells = [...agg].map(([k, [g, w]]) => [name(Math.floor(k / 1000)), name(k % 1000), g, w, 0]);
  return { available: true, cells, versions: meta.versions, coverage: { from: meta.from, to: meta.to, matches: meta.matches } };
}
