// Pure scoring + tiering functions. No DOM in here.

// Sum wins/games per character over the selected regions and rank range (also kept per rank).
function aggregate(stats, regions, rankLo, rankHi) {
  const by = new Map();
  const rankG = new Float64Array(RANKS.length), rankW = new Float64Array(RANKS.length);
  for (const region of regions) {
    const ranks = stats[region] || {};
    for (const [rank, chars] of Object.entries(ranks)) {
      const ri = RANKS.indexOf(rank);
      if (ri < rankLo || ri > rankHi) continue;
      for (const [name, s] of Object.entries(chars)) {
        let c = by.get(name);
        if (!c) by.set(name, (c = { name, games: 0, wins: 0, gR: new Float64Array(RANKS.length), wR: new Float64Array(RANKS.length) }));
        c.games += s.games; c.wins += s.wins;
        c.gR[ri] += s.games; c.wR[ri] += s.wins;
        rankG[ri] += s.games; rankW[ri] += s.wins;
      }
    }
  }
  const rows = [...by.values()].filter((c) => c.games > 0);
  const total = rows.reduce((a, c) => a + c.games, 0);
  for (const c of rows) {
    c.share = c.games / total; // share of all character appearances
    c.wr = c.wins / c.games;
  }
  return { rows, total, rankG, rankW };
}

// Average win rate differs a lot between ranks (e.g. 49% at GoD vs 74% at GoD VII), so a character
// whose players sit higher inside the chosen range gets a free boost (Simpson's paradox). Direct
// standardization: compare the character to each rank's average, weight ranks by the overall rank
// mix, and add back the pooled average. Adjusts w/wrAdj in place (after mirror correction).
function standardizeByRank(rows, rankG, rankW) {
  const total = rankG.reduce((a, b) => a + b, 0);
  const pooled = rankW.reduce((a, b) => a + b, 0) / total;
  for (const c of rows) {
    let d = 0, wsum = 0;
    for (let r = 0; r < rankG.length; r++) {
      if (!c.gR[r] || !rankG[r]) continue;
      const weight = rankG[r] / total;
      d += weight * (c.wR[r] / c.gR[r] - rankW[r] / rankG[r]);
      wsum += weight;
    }
    const std = pooled + (wsum ? d / wsum : 0);
    c.wrAdj += std - c.wr;
    c.w = c.wrAdj * c.n;
  }
}

// If mirror matches are counted, each one adds exactly 50% to that character.
// Chance the opponent is the same character ≈ its pick share, so strip that out.
function applyMirrorCorrection(rows) {
  for (const c of rows) {
    const m = c.share;
    c.n = c.games * (1 - m);
    c.w = c.wins - 0.5 * m * c.games;
    c.wrAdj = c.w / c.n;
  }
}

function useRaw(rows) {
  for (const c of rows) { c.n = c.games; c.w = c.wins; c.wrAdj = c.wr; }
}

function wilson(w, n, z) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = w / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: (center - margin) / denom, hi: (center + margin) / denom };
}

// Empirical-Bayes beta-binomial: shrink each win rate toward the pooled mean.
// k (prior strength, in games) is estimated from between-character variance when auto.
function bayesPrior(rows) {
  const W = rows.reduce((a, c) => a + c.w, 0), N = rows.reduce((a, c) => a + c.n, 0);
  const m = W / N;
  const ps = rows.map((c) => c.wrAdj);
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const observedVar = ps.reduce((a, p) => a + (p - mean) ** 2, 0) / Math.max(1, ps.length - 1);
  const noiseVar = rows.reduce((a, c) => a + (c.wrAdj * (1 - c.wrAdj)) / c.n, 0) / rows.length;
  const tau2 = Math.max(observedVar - noiseVar, 1e-7);
  const k = Math.min(Math.max(m * (1 - m) / tau2 - 1, 0), 1e6);
  return { m, k };
}

function percentileRank(values) {
  // 1 = best, 0 = worst. Ties share the average position.
  const n = values.length;
  const idx = values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const out = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const pos = (i + j) / 2;
    for (let t = i; t <= j; t++) out[idx[t][1]] = n === 1 ? 1 : (n - 1 - pos) / (n - 1);
    i = j + 1;
  }
  return out;
}

function minMax(values) {
  const lo = Math.min(...values), hi = Math.max(...values);
  return values.map((v) => (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
}

function scoreRows(rows, opts) {
  const { z } = opts;
  for (const c of rows) {
    const ci = wilson(c.w, c.n, z);
    c.ciLo = ci.lo; c.ciHi = ci.hi;
  }
  const prior = bayesPrior(rows);
  const k = opts.prior > 0 ? opts.prior : prior.k;
  for (const c of rows) c.bayes = (c.w + k * prior.m) / (c.n + k);

  const winOf = (c, base) => (base === 'wilson' ? c.ciLo : base === 'bayes' ? c.bayes : c.wrAdj);

  if (opts.method === 'composite') {
    const norm = opts.norm === 'rank' ? percentileRank : minMax;
    const W = norm(rows.map((c) => winOf(c, opts.winBase)));
    const P = norm(rows.map((c) => c.share));
    rows.forEach((c, i) => {
      c.W = W[i]; c.P = P[i];
      c.score = opts.wA * W[i] + opts.wB * P[i] + opts.wC * W[i] * P[i];
    });
  } else {
    for (const c of rows) c.score = winOf(c, opts.method);
  }
  rows.sort((a, b) => b.score - a.score);
  return { priorK: k, priorAuto: prior.k, priorMean: prior.m };
}

// ---- versus-based scores, from collected matchup cells [char, opp, games, wins, expWins]

const VERSUS_METHODS = ['vsNash', 'vsBT', 'vsUniform', 'vsField'];

// Build games/wins matrices from cells. `games[i]` = the character's collected games in the filter.
// With `pooled`: the rank filter applies to the *row* player only, so i→j (i-players at this rank vs
// anyone) and j→i both carry the same "high-rank player beats lower opponent" edge. Pooling i→j with
// the flipped j→i cancels it and makes the matrix consistent: P[i][j] + P[j][i] = 1.
function matchupMatrix(cells, pooled = true) {
  const names = [...new Set(cells.flatMap((c) => [c[0], c[1]]))];
  const n = names.length, ix = new Map(names.map((nm, i) => [nm, i]));
  const G = names.map(() => new Float64Array(n)), W = names.map(() => new Float64Array(n));
  for (const [a, b, g, w] of cells) { const i = ix.get(a), j = ix.get(b); G[i][j] += g; W[i][j] += w; }
  const games = names.map((_, i) => G[i].reduce((a, g, j) => a + (i === j ? 0 : g), 0));
  if (pooled) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const g = G[i][j] + G[j][i], w = W[i][j] + (G[j][i] - W[j][i]);
      G[i][j] = G[j][i] = g; W[i][j] = w; W[j][i] = g - w;
    }
  }
  return { names, n, G, W, games };
}

// Matchup win rates shrunk toward 50% by k pseudo-games. Mirrors are 50% by definition; the
// observed mirror cell isn't (with a rank filter it's "high-rank X vs any X"), and leaving it in
// lets the Nash solver think a character beats itself.
function shrunkMatrix(G, W, k) {
  return G.map((row, i) => [...row].map((g, j) => (i === j ? 0.5 : (W[i][j] + 0.5 * k) / (g + k))));
}

// Returns Map name -> { score, games, nash? }. `k` = pseudo-games pulling each matchup toward 50%,
// so a 3–0 cell doesn't count as a 100% matchup.
function versusScores(cells, method, k) {
  const { names, n, G, W, games } = matchupMatrix(cells, method !== 'vsField');
  const P = shrunkMatrix(G, W, k);
  const out = new Map();
  const put = (score, extra = []) => names.forEach((nm, i) => out.set(nm, { score: score[i], games: games[i], ...(extra[i] || {}) }));

  if (method === 'vsUniform') {
    // Average matchup: every opponent counts equally, regardless of how popular it is.
    put(names.map((_, i) => P[i].reduce((a, p, j) => a + (i === j ? 0 : p), 0) / (n - 1)));
  } else if (method === 'vsField') {
    put(names.map((_, i) => { let w = 0, g = 0; for (let j = 0; j < n; j++) if (j !== i) { w += W[i][j]; g += G[i][j]; } return g ? w / g : 0.5; }));
  } else if (method === 'vsBT') {
    put(bradleyTerry(names, G, W, k));
  } else if (method === 'vsNash') {
    const x = nashMix(P);
    // Win rate against the equilibrium meta: characters in the Nash mix sit at the top (≈ its value).
    const score = names.map((_, i) => P[i].reduce((a, p, j) => a + x[j] * (i === j ? 0.5 : p), 0));
    put(score, x.map((w) => ({ nash: w })));
  }
  return out;
}

// Bradley–Terry strengths via the MM algorithm; reported as expected win rate vs an average opponent.
function bradleyTerry(names, G, W, k) {
  const n = names.length;
  const s = new Float64Array(n).fill(1);
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < n; i++) {
      let num = 0, den = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const g = G[i][j] + k, w = W[i][j] + 0.5 * k;
        num += w; den += g / (s[i] + s[j]);
      }
      s[i] = den ? num / den : s[i];
    }
    const gm = Math.exp(s.reduce((a, v) => a + Math.log(v), 0) / n);
    for (let i = 0; i < n; i++) s[i] /= gm;
  }
  return names.map((_, i) => { let a = 0; for (let j = 0; j < n; j++) if (j !== i) a += s[i] / (s[i] + s[j]); return a / (n - 1); });
}

// Symmetric zero-sum game with payoff P[i][j] − 0.5, solved by regret-matching+ self-play
// with linearly weighted averaging. Returns the equilibrium character mix (sums to 1).
function nashMix(P, iters = 4000) {
  const n = P.length;
  const R = new Float64Array(n), avg = new Float64Array(n);
  let x = new Float64Array(n).fill(1 / n);
  for (let t = 1; t <= iters; t++) {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let j = 0; j < n; j++) v += (P[i][j] - 0.5) * x[j]; u[i] = v; }
    let ev = 0;
    for (let i = 0; i < n; i++) ev += x[i] * u[i];
    let sum = 0;
    for (let i = 0; i < n; i++) { R[i] = Math.max(0, R[i] + u[i] - ev); sum += R[i]; }
    x = sum > 0 ? R.map((r) => r / sum) : new Float64Array(n).fill(1 / n);
    for (let i = 0; i < n; i++) avg[i] += t * x[i];
  }
  const tot = avg.reduce((a, b) => a + b, 0);
  return [...avg].map((v) => (v / tot < 1e-3 ? 0 : v / tot));
}

// ---- tier cuts: each returns an array of tier indices aligned with sorted rows

// Bell-ish proportions, e.g. 5 tiers → 2:5:7:5:2 — fewest chars in S and the bottom tier.
function cutQuantile(rows, k) {
  const weights = Array.from({ length: k }, (_, i) => binom(k - 1, i) + 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let t = 0; t < k; t++) {
    acc += weights[t];
    const end = Math.round((acc / sum) * rows.length);
    while (out.length < end) out.push(t);
  }
  return out;
}

function binom(n, r) {
  let v = 1;
  for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
  return v;
}

// Bands 1σ wide, centred on the mean.
function cutSd(rows, k) {
  const s = rows.map((c) => c.score);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length) || 1;
  const bounds = Array.from({ length: k - 1 }, (_, i) => mean + ((k - 2) / 2 - i) * sd);
  return s.map((v) => { let t = 0; while (t < bounds.length && v < bounds[t]) t++; return t; });
}

// Jenks natural breaks via DP on the (already descending) scores.
function cutJenks(rows, k) {
  const x = rows.map((c) => c.score);
  const n = x.length;
  k = Math.min(k, n);
  const pre = [0], pre2 = [0];
  for (const v of x) { pre.push(pre[pre.length - 1] + v); pre2.push(pre2[pre2.length - 1] + v * v); }
  const ssd = (i, j) => { const s = pre[j] - pre[i], s2 = pre2[j] - pre2[i], m = j - i; return s2 - (s * s) / m; };
  const cost = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const back = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
  cost[0][0] = 0;
  for (let c = 1; c <= k; c++)
    for (let j = c; j <= n; j++)
      for (let i = c - 1; i < j; i++) {
        const v = cost[c - 1][i] + ssd(i, j);
        if (v < cost[c][j]) { cost[c][j] = v; back[c][j] = i; }
      }
  const out = new Array(n);
  for (let c = k, j = n; c > 0; c--) { const i = back[c][j]; for (let t = i; t < j; t++) out[t] = c - 1; j = i; }
  return out;
}

// Walk down the list; a new tier starts once a character's interval no longer
// overlaps the current tier leader's interval (i.e. it's significantly worse).
function cutOverlap(rows) {
  const out = [];
  let tier = 0, head = rows[0];
  for (const c of rows) {
    if (c.ciHi < head.ciLo) { tier++; head = c; }
    out.push(tier);
  }
  return out;
}

function assignTiers(rows, cut, k) {
  if (!rows.length) return [];
  if (cut === 'sd') return cutSd(rows, k);
  if (cut === 'jenks') return cutJenks(rows, k);
  if (cut === 'overlap') return cutOverlap(rows);
  return cutQuantile(rows, k);
}
