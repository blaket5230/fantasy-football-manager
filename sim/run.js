const { runRoom } = require('./sim-core.js');

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sd(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

function runBatch(n, strategies, seedStart) {
  const start = seedStart || 1;
  const results = {};
  strategies.forEach(s => { results[s] = { starter: [], rank: [], spend: [] }; });
  const t0 = Date.now();
  for (let k = 0; k < n; k++) {
    const seed = start + k; // SAME seed reused across strategies -> paired design
    strategies.forEach(s => {
      const res = runRoom(seed, s);
      results[s].starter.push(res.blake.starterValue);
      results[s].rank.push(res.blake.rank);
      results[s].spend.push(res.blake.spend);
    });
  }
  const elapsed = Date.now() - t0;
  return { results, elapsed, n, strategies };
}

function summarize(batch) {
  const { results, elapsed, n, strategies } = batch;
  console.log(`\n${n} paired replicates x ${strategies.length} strategies = ${n * strategies.length} rooms simulated in ${elapsed}ms (${(elapsed / (n * strategies.length)).toFixed(1)}ms/room)\n`);
  strategies.forEach(s => {
    const st = results[s].starter, rk = results[s].rank;
    console.log(`${s.padEnd(20)} starter VOR: mean=${mean(st).toFixed(2)} sd=${sd(st).toFixed(2)}   rank: mean=${mean(rk).toFixed(2)} sd=${sd(rk).toFixed(2)}`);
  });
  if (strategies.length >= 2) {
    const base = strategies[0];
    for (let i = 1; i < strategies.length; i++) {
      const cmp = strategies[i];
      const diffs = results[base].starter.map((v, idx) => v - results[cmp].starter[idx]);
      const dMean = mean(diffs), dSd = sd(diffs);
      const se = dSd / Math.sqrt(diffs.length);
      const t = se > 0 ? dMean / se : NaN;
      console.log(`\n${base} vs ${cmp} (paired): mean diff = ${dMean.toFixed(2)} VOR, se=${se.toFixed(2)}, t=${t.toFixed(2)} ${Math.abs(t) > 1.96 ? '(significant at ~95%)' : '(not significant yet)'}`);
    }
  }
}

if (require.main === module) {
  const n = parseInt(process.argv[2] || '20', 10);
  const strategies = ['walkaway', 'efficiency_only', 'aggressive_yellow'];
  const batch = runBatch(n, strategies, 1000);
  summarize(batch);
}

module.exports = { runBatch, summarize, mean, sd };
