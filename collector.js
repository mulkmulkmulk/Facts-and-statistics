// Collects every ranked Tekken 8 match of the current season from Wavu Wank's public
// replay feed (https://wank.wavu.wiki/api) and folds them into matchup counters.
//
// Feed: GET /api/replays?before=T → all ranked replays with battle_at in (T-700, T].
// Wavu's own guidance: one request in flight at a time, ~1 req/s, step `before` by 700.
//
// We keep only aggregates, not raw replays (~700k matches/day would be tens of GB a season):
//   mu(version, region, rank, ch, opp) → games, wins, exp
// one row per *player perspective*, so every match adds two rows (a mirror adds two to the same row).
// `exp` = sum of rating-expected wins (Elo formula on rating_before), so wins − exp measures
// how a character does against opponents *of its rating*, not just its rank.
// Also pc(version, player, ch): per-player totals by rank band, a few hundred MB for a season.
//
//   node collector.js           run forever: stay current, backfill to season start when idle
//   node collector.js --once    catch up / backfill until done, then exit

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FEED = 'https://wank.wavu.wiki/api/replays';
const WINDOW = 700;
const MIN_VERSION = Number(process.env.MIN_VERSION || 30000); // Season 3 = patch 3.00.00+
const LAG = 15 * 60; // leave the newest 15 min alone so windows are complete when fetched
const REQUEST_GAP_MS = 1000;
const ONCE = process.argv.includes('--once');

const db = new DatabaseSync(path.join(__dirname, 'data', 'matchups.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS windows (
    t INTEGER PRIMARY KEY, battles INTEGER, kept INTEGER,
    min_version INTEGER, max_version INTEGER, fetched_at INTEGER);
  CREATE TABLE IF NOT EXISTS mu (
    version INTEGER, region INTEGER, rank INTEGER, ch INTEGER, opp INTEGER,
    games INTEGER, wins INTEGER, exp REAL,
    PRIMARY KEY (version, region, rank, ch, opp)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

  -- Per player × character × patch. Games/wins split into rank bands (0 = below Garyu, 1 = Garyu–Bushin,
  -- 2 = Tekken King–TGS, 3 = GoD and up) plus first/last observation, for unique-player counts,
  -- player-level uncertainty, climb rate and switch-in analysis.
  CREATE TABLE IF NOT EXISTS pc (
    version INTEGER, player TEXT, ch INTEGER, region INTEGER,
    games INTEGER, wins INTEGER,
    g0 INTEGER, w0 INTEGER, g1 INTEGER, w1 INTEGER, g2 INTEGER, w2 INTEGER, g3 INTEGER, w3 INTEGER,
    first_at INTEGER, last_at INTEGER, rank_first INTEGER, rank_last INTEGER, rating_first REAL, rating_last REAL,
    PRIMARY KEY (version, player, ch)) WITHOUT ROWID;
  -- Windows already folded into pc (older windows were collected before pc existed and get re-fetched).
  CREATE TABLE IF NOT EXISTS pc_windows (t INTEGER PRIMARY KEY);
`);

const upsertPc = db.prepare(`
  INSERT INTO pc VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET
    region = excluded.region,
    games = games + excluded.games, wins = wins + excluded.wins,
    g0 = g0 + excluded.g0, w0 = w0 + excluded.w0, g1 = g1 + excluded.g1, w1 = w1 + excluded.w1,
    g2 = g2 + excluded.g2, w2 = w2 + excluded.w2, g3 = g3 + excluded.g3, w3 = w3 + excluded.w3,
    rank_first = CASE WHEN excluded.first_at < first_at THEN excluded.rank_first ELSE rank_first END,
    rating_first = CASE WHEN excluded.first_at < first_at THEN excluded.rating_first ELSE rating_first END,
    first_at = MIN(first_at, excluded.first_at),
    rank_last = CASE WHEN excluded.last_at > last_at THEN excluded.rank_last ELSE rank_last END,
    rating_last = CASE WHEN excluded.last_at > last_at THEN excluded.rating_last ELSE rating_last END,
    last_at = MAX(last_at, excluded.last_at)`);
const addPcWindow = db.prepare('INSERT OR IGNORE INTO pc_windows VALUES (?)');
const nextPcGap = db.prepare('SELECT MAX(w.t) t FROM windows w LEFT JOIN pc_windows p ON p.t = w.t WHERE p.t IS NULL');

const rankBand = (r) => (r < 15 ? 0 : r < 25 ? 1 : r < 29 ? 2 : 3);

const upsert = db.prepare(`
  INSERT INTO mu (version, region, rank, ch, opp, games, wins, exp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET games = games + excluded.games, wins = wins + excluded.wins, exp = exp + excluded.exp`);
const addWindow = db.prepare('INSERT INTO windows VALUES (?, ?, ?, ?, ?, ?)');
const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');

// ewgf/Bandai use 100–107 and 765 as alternate ids for the GoD ranks.
function normRank(r) {
  if (r >= 100 && r <= 107) return r - 71;
  if (r === 765) return 37;
  return r;
}

// `mu` / `pc` choose which tables this window feeds (pc-only when re-fetching an old window).
function ingest(t, battles, { mu = true, pc = true } = {}) {
  const agg = new Map(), pagg = new Map();
  let kept = 0, minV = Infinity, maxV = -Infinity;
  for (const b of battles) {
    minV = Math.min(minV, b.game_version);
    maxV = Math.max(maxV, b.game_version);
    if (b.battle_type !== 2 || b.game_version < MIN_VERSION) continue; // 2 = ranked
    kept++;
    for (const [me, op, side] of [['p1', 'p2', 1], ['p2', 'p1', 2]]) {
      const rMe = b[me + '_rating_before'], rOp = b[op + '_rating_before'];
      const rank = normRank(b[me + '_rank']), win = b.winner === side ? 1 : 0;
      if (mu) {
        const exp = rMe != null && rOp != null ? 1 / (1 + 10 ** ((rOp - rMe) / 400)) : 0.5;
        const key = [b.game_version, b[me + '_region_id'] ?? -1, rank, b[me + '_chara_id'], b[op + '_chara_id']].join(',');
        const a = agg.get(key) || { games: 0, wins: 0, exp: 0 };
        a.games++;
        a.wins += win;
        a.exp += exp;
        agg.set(key, a);
      }
      if (pc && b[me + '_polaris_id']) {
        const key = `${b.game_version}|${b[me + '_polaris_id']}|${b[me + '_chara_id']}`;
        let p = pagg.get(key);
        if (!p) pagg.set(key, (p = { region: b[me + '_region_id'] ?? -1, games: 0, wins: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], first: null, last: null }));
        p.games++;
        p.wins += win;
        const bi = rankBand(rank) * 2;
        p.bands[bi]++;
        p.bands[bi + 1] += win;
        const obs = { at: b.battle_at, rank, rating: rMe != null ? rMe + (b[me + '_rating_change'] || 0) : null };
        if (!p.first || obs.at < p.first.at) p.first = obs;
        if (!p.last || obs.at > p.last.at) p.last = obs;
      }
    }
  }
  db.exec('BEGIN');
  try {
    if (mu) {
      for (const [key, a] of agg) upsert.run(...key.split(',').map(Number), a.games, a.wins, a.exp);
      addWindow.run(t, battles.length, kept, battles.length ? minV : null, battles.length ? maxV : null, Date.now());
    }
    if (pc) {
      for (const [key, p] of pagg) {
        const [version, player, ch] = key.split('|');
        upsertPc.run(+version, player, +ch, p.region, p.games, p.wins, ...p.bands,
          p.first.at, p.last.at, p.first.rank, p.last.rank, p.first.rating, p.last.rating);
      }
      addPcWindow.run(t);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { kept, maxV: battles.length ? maxV : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWindow(t) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${FEED}?before=${t}`, { headers: { 'User-Agent': 'ewgf-tierlist collector (personal use)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      const wait = Math.min(300, 15 * 2 ** attempt);
      console.warn(`window ${t}: ${e.message}, retrying in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

function fmt(t) { return new Date(t * 1000).toISOString().replace('.000Z', 'Z'); }

async function main() {
  const readyT = () => Math.floor((Date.now() / 1000 - LAG) / WINDOW) * WINDOW;
  let { lo, hi } = db.prepare('SELECT MIN(t) lo, MAX(t) hi FROM windows').get();
  let backfillDone = getMeta.get('backfill_done')?.v === '1';
  console.log(`collector: season from patch ${MIN_VERSION}, db has ${lo ? `${fmt(lo)} → ${fmt(hi)}` : 'nothing yet'}`);

  let n = 0;
  for (;;) {
    // Priority: new data > per-player catch-up on already-collected windows (newest first, so the
    // current patch fills in first) > backfill toward the season start (feeds both tables at once).
    let t, dir;
    const pcGap = hi != null ? nextPcGap.get().t : null;
    if (hi == null) { t = readyT(); dir = 'new'; }
    else if (hi + WINDOW <= readyT()) { t = hi + WINDOW; dir = 'fwd'; }
    else if (pcGap != null) { t = pcGap; dir = 'players'; }
    else if (!backfillDone) { t = lo - WINDOW; dir = 'back'; }
    else if (ONCE) break;
    else { await sleep(60 * 1000); continue; }

    const battles = await fetchWindow(t);
    if (dir === 'players') {
      ingest(t, battles, { mu: false, pc: true });
      if (++n % 20 === 0) console.log(`players ${fmt(t)}: ${battles.length} battles`);
      await sleep(REQUEST_GAP_MS);
      continue;
    }
    const { kept, maxV } = ingest(t, battles);
    if (dir !== 'back') hi = t;
    if (dir !== 'fwd') lo = t;
    // Past the season start once a whole (non-empty) window is older patches.
    if (dir === 'back' && maxV != null && maxV < MIN_VERSION) {
      backfillDone = true;
      setMeta.run('backfill_done', '1');
      console.log(`backfill reached pre-season data at ${fmt(t)} — done`);
    }
    if (++n % 20 === 0 || dir !== 'back') console.log(`${dir} ${fmt(t)}: ${battles.length} battles, ${kept} kept`);
    await sleep(REQUEST_GAP_MS);
  }
  console.log('caught up; exiting (--once)');
}

main().catch((e) => { console.error(e); process.exit(1); });
