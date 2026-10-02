// How reproducible is the meta-signals list under different weights? (region split + patch split)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js', 'metasignals.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const latest = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const prev = JSON.parse(fs.readFileSync(`${ROOT}/cache/stats-30201.json`, 'utf8')).stats;

console.log('win  pick  lift   regions  patches  | Asia-vs-Europe');
for (const [w, p, l] of [[1, 1, 1], [1, 1, 0.75], [1, 1, 0.5], [1, 1, 0.25], [1, 1, 0], [1, 0.5, 1], [0.5, 1, 1], [1, 0, 1], [0, 1, 1]]) {
  const m = ctx.metaModel(latest, prev, { topLo: 29, weights: { winTop: w, pickTop: p, lift: l } });
  const run = (regions) => ctx.metaScore(ctx.metaSignals(latest, regions, 29), { winTop: w, pickTop: p, lift: l });
  const ae = ctx.spearmanByName(run(['Asia']), run(['Europe']));
  console.log(`${w.toFixed(2)} ${p.toFixed(2)}  ${l.toFixed(2)}    ${m.regionAgreement.toFixed(3)}    ${m.patchAgreement.toFixed(3)}   | ${ae.toFixed(3)}`);
}
