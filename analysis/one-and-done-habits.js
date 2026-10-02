// Habitual one-and-doners by rank band, on every matches*.jsonl file (compact typed arrays for millions of rows).
// Same rules as decliner-bands.js: a meeting continues if both players' next game is each other within 15 min;
// only counted from the view of a player who kept queuing; a player's band = where most of their meetings were.
const fs = require('fs');
const readline = require('readline');
const GAP = 15 * 60, EDGE = 30 * 60;
const MIN_MEETINGS = Number(process.argv[2] || 20);
const BANDS = [['Below Garyu', 0, 14], ['Purple (Garyu–Battle Ruler)', 15, 20], ['Blue (Fujin–Bushin)', 21, 24],
  ['Tekken King–Emperor', 25, 26], ['Tekken God–TGS', 27, 28], ['GoD–GoD III', 29, 32], ['GoD IV and up', 33, 37]];
const bandOfRank = new Int8Array(64).fill(-1);
BANDS.forEach(([, lo, hi], b) => { for (let r = lo; r <= hi; r++) bandOfRank[r] = b; });

(async () => {
  const ids = new Map();
  const id = (s) => { let v = ids.get(s); if (v === undefined) ids.set(s, (v = ids.size)); return v; };
  let cap = 1 << 22, n = 0;
  let T = new Int32Array(cap), A = new Int32Array(cap), B = new Int32Array(cap), RA = new Int8Array(cap), RB = new Int8Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (arr, Ctor) => { const x = new Ctor(cap); x.set(arr); return x; };
    T = g(T, Int32Array); A = g(A, Int32Array); B = g(B, Int32Array); RA = g(RA, Int8Array); RB = g(RB, Int8Array);
  };
  const seen = new Set(); // de-duplicate across files by (time, players)
  for (const f of fs.readdirSync(require('path').join(__dirname, 'data')).filter((x) => /^matches.*\.jsonl$/.test(x))) {
    const rl = readline.createInterface({ input: fs.createReadStream(require('path').join(__dirname, 'data', f)) });
    for await (const line of rl) {
      if (!line) continue;
      const [t, p1, p2, r1, r2] = JSON.parse(line);
      const k = t + p1 + p2;
      if (seen.has(k)) continue;
      seen.add(k);
      if (n === cap) grow();
      T[n] = t; A[n] = id(p1); B[n] = id(p2); RA[n] = r1; RB[n] = r2; n++;
    }
  }
  seen.clear();
  const order = new Int32Array(n).map((_, i) => i).sort((x, y) => T[x] - T[y]);
  const t0 = T[order[0]], t1 = T[order[n - 1]];

  // next game index (in sorted order) for each side of each game
  const nextA = new Int32Array(n).fill(-1), nextB = new Int32Array(n).fill(-1);
  const lastPos = new Int32Array(ids.size).fill(-1), lastSide = new Int8Array(ids.size);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    for (const [p, side] of [[A[i], 0], [B[i], 1]]) {
      const prev = lastPos[p];
      if (prev >= 0) (lastSide[p] === 0 ? nextA : nextB)[prev] = k;
      lastPos[p] = k; lastSide[p] = side;
    }
  }
  const at = (k) => T[order[k]];
  const cont = (k) => nextA[k] >= 0 && nextA[k] === nextB[k] && at(nextA[k]) - at(k) <= GAP;
  const isCont = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (cont(k)) isCont[nextA[k]] = 1;

  const pn = new Int32Array(ids.size), ps = new Int32Array(ids.size);
  const pb = Array.from({ length: BANDS.length }, () => new Int32Array(ids.size));
  const ones = []; // [opponent, myBand] for one-game meetings where I kept queuing
  for (let k = 0; k < n; k++) {
    if (isCont[k]) continue;
    const i = order[k];
    if (T[i] - t0 < EDGE || t1 - T[i] < EDGE) continue;
    let len = 1, j = k; while (cont(j)) { j = nextA[j]; len++; }
    for (const side of [0, 1]) {
      const nx = side === 0 ? nextA[j] : nextB[j];
      if (nx < 0 || at(nx) - at(j) > GAP) continue; // I stopped playing
      const me = side === 0 ? A[i] : B[i], opp = side === 0 ? B[i] : A[i];
      const b = bandOfRank[side === 0 ? RA[i] : RB[i]];
      if (b < 0) continue;
      pn[me]++; pb[b][me]++;
      if (len === 1) { ps[me]++; ones.push(opp, b); }
    }
  }

  const days = ((t1 - t0) / 86400).toFixed(1);
  const habitRate = new Float32Array(ids.size).fill(-1), habitBand = new Int8Array(ids.size).fill(-1);
  let qualified = 0;
  for (let p = 0; p < ids.size; p++) {
    if (pn[p] < MIN_MEETINGS) continue;
    qualified++;
    habitRate[p] = ps[p] / pn[p];
    let best = 0; for (let b = 1; b < BANDS.length; b++) if (pb[b][p] > pb[best][p]) best = b;
    habitBand[p] = best;
  }
  console.log(`${n.toLocaleString()} ranked matches over ${days} days, ${ids.size.toLocaleString()} players; ${qualified.toLocaleString()} with ${MIN_MEETINGS}+ meetings\n`);
  console.log(`| Rank | Players (${MIN_MEETINGS}+ meetings) | Almost always rematch (<20%) | 20–60% | 60–80% | **Almost never rematch (80%+)** | One-and-dones caused by an 80%+ opponent |`);
  console.log('|---|---|---|---|---|---|---|');
  BANDS.forEach(([name], b) => {
    let cnt = 0, lo = 0, mid = 0, hi = 0, ser = 0;
    for (let p = 0; p < ids.size; p++) {
      if (habitBand[p] !== b) continue;
      cnt++; const r = habitRate[p];
      if (r < .2) lo++; else if (r < .6) mid++; else if (r < .8) hi++; else ser++;
    }
    let known = 0, serial = 0;
    for (let q = 0; q < ones.length; q += 2) {
      if (ones[q + 1] !== b || habitRate[ones[q]] < 0) continue;
      known++; if (habitRate[ones[q]] >= .8) serial++;
    }
    const pc = (x) => (x / cnt * 100).toFixed(0) + '%';
    console.log(`| ${name} | ${cnt.toLocaleString()} | ${pc(lo)} | ${pc(mid)} | ${pc(hi)} | **${(ser / cnt * 100).toFixed(1)}%** | ${(serial / known * 100).toFixed(0)}% |`);
  });
})();
