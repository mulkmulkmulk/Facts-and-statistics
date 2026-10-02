// Where do Reina + Mishimas land per model / signal, and how popular are they at low vs top ranks?
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js', 'metasignals.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const { charNames } = require(ROOT + '/lib/characters');
const WHO = ['Reina', 'Kazuya', 'Jin', 'Heihachi', 'Devil Jin', 'Asuka', 'Eddy'];
const stats = JSON.parse(fs.readFileSync(ROOT + '/cache/latest.json', 'utf8')).latest.stats;
const ALL = Object.keys(stats);
const rankIn = (rows, key, name) => [...rows].sort((a, b) => b[key] - a[key]).findIndex((r) => r.name === name) + 1;

// popularity by rank band
const band = (lo, hi) => { const { rows, total } = ctx.aggregate(stats, ALL, lo, hi); return Object.fromEntries(rows.map((r) => [r.name, r.games / total])); };
const low = band(0, 14), mid = band(15, 24), top = band(29, 37);
const n = Object.keys(top).length;

// Meta signals and its parts
const meta = ctx.metaScore(ctx.metaSignals(stats, ALL, 29), { winTop: 1, pickTop: 1, lift: 0.75 });
// Explorer: rank-standardized Bayes win rate at GoD IV+
const ex = (() => { const a = ctx.aggregate(stats, ALL, 33, 37); ctx.useRaw(a.rows); ctx.standardizeByRank(a.rows, a.rankG, a.rankW); ctx.scoreRows(a.rows, { method: 'bayes', z: 1.96, prior: 0 }); return a.rows; })();
// Matchup consensus at GoD IV+, latest patch
const names = charNames(JSON.parse(fs.readFileSync(ROOT + '/state/page.json', 'utf8')).charIds);
const mu = JSON.parse(zlib.gunzipSync(fs.readFileSync(ROOT + '/state/mu-30202.json.gz')));
const agg = new Map();
for (const [, rank, ch, opp, g, w] of mu) { if (rank < 33) continue; const k = ch + ',' + opp; const a = agg.get(k) || [0, 0]; a[0] += g; a[1] += w; agg.set(k, a); }
const cells = [...agg].map(([k, [g, w]]) => { const [c, o] = k.split(','); return [names[c], names[o], g, w, 0]; }).filter((c) => c[0] && c[1]);
const cons = ctx.consensus(cells, { boot: 0 });

console.log(`(${n} characters, #1 = best)`);
console.log('character   pick low→mid→top          | Meta: total  win  pick  lift | Explorer Bayes GoD4+ | Consensus: total  intrinsic  competitive');
for (const w of WHO) {
  const p = (x) => (x[w] * 100).toFixed(1) + '%';
  console.log(`${w.padEnd(11)} ${p(low).padStart(5)} → ${p(mid).padStart(5)} → ${p(top).padStart(5)}      |  #${rankIn(meta, 'score', w)}  #${rankIn(meta, 'winTop', w)}  #${rankIn(meta, 'pickTop', w)}  #${rankIn(meta, 'lift', w)}  |  #${rankIn(ex, 'score', w)}  |  #${rankIn(cons, 'score', w)}  #${rankIn(cons, 'intrinsic', w)}  #${rankIn(cons, 'competitive', w)}`);
}
// How much is "popular at low ranks" tied to low lift overall?
const names2 = Object.keys(top);
const rk = (o) => Object.fromEntries([...names2].sort((a, b) => o[b] - o[a]).map((x, i) => [x, i]));
const sp = (a, b) => { const ra = rk(a), rb = rk(b); return 1 - 6 * names2.reduce((s, x) => s + (ra[x] - rb[x]) ** 2, 0) / (n * (n * n - 1)); };
const liftO = Object.fromEntries(meta.map((r) => [r.name, r.lift])), winO = Object.fromEntries(meta.map((r) => [r.name, r.winTop]));
console.log(`\nrank correlation: low-rank popularity vs climb lift ${sp(low, liftO).toFixed(2)}, vs top win rate ${sp(low, winO).toFixed(2)}`);
