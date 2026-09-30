// "Best estimate" tier list: three views of character strength from the pooled matchup matrix,
// combined on a common scale, with bootstrap confidence intervals.
//
//   practical   = win rate vs the opponents people actually play (includes rarity advantage)
//   intrinsic   = mean head-to-head win rate, every opponent weighted 1/(n−1) (meta-free)
//   competitive = win rate vs the Nash-equilibrium mix of the matchup game (counter-aware)

function consensusMetrics(G, W, k, nashIters) {
  const n = G.length;
  const P = shrunkMatrix(G, W, k);
  const practical = new Array(n), intrinsic = new Array(n), competitive = new Array(n);
  for (let i = 0; i < n; i++) {
    let w = 0, g = 0, sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) { w += W[i][j]; g += G[i][j]; sum += P[i][j]; }
    practical[i] = g ? w / g : 0.5;
    intrinsic[i] = sum / (n - 1);
  }
  const nash = nashMix(P, nashIters);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < n; j++) v += nash[j] * (i === j ? 0.5 : P[i][j]);
    competitive[i] = v;
  }
  return { practical, intrinsic, competitive, nash };
}

const METRICS = ['intrinsic', 'competitive', 'practical'];

// Metrics live on different scales, so combine z-scores (or Borda-style normalized ranks), not raw %.
function combineMetrics(m, weights, mode) {
  const n = m.practical.length;
  const norm = (xs) => {
    if (mode === 'borda') return percentileRank(xs);
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / n) || 1;
    return xs.map((v) => (v - mean) / sd);
  };
  const parts = Object.fromEntries(METRICS.map((k) => [k, norm(m[k])]));
  const wsum = METRICS.reduce((a, k) => a + weights[k], 0) || 1;
  const combined = Array.from({ length: n }, (_, i) => METRICS.reduce((a, k) => a + weights[k] * parts[k][i], 0) / wsum);
  return { combined, parts };
}

// Small seeded PRNG so the bootstrap (and so the tiers) don't jitter between renders.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binomialDraw(rand, g, p) {
  if (g < 40) { let w = 0; for (let t = 0; t < g; t++) if (rand() < p) w++; return w; }
  const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  return Math.min(g, Math.max(0, Math.round(g * p + z * Math.sqrt(g * p * (1 - p)))));
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function rankOrder(scores) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const rank = new Array(scores.length);
  order.forEach((i, r) => { rank[i] = r + 1; });
  return rank;
}

// Full pipeline. Returns one row per character, sorted best-first.
function consensus(cells, { k = 100, weights = { intrinsic: 0.4, competitive: 0.4, practical: 0.2 }, mode = 'z', boot = 60, ci = 0.9 } = {}) {
  const { names, n, G, W, games } = matchupMatrix(cells, true);
  const base = consensusMetrics(G, W, k, 5000);
  const { combined, parts } = combineMetrics(base, weights, mode);

  // Bootstrap: redraw every head-to-head record from its own observed win rate and recompute everything.
  const rand = mulberry32(12345);
  const bootScores = names.map(() => []), bootRanks = names.map(() => []);
  for (let b = 0; b < boot; b++) {
    const Wb = names.map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const g = G[i][j];
      if (!g) continue;
      const w = binomialDraw(rand, g, W[i][j] / g);
      Wb[i][j] = w; Wb[j][i] = g - w;
    }
    const mb = consensusMetrics(G, Wb, k, 1500);
    const cb = combineMetrics(mb, weights, mode).combined;
    const rb = rankOrder(cb);
    for (let i = 0; i < n; i++) { bootScores[i].push(cb[i]); bootRanks[i].push(rb[i]); }
  }
  const a = (1 - ci) / 2;
  const rows = names.map((name, i) => {
    const s = bootScores[i].sort((x, y) => x - y), r = bootRanks[i].sort((x, y) => x - y);
    return {
      name, games: games[i],
      practical: base.practical[i], intrinsic: base.intrinsic[i], competitive: base.competitive[i], nash: base.nash[i],
      z: { intrinsic: parts.intrinsic[i], competitive: parts.competitive[i], practical: parts.practical[i] },
      score: combined[i],
      ciLo: boot ? quantile(s, a) : combined[i], ciHi: boot ? quantile(s, 1 - a) : combined[i],
      rankLo: boot ? Math.round(quantile(r, a)) : null, rankHi: boot ? Math.round(quantile(r, 1 - a)) : null,
    };
  });
  return rows.sort((x, y) => y.score - x.score);
}

// Natural breaks with the tier count chosen by goodness of variance fit: the fewest tiers
// that explain `target` of the score variance (between 3 and 7 tiers). `fixedK` skips the search.
function jenksAuto(rows, target = 0.92, fixedK = null) {
  const x = rows.map((r) => r.score);
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const sdam = x.reduce((a, v) => a + (v - mean) ** 2, 0);
  let best = null;
  for (let k = fixedK || 3; k <= (fixedK || 7); k++) {
    const tiers = cutJenks(rows, k);
    let sdcm = 0;
    for (let t = 0; t < k; t++) {
      const xs = x.filter((_, i) => tiers[i] === t);
      if (!xs.length) continue;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      sdcm += xs.reduce((a, v) => a + (v - m) ** 2, 0);
    }
    const gvf = sdam ? 1 - sdcm / sdam : 1;
    best = { tiers, k, gvf };
    if (gvf >= target) break;
  }
  return best;
}
