// Do per-(region, rank, character) totals from our Wavu data match ewgf's statistics for the same patch?
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js', 'metasignals.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const RANKS = vm.runInContext('RANKS', ctx);
const { charNames } = require(ROOT + '/lib/characters');
const REGION_NAMES = { '-1': 'Region Not Set', 0: 'Asia', 1: 'Middle East', 2: 'Oceania', 3: 'Americas', 4: 'Europe' };

const page = JSON.parse(fs.readFileSync(ROOT + '/state/page.json', 'utf8'));
const V = +(process.argv[2] || 30202);
const ewgf = V === page.latest.gameVersion ? page.latest.stats : JSON.parse(zlib.gunzipSync(fs.readFileSync(`${ROOT}/state/stats-${V}.json.gz`))).stats;
const names = charNames(page.charIds);
// Wavu → same shape as ewgf: stats[region][rank][char] = {games, wins}
const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${ROOT}/state/mu-${V}.json.gz`)));
const ours = {};
for (const [reg, rank, ch, , g, w] of rows) {
  const R = REGION_NAMES[reg], K = RANKS[rank], C = names[ch];
  if (!R || !K || !C) continue;
  const e = ((ours[R] = ours[R] || {})[K] = ours[R][K] || {})[C] = ours[R][K][C] || { games: 0, wins: 0 };
  e.games += g; e.wins += w;
}
let ge = 0, go = 0; const pairs = [];
for (const R of Object.keys(ewgf)) for (const K of Object.keys(ewgf[R])) for (const [C, s] of Object.entries(ewgf[R][K])) {
  const o = ours[R]?.[K]?.[C];
  ge += s.games; if (o) go += o.games;
  if (o && s.games >= 2000 && o.games >= 2000) pairs.push([s.wins / s.games, o.wins / o.games, s.games, o.games]);
}
const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n; let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };
console.log(`patch ${V}: ewgf ${ge.toLocaleString()} appearances, ours ${go.toLocaleString()} (${(go / ge * 100).toFixed(1)}%)`);
console.log(`cells with 2000+ games both: ${pairs.length}; win-rate correlation ${corr(pairs.map((p) => p[0]), pairs.map((p) => p[1])).toFixed(4)}; games correlation ${corr(pairs.map((p) => p[2]), pairs.map((p) => p[3])).toFixed(4)}`);
const diffs = pairs.map((p) => Math.abs(p[0] - p[1]) * 100).sort((a, b) => a - b);
console.log(`|win-rate difference| median ${diffs[diffs.length >> 1].toFixed(2)} pts, 95th pct ${diffs[Math.floor(diffs.length * 0.95)].toFixed(2)} pts`);
// Same tier-list pipeline on both sources
const W = { winTop: 1, pickTop: 1, lift: 0.75 };
const a = ctx.metaScore(ctx.metaSignals(ewgf, Object.keys(ewgf), 29), W), b = ctx.metaScore(ctx.metaSignals(ours, Object.keys(ours), 29), W);
console.log(`Meta signals rank agreement ewgf vs ours: ${ctx.spearmanByName(a, b).toFixed(3)}`);
const agg = (st) => { const { rows: r } = ctx.aggregate(st, Object.keys(st), 33, 37); ctx.useRaw(r); ctx.scoreRows(r, { method: 'composite', winBase: 'wilson', norm: 'rank', z: 1.96, prior: 0, wA: .5, wB: .3, wC: .2 }); return r; };
console.log(`Explorer composite GoD IV+ rank agreement: ${ctx.spearmanByName(agg(ewgf), agg(ours)).toFixed(3)}`);
