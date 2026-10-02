// Per-character pick share and win rate in three bands: below GoD, GoD–GoD V, GoD VI+ (markdown table).
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const stats = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const ALL = Object.keys(stats);
const BANDS = [['low', 0, 28], ['mid', 29, 34], ['high', 35, 37]];
const by = {}, avg = {}, totals = {};
for (const [b, lo, hi] of BANDS) {
  const { rows, total, rankG, rankW } = ctx.aggregate(stats, ALL, lo, hi);
  ctx.useRaw(rows);
  ctx.standardizeByRank(rows, rankG, rankW); // win rate compared within each rank, so rank mix doesn't skew it
  totals[b] = total;
  avg[b] = rankW.reduce((a, x) => a + x, 0) / rankG.reduce((a, x) => a + x, 0);
  for (const r of rows) (by[r.name] = by[r.name] || {})[b] = { pick: r.share, games: r.games, win: r.wrAdj };
}
const names = Object.keys(by).sort((a, b) => (by[b].high?.pick || 0) - (by[a].high?.pick || 0));
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const dev = (x, b) => { const d = (x - avg[b]) * 100; return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1); };
console.log(`games: below GoD ${(totals.low / 1e6).toFixed(1)}M · GoD–GoD V ${(totals.mid / 1e6).toFixed(1)}M · GoD VI+ ${(totals.high / 1e6).toFixed(2)}M`);
console.log(`band average win rate: ${BANDS.map(([b]) => pct(avg[b])).join(' / ')}\n`);
console.log('| # | Character | Pick <GoD | Pick GoD–V | Pick GoD VI+ | Lift VI+ vs mid | Win vs avg <GoD | GoD–V | GoD VI+ | GoD VI+ games |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
names.forEach((n, i) => {
  const c = by[n];
  console.log(`| ${i + 1} | ${n} | ${pct(c.low.pick)} | ${pct(c.mid.pick)} | ${pct(c.high.pick)} | ${(c.high.pick / c.mid.pick).toFixed(2)}× | ${dev(c.low.win, 'low')} | ${dev(c.mid.win, 'mid')} | ${dev(c.high.win, 'high')} | ${c.high.games.toLocaleString()} |`);
});
