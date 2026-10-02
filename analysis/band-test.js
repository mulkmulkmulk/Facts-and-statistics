// Meta signals with different "top" / "mid" bands: sample size, reproducibility, and where key characters land.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js', 'metasignals.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const latest = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const prev = JSON.parse(fs.readFileSync(`${ROOT}/cache/stats-30201.json`, 'utf8')).stats;
const ALL = Object.keys(latest), REST = ALL.filter((r) => r !== 'Americas');
const W = { winTop: 1, pickTop: 1, lift: 0.75 };
const WHO = ['Reina', 'Kazuya', 'Jin', 'Heihachi', 'Devil Jin', 'Asuka', 'Eddy', 'Panda'];

const setups = [
  ['current: top GoD+, mid Garyu–Bushin', 29, [15, 24]],
  ['proposed: top GoD VI+, mid GoD–GoD V', 35, [29, 34]],
  ['in between: top GoD IV+, mid GoD–GoD III', 33, [29, 32]],
  ['top GoD+, mid TK–TGS', 29, [25, 28]],
];
for (const [label, top, mid] of setups) {
  const run = (st, regs) => ctx.metaScore(ctx.metaSignals(st, regs, top, true, mid), W);
  const full = run(latest, ALL).sort((a, b) => b.score - a.score);
  const am = run(latest, ['Americas']), rest = run(latest, REST), ae = [run(latest, ['Asia']), run(latest, ['Europe'])];
  const games = full.reduce((a, r) => a + r.gamesTop, 0), minG = Math.min(...full.map((r) => r.gamesTop));
  console.log(`\n${label}`);
  console.log(`  top-band games ${(games / 1e6).toFixed(2)}M (fewest: ${minG.toLocaleString()}) | regions agree ${ctx.spearmanByName(am, rest).toFixed(2)} | Asia vs Europe ${ctx.spearmanByName(...ae).toFixed(2)} | patches agree ${ctx.spearmanByName(full, run(prev, Object.keys(prev))).toFixed(2)}`);
  console.log('  ' + WHO.map((w) => `${w} #${full.findIndex((r) => r.name === w) + 1}`).join(', '));
  console.log('  top 6: ' + full.slice(0, 6).map((r) => r.name).join(', ') + ' | bottom 6: ' + full.slice(-6).map((r) => r.name).join(', '));
}
