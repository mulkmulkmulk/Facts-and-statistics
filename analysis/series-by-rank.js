// Best-of-3 series outcomes by rank, from the view of a player who kept queuing (2-day sample).
const fs = require('fs');
const GAP = 15 * 60, EDGE = 30 * 60;
const m = fs.readFileSync(require('path').join(__dirname, 'data', 'matches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a[0] - b[0]);
const t0 = m[0][0], t1 = m[m.length - 1][0];
const next = m.map(() => [null, null]), last = new Map();
m.forEach((x, i) => { for (const s of [0, 1]) { const p = x[1 + s], prev = last.get(p); if (prev) next[prev.i][prev.s] = i; last.set(p, { i, s }); } });
const cont = (i) => { const a = next[i][0]; return a != null && a === next[i][1] && m[a][0] - m[i][0] <= GAP; };
const isCont = new Set(); m.forEach((_, i) => { if (cont(i)) isCont.add(next[i][0]); });
const gone = (i, s) => next[i][s] == null || m[next[i][s]][0] - m[i][0] > GAP;
const BANDS = [['Below Garyu', 0, 14], ['Purple (Garyu – Battle Ruler)', 15, 20], ['Blue (Fujin – Bushin)', 21, 24],
  ['Tekken King – Emperor', 25, 26], ['Tekken God – TGS', 27, 28], ['GoD – GoD III', 29, 32], ['GoD IV and up', 33, 37]];
const band = (r) => BANDS.findIndex(([, lo, hi]) => r >= lo && r <= hi);
const st = BANDS.map(() => ({ n: 0, after1: 0, at11: 0, done: 0, another: 0, after1Won: 0, won1: 0, after1Lost: 0, lost1: 0 }));
m.forEach((x, i) => {
  if (isCont.has(i) || x[0] - t0 < EDGE || t1 - x[0] < EDGE) return;
  const games = [i]; let j = i; while (cont(j)) { j = next[j][0]; games.push(j); }
  const winner = (k) => (m[k][5] === 1 ? m[k][1] : m[k][2]);
  for (const s of [0, 1]) {
    if (gone(j, s)) continue; // only when this player kept queuing
    const b = band(x[3 + s]); if (b < 0) continue;
    const me = x[1 + s], t = st[b];
    t.n++;
    const wonFirst = winner(games[0]) === me;
    if (wonFirst) t.won1++; else t.lost1++;
    if (games.length === 1) { t.after1++; if (wonFirst) t.after1Won++; else t.after1Lost++; }
    else if (games.length === 2 && winner(games[0]) !== winner(games[1])) t.at11++;
    else if (games.length <= 3) t.done++;
    else t.another++;
  }
});
console.log('| Your rank | Series | Opponent gone after game 1 | ...when you won game 1 | ...when you lost it | Gone at 1–1 (no decider) | Series finished | Played another series |');
console.log('|---|---|---|---|---|---|---|---|');
BANDS.forEach(([name], b) => {
  const t = st[b], p = (a, d) => (a / d * 100).toFixed(0) + '%';
  console.log(`| ${name} | ${t.n.toLocaleString()} | **${p(t.after1, t.n)}** | ${p(t.after1Won, t.won1)} | ${p(t.after1Lost, t.lost1)} | ${p(t.at11, t.n)} | ${p(t.done, t.n)} | ${(t.another / t.n * 100).toFixed(1)}% |`);
});
