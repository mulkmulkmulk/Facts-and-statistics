// Local development server: serves public/ and answers /api/* live from ewgf.gg and the collector's
// database. The public site is static instead (scripts/build-data.js writes the same answers as JSON,
// and public/data.js reads them), so both run the same front end.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchPage, fetchVersion } = require('./lib/ewgf');
const { REGION_IDS, charNames } = require('./lib/characters');

const PORT = process.env.PORT || 5180;
const LATEST_TTL = 24 * 60 * 60 * 1000; // ewgf is fetched once a day (or on Refresh)
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGE_FILE = path.join(CACHE_DIR, 'latest.json');
const MATCHUP_DB = path.join(__dirname, 'data', 'matchups.db');

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Last daily snapshot survives restarts, so a restart doesn't cost an ewgf request.
let page = (() => { try { return JSON.parse(fs.readFileSync(PAGE_FILE, 'utf8')); } catch { return null; } })();
const versionCache = new Map(); // version -> { fetchedAt, data }

async function loadPage(force = false) {
  if (!force && page && Date.now() - page.fetchedAt < LATEST_TTL) return page;
  page = await fetchPage();
  fs.writeFile(PAGE_FILE, JSON.stringify(page), () => {});
  return page;
}

function cacheFile(v) { return path.join(CACHE_DIR, `stats-${v}.json`); }
function readCache(v) { try { return JSON.parse(fs.readFileSync(cacheFile(v), 'utf8')); } catch { return null; } }

async function getVersion(version) {
  const p = await loadPage();
  if (!version || version === p.latest.gameVersion) return p.latest;
  const hit = versionCache.get(version);
  if (hit) return hit.data;
  // Older patches don't change, so a disk cache is safe to keep forever.
  let data = readCache(version);
  if (!data) {
    data = await fetchVersion(version, p);
    fs.writeFile(cacheFile(version), JSON.stringify(data), () => {});
  }
  versionCache.set(version, { fetchedAt: Date.now(), data });
  return data;
}

// --- matchups (from collector.js's database) -----------------------------

let mdb = null;
function matchupDb() {
  if (mdb) return mdb;
  if (!fs.existsSync(MATCHUP_DB)) return null;
  const { DatabaseSync } = require('node:sqlite');
  mdb = new DatabaseSync(MATCHUP_DB, { readOnly: true });
  return mdb;
}

function names() { return charNames(page && page.charIds); }

function matchups(q) {
  const db = matchupDb();
  if (!db) return { available: false };
  const rankLo = Number(q.get('rankLo') ?? 0), rankHi = Number(q.get('rankHi') ?? 37);
  const regions = (q.get('regions') || Object.keys(REGION_IDS).join('|')).split('|')
    .map((r) => REGION_IDS[r]).filter((r) => r !== undefined);
  const version = q.get('version');
  const where = [`rank BETWEEN ? AND ?`, `region IN (${regions.map(() => '?').join(',') || 'NULL'})`];
  const args = [rankLo, rankHi, ...regions];
  if (version && version !== 'season') { where.push('version = ?'); args.push(Number(version)); }
  const rows = db.prepare(`SELECT ch, opp, SUM(games) g, SUM(wins) w FROM mu
    WHERE ${where.join(' AND ')} GROUP BY ch, opp`).all(...args);
  const nm = charNames(page && page.charIds, rows.flatMap((c) => [c.ch, c.opp]));
  const cells = rows.map((c) => [nm[c.ch], nm[c.opp], c.g, c.w, 0]);
  return { available: true, cells, ...coverage(db) };
}

function coverage(db) {
  const c = db.prepare('SELECT MIN(t) - 700 lo, MAX(t) hi, SUM(kept) kept FROM windows').get();
  const versions = db.prepare('SELECT DISTINCT version FROM mu ORDER BY version DESC').all().map((r) => r.version);
  return { versions, coverage: { from: c.lo * 1000, to: c.hi * 1000, matches: c.kept } };
}

// First time each character shows up in the per-player data, for automatic "new character" badges.
// Only meaningful if it's clearly after we started watching (observedFrom). Cached: it's a full scan.
let charCache = null;
function characters() {
  if (charCache && Date.now() - charCache.at < 3600e3) return charCache.data;
  const db = matchupDb();
  const firstSeen = {};
  let observedFrom = null;
  if (db) {
    const nm = names();
    for (const r of db.prepare('SELECT ch, MIN(first_at) at FROM pc GROUP BY ch').all()) firstSeen[nm[r.ch] || `Character ${r.ch}`] = r.at * 1000;
    const o = db.prepare('SELECT MIN(t) t FROM pc_windows').get();
    observedFrom = o && o.t ? (o.t - 700) * 1000 : null;
  }
  const data = { names: names(), firstSeen, observedFrom };
  charCache = { at: Date.now(), data };
  return data;
}

// --- HTTP ----------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function iconList() {
  const dir = path.join(PUBLIC_DIR, 'icons');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return Object.fromEntries(files.filter((f) => /\.(png|webp|jpe?g|svg)$/i.test(f)).map((f) => [f.replace(/\.[^.]+$/, ''), 'icons/' + f]));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/versions') {
      const p = await loadPage();
      return sendJson(res, 200, { versions: p.versions, latest: p.latest.gameVersion, fetchedAt: p.fetchedAt });
    }
    if (url.pathname === '/api/stats') {
      const v = Number(url.searchParams.get('v')) || null;
      const data = await getVersion(v);
      const fetchedAt = data.gameVersion === page.latest.gameVersion ? page.fetchedAt : (versionCache.get(data.gameVersion) || {}).fetchedAt;
      return sendJson(res, 200, { ...data, fetchedAt });
    }
    if (url.pathname === '/api/matchups') return sendJson(res, 200, matchups(url.searchParams));
    if (url.pathname === '/api/collector') {
      const db = matchupDb();
      if (!db) return sendJson(res, 200, { available: false });
      const { coverage: c, versions } = coverage(db);
      return sendJson(res, 200, { available: true, ...c, versions });
    }
    if (url.pathname === '/api/characters') return sendJson(res, 200, characters());
    if (url.pathname === '/api/icons') return sendJson(res, 200, iconList());
    if (url.pathname === '/api/refresh') {
      const p = await loadPage(true);
      return sendJson(res, 200, { latest: p.latest.gameVersion, fetchedAt: p.fetchedAt });
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    sendJson(res, 502, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`ewgf-tierlist on http://localhost:${PORT}`));
