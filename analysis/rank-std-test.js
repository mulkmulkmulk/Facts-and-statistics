// Does rank standardization make Explorer win-rate methods more consistent between regions / patches?
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js', 'metasignals.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const latest = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const prev = JSON.parse(fs.readFileSync(`${ROOT}/cache/stats-30201.json`, 'utf8')).stats;
const ALL = Object.keys(latest), REST = ALL.filter((r) => r !== 'Americas');
const spear = (a, b) => {
  const names = Object.keys(a).filter((n) => n in b);
  const rk = (o) => Object.fromEntries([...names].sort((x, y) => o[y] - o[x]).map((n, i) => [n, i]));
  const ra = rk(a), rb = rk(b), n = names.length;
  return 1 - 6 * names.reduce((s, x) => s + (ra[x] - rb[x]) ** 2, 0) / (n * (n * n - 1));
};
function scores(stats, regions, lo, hi, method, std) {
  const { rows, rankG, rankW } = ctx.aggregate(stats, regions, lo, hi);
  ctx.useRaw(rows);
  if (std) ctx.standardizeByRank(rows, rankG, rankW);
  ctx.scoreRows(rows, { method, winBase: 'wilson', norm: 'rank', z: 1.96, prior: 0, wA: 0.5, wB: 0.3, wC: 0.2 });
  return Object.fromEntries(rows.map((r) => [r.name, r.score]));
}
console.log('range        method     | regions raw→std | patches raw→std');
for (const [lo, hi, label] of [[0, 37, 'All ranks'], [15, 37, 'Garyu+'], [25, 37, 'TK+'], [29, 37, 'GoD+'], [33, 37, 'GoD IV+']]) {
  for (const m of ['winrate', 'wilson', 'bayes', 'composite']) {
    const r = [false, true].map((std) => spear(scores(latest, ['Americas'], lo, hi, m, std), scores(latest, REST, lo, hi, m, std)));
    const p = [false, true].map((std) => spear(scores(latest, ALL, lo, hi, m, std), scores(prev, Object.keys(prev), lo, hi, m, std)));
    console.log(`${label.padEnd(12)} ${m.padEnd(10)} |  ${r[0].toFixed(3)} → ${r[1].toFixed(3)}  |  ${p[0].toFixed(3)} → ${p[1].toFixed(3)}`);
  }
}
