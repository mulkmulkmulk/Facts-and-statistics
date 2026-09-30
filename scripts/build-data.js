// Builds the static site: data for the public GitHub Pages version.
//
//   node scripts/build-data.js bootstrap   state/ from the local collector DB + ewgf cache (one-time seed)
//   node scripts/build-data.js update      add new ewgf stats and Wavu matches to state/
//   node scripts/build-data.js site        write dist/ = public/ + data/*.json from state/
//
// state/ is the running state between daily runs (kept as a GitHub release asset, not in git history):
//   meta.json          cursor (last Wavu window), match count, first-seen time per character id and patch
//   page.json          last ewgf page we could read: versions, latest-patch stats, character id map
//   stats-<v>.json.gz  ewgf stats per patch
//   mu-<v>.json.gz     matchup totals per patch: rows [region, rank, ch, opp, games, wins]
//
// ewgf blocks some hosts (GitHub's runners included), so it's optional: character stats for season patches
// we've watched from day one are computed from the Wavu matches, and ewgf copies cover older patches.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const { fetchPage, fetchVersion } = require('../lib/ewgf');
const { charNames, REGION_IDS } = require('../lib/characters');
const wank = require('../lib/wank');

const ROOT = path.join(__dirname, '..');
const STATE = process.env.STATE_DIR || path.join(ROOT, 'state');
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist');
// A normal day is ~123 windows; the cap keeps a catch-up run inside a reasonable job time.
const MAX_WINDOWS = Number(process.env.MAX_WINDOWS || 700);

const readJson = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const readGz = (f, fallback = null) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
const writeGz = (f, v) => fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(v)));
const muFile = (v) => path.join(STATE, `mu-${v}.json.gz`);
const statsFile = (v) => path.join(STATE, `stats-${v}.json.gz`);

// ---- bootstrap -----------------------------------------------------------

function bootstrap() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'matchups.db'), { readOnly: true });
  fs.mkdirSync(STATE, { recursive: true });
  for (const { version } of db.prepare('SELECT DISTINCT version FROM mu').all()) {
    const rows = db.prepare('SELECT region, rank, ch, opp, games, wins FROM mu WHERE version = ?').all(version)
      .map((r) => [r.region, r.rank, r.ch, r.opp, r.games, r.wins]);
    writeGz(muFile(version), rows);
    console.log(`mu ${version}: ${rows.length} rows`);
  }
  const w = db.prepare('SELECT MIN(t) lo, MAX(t) hi, SUM(kept) kept FROM windows').get();
  const pcFrom = db.prepare('SELECT MIN(t) t FROM pc_windows').get();
  const firstSeen = {};
  if (pcFrom && pcFrom.t) for (const r of db.prepare('SELECT ch, MIN(first_at) at FROM pc GROUP BY ch').all()) firstSeen[r.ch] = r.at * 1000;
  // When each patch first shows up (start of the first window that contains it).
  const versionFirst = {};
  for (const { version } of db.prepare('SELECT DISTINCT version FROM mu').all()) {
    versionFirst[version] = (db.prepare('SELECT MIN(t) t FROM windows WHERE max_version >= ?').get(version).t - wank.WINDOW) * 1000;
  }
  writeJson(path.join(STATE, 'meta.json'), {
    cursorT: w.hi, from: (w.lo - wank.WINDOW) * 1000, matches: w.kept, versionFirst,
    firstSeen, observedFrom: pcFrom && pcFrom.t ? (pcFrom.t - wank.WINDOW) * 1000 : (w.lo - wank.WINDOW) * 1000,
  });
  // ewgf stats already cached by server.js
  const cache = path.join(ROOT, 'cache');
  const page = readJson(path.join(cache, 'latest.json'));
  if (page) { writeJson(path.join(STATE, 'page.json'), page); writeGz(statsFile(page.latest.gameVersion), page.latest); }
  for (const f of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const m = f.match(/^stats-(\d+)\.json$/);
    if (m && !fs.existsSync(statsFile(m[1]))) writeGz(statsFile(m[1]), readJson(path.join(cache, f)));
  }
  console.log(`bootstrapped state/ up to ${new Date(w.hi * 1000).toISOString()}, ${w.kept} matches`);
}

// ---- update --------------------------------------------------------------

async function update() {
  fs.mkdirSync(STATE, { recursive: true });
  const meta = readJson(path.join(STATE, 'meta.json'), { cursorT: null, from: null, matches: 0, firstSeen: {}, observedFrom: null });

  meta.versionFirst = meta.versionFirst || {};

  // ewgf: latest page every run; older patches once (they never change). ewgf's Cloudflare blocks some
  // hosts (GitHub's runners included), so this is best-effort: the season's stats can be computed from
  // the Wavu matches instead (see seasonStats), and older patches are already saved.
  try {
    const page = await fetchPage();
    // The latest patch is kept as its own stats file too, so it survives once it's no longer latest.
    writeGz(statsFile(page.latest.gameVersion), page.latest);
    writeJson(path.join(STATE, 'page.json'), page);
    for (const v of page.versions) {
      if (fs.existsSync(statsFile(v))) continue;
      try { writeGz(statsFile(v), await fetchVersion(v, page)); console.log(`ewgf patch ${v} fetched`); }
      catch (e) { console.warn(`ewgf patch ${v}: ${e.message}`); }
      await wank.sleep(1000);
    }
  } catch (e) {
    console.warn(`ewgf unavailable (${e.message}); continuing with Wavu data and saved ewgf stats`);
  }

  // Wavu: new windows since the cursor, folded into per-patch matchup totals.
  const mu = new Map(); // version -> Map("region,rank,ch,opp" -> [g, w])
  const table = (v) => {
    if (!mu.has(v)) mu.set(v, new Map((readGz(muFile(v), [])).map(([r, k, c, o, g, w]) => [`${r},${k},${c},${o}`, [g, w]])));
    return mu.get(v);
  };
  let t = meta.cursorT ? meta.cursorT + wank.WINDOW : wank.readyT();
  if (!meta.from) meta.from = (t - wank.WINDOW) * 1000;
  if (!meta.observedFrom) meta.observedFrom = meta.from;
  let n = 0;
  for (; t <= wank.readyT() && n < MAX_WINDOWS; t += wank.WINDOW, n++) {
    for (const b of await wank.fetchWindow(t)) {
      if (!wank.isSeasonRanked(b)) continue;
      meta.matches++;
      const vf = meta.versionFirst[b.game_version];
      if (!vf || b.battle_at * 1000 < vf) meta.versionFirst[b.game_version] = b.battle_at * 1000;
      const tab = table(b.game_version);
      for (const [me, op, side] of [['p1', 'p2', 1], ['p2', 'p1', 2]]) {
        const ch = b[me + '_chara_id'];
        const key = `${b[me + '_region_id'] ?? -1},${wank.normRank(b[me + '_rank'])},${ch},${b[op + '_chara_id']}`;
        const a = tab.get(key) || [0, 0];
        a[0]++;
        a[1] += b.winner === side ? 1 : 0;
        tab.set(key, a);
        const at = b.battle_at * 1000;
        if (!meta.firstSeen[ch] || at < meta.firstSeen[ch]) meta.firstSeen[ch] = at;
      }
    }
    meta.cursorT = t;
    if (n % 50 === 0) console.log(`wavu ${new Date(t * 1000).toISOString()}`);
    await wank.sleep(wank.REQUEST_GAP_MS);
  }
  for (const [v, tab] of mu) writeGz(muFile(v), [...tab].map(([k, [g, w]]) => [...k.split(',').map(Number), g, w]));
  writeJson(path.join(STATE, 'meta.json'), meta);
  console.log(`update: ${n} windows, now at ${new Date(meta.cursorT * 1000).toISOString()}, ${meta.matches} matches total`);
}

// ---- site ----------------------------------------------------------------

// Per-rank character stats in ewgf's shape (stats[region][rank][character] = {games, wins}), computed from
// our own Wavu matchup totals. Same Bandai replay data as ewgf: tier orders agree ~0.998 with ewgf's numbers.
function seasonStats(version, rows, names) {
  const RANKS = vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'ranks.js'), 'utf8') + ';RANKS');
  const regionName = Object.fromEntries(Object.entries(REGION_IDS).map(([n, id]) => [id, n]));
  const stats = {};
  for (const [reg, rank, ch, , g, w] of rows) {
    const R = regionName[reg], K = RANKS[rank], C = names[ch];
    if (!R || !K || !C) continue;
    const e = (((stats[R] = stats[R] || {})[K] = stats[R][K] || {})[C] = stats[R][K][C] || { games: 0, wins: 0 });
    e.games += g;
    e.wins += w;
  }
  return { gameVersion: version, stats };
}

function site() {
  const page = readJson(path.join(STATE, 'page.json'), {});
  const meta = readJson(path.join(STATE, 'meta.json'));
  if (!meta) throw new Error('state/ is empty: run bootstrap or update first');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'config.js'), "// Built static site: data comes from data/*.json.\nwindow.SITE_MODE = 'static';\n");
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  const data = path.join(DIST, 'data');
  fs.mkdirSync(data);

  // matchups
  const muVersions = fs.readdirSync(STATE).map((f) => f.match(/^mu-(\d+)\.json\.gz$/)).filter(Boolean).map((m) => +m[1]).sort((a, b) => b - a);
  const muRows = new Map(muVersions.map((v) => [v, readGz(muFile(v), [])]));
  const seenIds = new Set();
  for (const [v, rows] of muRows) {
    for (const r of rows) { seenIds.add(r[2]); seenIds.add(r[3]); }
    writeJson(path.join(data, `mu-${v}.json`), rows);
  }
  writeJson(path.join(data, 'collector.json'), {
    available: muVersions.length > 0, from: meta.from, to: meta.cursorT * 1000, matches: meta.matches, versions: muVersions,
  });
  const names = charNames(page.charIds, [...seenIds]);

  // Character stats per patch: computed from Wavu for patches we've watched from their first day,
  // otherwise the saved ewgf copy (older patches never change).
  const stats = new Map();
  for (const f of fs.readdirSync(STATE)) {
    const m = f.match(/^stats-(\d+)\.json\.gz$/);
    if (m) stats.set(+m[1], { data: readGz(path.join(STATE, f)), source: 'ewgf.gg', fetchedAt: page.fetchedAt || null });
  }
  const watchedFromStart = (v) => meta.versionFirst && meta.versionFirst[v] > meta.from + 86400e3;
  for (const [v, rows] of muRows) {
    if (watchedFromStart(v)) stats.set(v, { data: seasonStats(v, rows, names), source: 'Wavu Wank', fetchedAt: meta.cursorT * 1000 });
  }
  const versions = [...stats.keys()].sort((a, b) => b - a);
  for (const [v, s] of stats) writeJson(path.join(data, `stats-${v}.json`), { ...s.data, fetchedAt: s.fetchedAt, source: s.source });
  const latest = stats.get(versions[0]);
  writeJson(path.join(data, 'versions.json'), { versions, latest: versions[0], fetchedAt: latest.fetchedAt, source: latest.source });
  writeJson(path.join(data, 'characters.json'), {
    names,
    firstSeen: Object.fromEntries(Object.entries(meta.firstSeen).map(([id, at]) => [names[id] || `Character ${id}`, at])),
    observedFrom: meta.observedFrom,
  });

  const iconDir = path.join(DIST, 'icons');
  const icons = fs.existsSync(iconDir) ? fs.readdirSync(iconDir).filter((f) => /\.(png|webp|jpe?g|svg)$/i.test(f)) : [];
  writeJson(path.join(data, 'icons.json'), Object.fromEntries(icons.map((f) => [f.replace(/\.[^.]+$/, ''), 'icons/' + f])));

  const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  const fromWavu = versions.filter((v) => stats.get(v).source === 'Wavu Wank');
  console.log(`site: dist/ written (${(size(DIST) / 1e6).toFixed(1)} MB), ${versions.length} patches (${fromWavu.join(', ') || 'none'} from Wavu), matchups for ${muVersions.join(', ')}`);
}

const cmd = process.argv[2];
const run = { bootstrap, update, site }[cmd];
if (!run) { console.error('usage: node scripts/build-data.js bootstrap|update|site'); process.exit(1); }
Promise.resolve(run()).catch((e) => { console.error(e); process.exit(1); });
