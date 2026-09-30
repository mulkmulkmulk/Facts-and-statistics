// Builds the static site: data for the public GitHub Pages version.
//
//   node scripts/build-data.js bootstrap   state/ from the local collector DB + ewgf cache (one-time seed)
//   node scripts/build-data.js update      add new ewgf stats and Wavu matches to state/
//   node scripts/build-data.js site        write dist/ = public/ + data/*.json from state/
//
// state/ is the running state between daily runs (kept as a GitHub release asset, not in git history):
//   meta.json          cursor (last Wavu window), match count, first-seen time per character id
//   page.json          latest ewgf page: versions, latest-patch stats, character id map
//   stats-<v>.json.gz  older patches' ewgf stats (they never change)
//   mu-<v>.json.gz     matchup totals per patch: rows [region, rank, ch, opp, games, wins]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fetchPage, fetchVersion } = require('../lib/ewgf');
const { charNames } = require('../lib/characters');
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
  writeJson(path.join(STATE, 'meta.json'), {
    cursorT: w.hi, from: (w.lo - wank.WINDOW) * 1000, matches: w.kept,
    firstSeen, observedFrom: pcFrom && pcFrom.t ? (pcFrom.t - wank.WINDOW) * 1000 : (w.lo - wank.WINDOW) * 1000,
  });
  // ewgf stats already cached by server.js
  const cache = path.join(ROOT, 'cache');
  const page = readJson(path.join(cache, 'latest.json'));
  if (page) writeJson(path.join(STATE, 'page.json'), page);
  for (const f of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const m = f.match(/^stats-(\d+)\.json$/);
    if (m && (!page || +m[1] !== page.latest.gameVersion)) writeGz(statsFile(m[1]), readJson(path.join(cache, f)));
  }
  console.log(`bootstrapped state/ up to ${new Date(w.hi * 1000).toISOString()}, ${w.kept} matches`);
}

// ---- update --------------------------------------------------------------

async function update() {
  fs.mkdirSync(STATE, { recursive: true });
  const meta = readJson(path.join(STATE, 'meta.json'), { cursorT: null, from: null, matches: 0, firstSeen: {}, observedFrom: null });

  // ewgf: latest page every run; older patches once (they never change).
  const page = await fetchPage();
  writeJson(path.join(STATE, 'page.json'), page);
  for (const v of page.versions) {
    if (v === page.latest.gameVersion || fs.existsSync(statsFile(v))) continue;
    try { writeGz(statsFile(v), await fetchVersion(v, page)); console.log(`ewgf patch ${v} fetched`); }
    catch (e) { console.warn(`ewgf patch ${v}: ${e.message}`); }
    await wank.sleep(1000);
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

function site() {
  const page = readJson(path.join(STATE, 'page.json'));
  const meta = readJson(path.join(STATE, 'meta.json'));
  if (!page || !meta) throw new Error('state/ is empty: run bootstrap or update first');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'config.js'), "// Built static site: data comes from data/*.json.\nwindow.SITE_MODE = 'static';\n");
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  const data = path.join(DIST, 'data');
  fs.mkdirSync(data);

  // ewgf stats: latest + every older patch we have
  const latest = page.latest.gameVersion;
  writeJson(path.join(data, `stats-${latest}.json`), { ...page.latest, fetchedAt: page.fetchedAt });
  const versions = page.versions.filter((v) => v === latest || fs.existsSync(statsFile(v)));
  for (const v of versions) if (v !== latest) writeJson(path.join(data, `stats-${v}.json`), { ...readGz(statsFile(v)), fetchedAt: page.fetchedAt });
  writeJson(path.join(data, 'versions.json'), { versions, latest, fetchedAt: page.fetchedAt });

  // matchups
  const muVersions = fs.readdirSync(STATE).map((f) => f.match(/^mu-(\d+)\.json\.gz$/)).filter(Boolean).map((m) => +m[1]).sort((a, b) => b - a);
  const seenIds = new Set();
  for (const v of muVersions) {
    const rows = readGz(muFile(v), []);
    for (const r of rows) { seenIds.add(r[2]); seenIds.add(r[3]); }
    writeJson(path.join(data, `mu-${v}.json`), rows);
  }
  writeJson(path.join(data, 'collector.json'), {
    available: muVersions.length > 0, from: meta.from, to: meta.cursorT * 1000, matches: meta.matches, versions: muVersions,
  });
  const names = charNames(page.charIds, [...seenIds]);
  writeJson(path.join(data, 'characters.json'), {
    names,
    firstSeen: Object.fromEntries(Object.entries(meta.firstSeen).map(([id, at]) => [names[id] || `Character ${id}`, at])),
    observedFrom: meta.observedFrom,
  });

  const iconDir = path.join(DIST, 'icons');
  const icons = fs.existsSync(iconDir) ? fs.readdirSync(iconDir).filter((f) => /\.(png|webp|jpe?g|svg)$/i.test(f)) : [];
  writeJson(path.join(data, 'icons.json'), Object.fromEntries(icons.map((f) => [f.replace(/\.[^.]+$/, ''), 'icons/' + f])));

  const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  console.log(`site: dist/ written (${(size(DIST) / 1e6).toFixed(1)} MB), ${versions.length} ewgf patches, matchups for ${muVersions.join(', ')}`);
}

const cmd = process.argv[2];
const run = { bootstrap, update, site }[cmd];
if (!run) { console.error('usage: node scripts/build-data.js bootstrap|update|site'); process.exit(1); }
Promise.resolve(run()).catch((e) => { console.error(e); process.exit(1); });
