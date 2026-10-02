// Best alt for an Asuka main: who wins most against Asuka's bad matchups?
//   node asuka-alt.js <rankLo> <rankHi> <version|season> [main]
const fs = require('fs'), path = require('path'), vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const ROOT = require('path').join(__dirname, '..');
const ctx = {}; vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const { charNames } = require(ROOT + '/lib/characters');
const names = charNames(JSON.parse(fs.readFileSync(ROOT + '/state/page.json', 'utf8')).charIds);
const db = new DatabaseSync(ROOT + '/data/matchups.db', { readOnly: true });

const [lo, hi] = [+(process.argv[2] ?? 21), +(process.argv[3] ?? 26)];
const version = process.argv[4] || '30202';
const MAIN = process.argv[5] || 'Asuka';
const K = 100; // shrink each matchup toward 50% by 100 pseudo-games

const where = version === 'season' ? '' : 'AND version = ' + Number(version);
const cells = db.prepare(`SELECT ch, opp, SUM(games) g, SUM(wins) w FROM mu WHERE rank BETWEEN ? AND ? ${where} GROUP BY ch, opp`).all(lo, hi)
  .filter((c) => names[c.ch] && names[c.opp]).map((c) => [names[c.ch], names[c.opp], c.g, c.w]);
const { names: N, n, G, W } = ctx.matchupMatrix(cells, true); // pooled both sides, like the site
const P = ctx.shrunkMatrix(G, W, K);
const a = N.indexOf(MAIN);

// How often an Asuka at this rank meets each opponent (from her own side of the data)
const raw = Object.fromEntries(cells.filter((c) => c[0] === MAIN).map((c) => [c[1], c[2]]));
const totalA = Object.values(raw).reduce((x, y) => x + y, 0);
const freq = N.map((nm) => (raw[nm] || 0) / totalA);

// Asuka's matchups
const mus = N.map((nm, j) => ({ nm, j, p: P[a][j], g: G[a][j], f: freq[j] })).filter((m) => m.j !== a);
const bad = mus.filter((m) => m.p < 0.5).sort((x, y) => x.p - y.p);
const weight = N.map((_, j) => (j === a ? 0 : freq[j] * Math.max(0, 0.5 - P[a][j]))); // how much each opponent costs Asuka

const rows = N.map((nm, x) => {
  if (x === a) return null;
  let cov = 0, ws = 0, pair = 0, fsum = 0, field = 0;
  for (let j = 0; j < n; j++) {
    if (j === a) continue;
    const px = j === x ? 0.5 : P[x][j];
    if (weight[j] > 0) { cov += weight[j] * px; ws += weight[j]; }
    field += freq[j] * px; fsum += freq[j];
    pair += freq[j] * Math.max(P[a][j], px); // if you could always bring the better of the two
  }
  return { nm, cover: cov / ws, field: field / fsum, pair: pair / fsum, vsAsuka: P[x][a] };
}).filter(Boolean).sort((x, y) => y.cover - x.cover);

const asukaField = mus.reduce((s, m) => s + m.f * m.p, 0) / mus.reduce((s, m) => s + m.f, 0);
console.log(`${MAIN} at ${ctx.shortRank(ctx.RANKS?.[lo] || '') || lo}–${hi}, ${version}: ${(totalA).toLocaleString()} ${MAIN} games; her expected win rate vs the field ${(asukaField * 100).toFixed(1)}%`);
console.log(`\nWorst matchups (win rate, games, how often you face them):`);
for (const m of bad.slice(0, 10)) console.log(`  ${m.nm.padEnd(11)} ${(m.p * 100).toFixed(1)}%  ${Math.round(m.g).toLocaleString().padStart(7)} games  ${(m.f * 100).toFixed(1)}% of opponents`);
console.log(`\nBest alts by coverage (win rate vs Asuka's bad matchups, weighted by how bad × how common):`);
console.log('  alt          coverage   vs field   Asuka+alt best-of   alt vs Asuka');
for (const r of rows.slice(0, 12)) console.log(`  ${r.nm.padEnd(11)}  ${(r.cover * 100).toFixed(1)}%      ${(r.field * 100).toFixed(1)}%     ${(r.pair * 100).toFixed(1)}%             ${(r.vsAsuka * 100).toFixed(1)}%`);

