// Compare candidate tier-list metrics on ewgf per-rank stats: split-half reliability + resulting order.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
for (const f of ['ranks.js', 'stats.js', 'consensus.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx);
const RANKS = vm.runInContext('RANKS', ctx);
const load = (v) => JSON.parse(fs.readFileSync(`${ROOT}/cache/stats-${v}.json`, 'utf8')).stats || JSON.parse(fs.readFileSync(`${ROOT}/cache/stats-${v}.json`, 'utf8'));
const latest = JSON.parse(fs.readFileSync(`${ROOT}/cache/latest.json`, 'utf8')).latest.stats;
const S = { 30202: latest, 30201: load(30201) };
const ALL = ['Region Not Set', 'Asia', 'Middle East', 'Oceania', 'Americas', 'Europe'];
const RI = (r) => RANKS.indexOf(r);
const TOP = [29, 37], TOP4 = [33, 37], MID = [15, 24];

function perChar(stats, regions) {
  const c = {}; // name -> { byRank: games[38], winsTop, gamesTop }
  for (const reg of regions) for (const [rank, chars] of Object.entries(stats[reg] || {})) {
    const ri = RI(rank);
    for (const [name, s] of Object.entries(chars)) {
      const e = c[name] || (c[name] = { g: new Array(38).fill(0), w: new Array(38).fill(0) });
      e.g[ri] += s.games; e.w[ri] += s.wins;
    }
  }
  return c;
}
const sum = (a, [lo, hi]) => a.slice(lo, hi + 1).reduce((x, y) => x + y, 0);

function metrics(stats, regions) {
  const c = perChar(stats, regions);
  const names = Object.keys(c);
  const tot = (range) => names.reduce((a, n) => a + sum(c[n].g, range), 0);
  const tTop = tot(TOP), tMid = tot(MID), tTop4 = tot(TOP4);
  const out = {};
  // pooled top win rate for shrinkage
  const W = names.reduce((a, n) => a + sum(c[n].w, TOP), 0) / tTop;
  for (const n of names) {
    const g = c[n].g, w = c[n].w;
    const gTop = sum(g, TOP), gMid = sum(g, MID);
    const allG = g.reduce((a, b) => a + b, 0);
    out[n] = {
      pickTop: gTop / tTop,
      lift: Math.log((gTop / tTop) / (gMid / tMid)),
      meanRank: g.reduce((a, x, i) => a + x * i, 0) / allG,
      wrTop: (sum(w, TOP) + 500 * W) / (gTop + 500),
    };
  }
  // explorer composite at GoD4+ (as shown in the site)
  const agg = ctx.aggregate(stats, regions, 33, 37);
  ctx.useRaw(agg.rows);
  ctx.scoreRows(agg.rows, { method: 'composite', winBase: 'wilson', norm: 'rank', z: 1.96, prior: 0, wA: 0.5, wB: 0.3, wC: 0.2 });
  for (const r of agg.rows) if (out[r.name]) out[r.name].composite = r.score;
  // z-combos
  const z = (k) => { const v = names.map((n) => out[n][k]); const m = v.reduce((a, b) => a + b) / v.length; const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length); return Object.fromEntries(names.map((n) => [n, (out[n][k] - m) / sd])); };
  const zl = z('lift'), zw = z('wrTop'), zp = z('pickTop');
  for (const n of names) {
    out[n].lift_wr = (zl[n] + zw[n]) / 2;
    out[n].pick_wr = (zp[n] + zw[n]) / 2;
    out[n].lift_pick_wr = (zl[n] + zp[n] + zw[n]) / 3;
  }
  return out;
}

function spearman(a, b, key) {
  const names = Object.keys(a).filter((n) => b[n] && a[n][key] != null && b[n][key] != null);
  const rk = (o) => { const s = [...names].sort((x, y) => o[y][key] - o[x][key]); return Object.fromEntries(s.map((n, i) => [n, i])); };
  const ra = rk(a), rb = rk(b), n = names.length;
  const d2 = names.reduce((s, x) => s + (ra[x] - rb[x]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const full = metrics(S[30202], ALL);
const amer = metrics(S[30202], ['Americas']);
const rest = metrics(S[30202], ['Europe', 'Asia', 'Middle East', 'Oceania']);
const prev = metrics(S[30201], ALL);
const keys = ['composite', 'pickTop', 'lift', 'meanRank', 'wrTop', 'lift_wr', 'pick_wr', 'lift_pick_wr'];
console.log('metric         region-split  patch-split  vs composite   top 6 | bottom 6');
for (const k of keys) {
  const order = Object.keys(full).sort((x, y) => full[y][k] - full[x][k]);
  const vsComp = spearman(Object.fromEntries(order.map((n) => [n, { x: full[n][k] }])), Object.fromEntries(order.map((n) => [n, { x: full[n].composite }])), 'x');
  console.log(`${k.padEnd(14)} ${spearman(amer, rest, k).toFixed(2).padStart(8)}  ${spearman(full, prev, k).toFixed(2).padStart(11)}  ${vsComp.toFixed(2).padStart(12)}   ${order.slice(0, 6).join(', ')} | ${order.slice(-6).join(', ')}`);
}
fs.writeFileSync(__dirname + '/metrics-full.json', JSON.stringify(full));
