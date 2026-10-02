// Fetch N recent Wavu windows and keep a compact match list for rematch / "one and done" analysis.
// Each line: [battle_at, p1, p2, p1_rank, p2_rank, winner, p1_char, p2_char]
const fs = require('fs');
const N = Number(process.argv[2] || 250);
const OUT = require('path').join(__dirname, 'data', process.env.OUT || 'matches.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (r) => (r >= 100 && r <= 107 ? r - 71 : r === 765 ? 37 : r);

fs.mkdirSync(require('path').join(__dirname, 'data'), { recursive: true });
(async () => {
  const out = fs.createWriteStream(OUT);
  let t = process.env.START ? +process.env.START : Math.floor((Date.now() / 1000 - 900) / 700) * 700, n = 0;
  for (let i = 0; i < N; i++, t -= 700) {
    let arr;
    for (;;) {
      try { const r = await fetch(`https://wank.wavu.wiki/api/replays?before=${t}`); if (!r.ok) throw new Error(r.status); arr = await r.json(); break; }
      catch (e) { console.warn('retry', e.message); await sleep(20000); }
    }
    for (const b of arr) {
      if (b.battle_type !== 2) continue;
      out.write(JSON.stringify([b.battle_at, b.p1_polaris_id, b.p2_polaris_id, norm(b.p1_rank), norm(b.p2_rank), b.winner, b.p1_chara_id, b.p2_chara_id]) + '\n');
      n++;
    }
    if (i % 50 === 0) console.log(`${i}/${N} windows, ${n} ranked matches`);
    await sleep(1000);
  }
  out.end();
  console.log('done', n, 'matches');
})();
