// How much of each Mishima's all-ranks win rate gap is just "where its games are played" (rank mix)?
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const stats = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const { rows, rankG, rankW } = ctx.aggregate(stats, Object.keys(stats), 0, 37);
const avg = rankW.reduce((a, b) => a + b) / rankG.reduce((a, b) => a + b);
ctx.useRaw(rows);
const raw = Object.fromEntries(rows.map((r) => [r.name, r.wr]));
ctx.standardizeByRank(rows, rankG, rankW);
const std = Object.fromEntries(rows.map((r) => [r.name, r.wrAdj]));
const rank = (o, n) => Object.keys(o).sort((a, b) => o[b] - o[a]).indexOf(n) + 1;
console.log(`cast average ${(avg * 100).toFixed(2)}%`);
console.log('character   raw win (rank)    rank-mix-corrected (rank)   gap explained by rank mix');
for (const m of ['Kazuya', 'Jin', 'Heihachi', 'Reina', 'Devil Jin', 'Steve', 'King']) {
  const gRaw = raw[m] - avg, gStd = std[m] - avg;
  const expl = gRaw < 0 ? Math.max(0, Math.min(1, (gRaw - gStd) / gRaw)) : 0;
  console.log(`${m.padEnd(10)}  ${(raw[m] * 100).toFixed(2)}% (#${rank(raw, m)})    ${(std[m] * 100).toFixed(2)}% (#${rank(std, m)})              ${(gRaw * 100).toFixed(2)} → ${(gStd * 100).toFixed(2)} pts (${(expl * 100).toFixed(0)}% of the gap)`);
}
const n = rows.length, share = Object.fromEntries(rows.map((r) => [r.name, r.share]));
const sp = (a, b) => { const rk = (o) => Object.fromEntries(Object.keys(o).sort((x, y) => o[y] - o[x]).map((k, i) => [k, i])); const ra = rk(a), rb = rk(b); return 1 - 6 * Object.keys(a).reduce((s, k) => s + (ra[k] - rb[k]) ** 2, 0) / (n * (n * n - 1)); };
console.log(`\npopularity vs win rate: raw ${sp(share, raw).toFixed(2)}, after removing rank mix ${sp(share, std).toFixed(2)}`);
