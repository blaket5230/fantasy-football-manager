const { runRoom, BLAKE_STRATEGIES } = require('./sim-core.js');

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sd(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}
function percentile(xs, p) {
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[idx];
}

// Runs `n` paired replicates (same seed -> same room conditions) across every
// strategy in `strategies`, collecting everything the insights report needs:
// starter value, rank, spend, position-spend split, and the room's persona
// mix (for the sensitivity slice).
function runInsightsBatch(n, strategies, seedStart) {
  const start = seedStart || 1;
  const rows = []; // one row per (replicate, strategy)
  const t0 = Date.now();
  for (let k = 0; k < n; k++) {
    const seed = start + k;
    strategies.forEach(s => {
      const res = runRoom(seed, s);
      rows.push({
        seed, strategy: s,
        starter: res.blake.starterValue, total: res.blake.totalValue, bench: res.blake.benchValue,
        rank: res.blake.rank, spend: res.blake.spend,
        posSpend: res.blake.posSpend, posCount: res.blake.posCount, personaCounts: res.personaCounts,
      });
    });
    if (process.env.SIM_PROGRESS && (k + 1) % 100 === 0) {
      console.error(`... ${k + 1}/${n} replicates (${Date.now() - t0}ms elapsed)`);
    }
  }
  const elapsed = Date.now() - t0;
  return { rows, elapsed, n, strategies };
}

function buildReport(batch) {
  const { rows, elapsed, n, strategies } = batch;
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`ZUB DRAFT SIMULATOR -- INSIGHTS REPORT`);
  push(`${n} paired replicates x ${strategies.length} strategies = ${rows.length} simulated rooms`);
  push(`Runtime: ${(elapsed / 1000).toFixed(1)}s (${(elapsed / rows.length).toFixed(0)}ms/room)`);
  push('');

  // ---------- per-strategy summary ----------
  const byStrat = {};
  strategies.forEach(s => { byStrat[s] = rows.filter(r => r.strategy === s); });

  push('=== STRATEGY SCOREBOARD ===');
  push('(starter VOR = Blake\'s best-8 starting lineup value above replacement; rank = of 12 teams)');
  push('');
  const summary = strategies.map(s => {
    const st = byStrat[s].map(r => r.starter);
    const rk = byStrat[s].map(r => r.rank);
    const sp = byStrat[s].map(r => r.spend);
    const winRate = rk.filter(r => r <= 3).length / rk.length;
    const bustRate = rk.filter(r => r >= 10).length / rk.length;
    return {
      strategy: s, meanStarter: mean(st), sdStarter: sd(st),
      meanRank: mean(rk), sdRank: sd(rk),
      p10: percentile(st, 0.10), p90: percentile(st, 0.90),
      winRate, bustRate, meanSpend: mean(sp),
      vorPerDollar: mean(st) / Math.max(1, mean(sp)),
    };
  });
  summary.sort((a, b) => b.meanStarter - a.meanStarter);
  summary.forEach((s, i) => {
    push(`${i + 1}. ${s.strategy}`);
    push(`   starter VOR:  mean ${s.meanStarter.toFixed(2)}  (sd ${s.sdStarter.toFixed(2)}, 10th-90th pct: ${s.p10.toFixed(1)}-${s.p90.toFixed(1)})`);
    push(`   league rank:  mean ${s.meanRank.toFixed(2)} of 12   top-3 finish: ${(s.winRate * 100).toFixed(0)}%   bottom-3 finish: ${(s.bustRate * 100).toFixed(0)}%`);
    push(`   spend:        mean $${s.meanSpend.toFixed(0)}   VOR per dollar: ${s.vorPerDollar.toFixed(3)}`);
    push('');
  });

  // ---------- paired significance vs baseline (first strategy in the list) ----------
  push('=== HEAD-TO-HEAD vs BASELINE (paired) ===');
  const base = strategies[0];
  strategies.slice(1).forEach(cmp => {
    const a = byStrat[base], b = byStrat[cmp];
    const diffs = a.map((r, idx) => r.starter - b[idx].starter);
    const dMean = mean(diffs), dSd = sd(diffs);
    const se = dSd / Math.sqrt(diffs.length);
    const t = se > 0 ? dMean / se : NaN;
    const sig = Math.abs(t) > 2.58 ? '>99% confidence' : Math.abs(t) > 1.96 ? '>95% confidence' : 'not resolved at this n';
    push(`${base} vs ${cmp}: mean diff ${dMean >= 0 ? '+' : ''}${dMean.toFixed(2)} VOR in favor of ${base}, t=${t.toFixed(2)} (${sig})`);
  });
  push('');

  // ---------- position spend breakdown per strategy ----------
  push('=== WHERE THE MONEY WENT (Blake, by strategy) ===');
  const posList = ['QB', 'RB', 'WR', 'TE', 'PK', 'DST'];
  strategies.forEach(s => {
    const rs = byStrat[s];
    const avgPos = {};
    posList.forEach(p => { avgPos[p] = mean(rs.map(r => r.posSpend[p] || 0)); });
    push(`${s.padEnd(20)} ` + posList.map(p => `${p} $${avgPos[p].toFixed(0)}`).join('  '));
  });
  push('');

  // ---------- roster composition: how many of each position, and bench value ----------
  push('=== ROSTER COMPOSITION & BENCH (Blake, by strategy) ===');
  push('(counts are full 18-man roster, including held players; RB/WR floor is 3 each, no TE floor)');
  strategies.forEach(s => {
    const rs = byStrat[s];
    const avgCount = {};
    posList.forEach(p => { avgCount[p] = mean(rs.map(r => (r.posCount && r.posCount[p]) || 0)); });
    const avgBench = mean(rs.map(r => r.bench || 0));
    push(`${s.padEnd(20)} ` + posList.map(p => `${p} ${avgCount[p].toFixed(1)}`).join('  ') + `   bench VOR: ${avgBench.toFixed(2)}`);
  });
  push('');

  // ---------- sensitivity to room composition ----------
  push('=== ROBUSTNESS ACROSS ROOM TYPES (baseline strategy: ' + base + ') ===');
  const baseRows = byStrat[base];
  const heavyIn = persona => baseRows.filter(r => (r.personaCounts[persona] || 0) >= 3);
  ['namechaser', 'hoarder', 'passive', 'panicker', 'rational'].forEach(p => {
    const subset = heavyIn(p);
    if (subset.length < 8) { push(`${p.padEnd(12)} too few replicates with 3+ ${p} rivals to read (n=${subset.length})`); return; }
    push(`${p.padEnd(12)} n=${subset.length.toString().padEnd(4)} mean starter VOR ${mean(subset.map(r => r.starter)).toFixed(2)}   mean rank ${mean(subset.map(r => r.rank)).toFixed(2)}`);
  });
  push('(rooms with 3+ rivals of a given persona are rarer by chance, so these read directionally, not precisely)');
  push('');

  // ---------- auto-generated takeaways ----------
  push('=== TAKEAWAYS ===');
  const best = summary[0], worst = summary[summary.length - 1];
  push(`- Best performer: ${best.strategy} (mean rank ${best.meanRank.toFixed(1)} of 12, top-3 in ${(best.winRate * 100).toFixed(0)}% of rooms).`);
  push(`- Worst performer: ${worst.strategy} (mean rank ${worst.meanRank.toFixed(1)} of 12).`);
  const spread = best.meanStarter - worst.meanStarter;
  push(`- Spread between best and worst strategy: ${spread.toFixed(2)} starter VOR, ${spread > 2 ? 'a real gap, not noise at this sample size' : 'a modest gap worth more replicates to pin down'}.`);
  const mostConsistent = summary.slice().sort((a, b) => a.sdStarter - b.sdStarter)[0];
  push(`- Most consistent (lowest variance) strategy: ${mostConsistent.strategy} (sd ${mostConsistent.sdStarter.toFixed(2)}). Lower variance matters if the goal is a durable floor, not just the best average outcome.`);
  const bestEff = summary.slice().sort((a, b) => b.vorPerDollar - a.vorPerDollar)[0];
  push(`- Best value-per-dollar: ${bestEff.strategy} (${bestEff.vorPerDollar.toFixed(3)} VOR/$).`);
  push('');

  return lines.join('\n');
}

if (require.main === module) {
  const n = parseInt(process.argv[2] || '2000', 10);
  const strategies = process.argv[3] ? process.argv[3].split(',') : Object.keys(BLAKE_STRATEGIES);
  console.error(`Running ${n} paired replicates x ${strategies.length} strategies (${n * strategies.length} rooms)...`);
  const batch = runInsightsBatch(n, strategies, 100000);
  const report = buildReport(batch);
  console.log(report);
}

module.exports = { runInsightsBatch, buildReport, mean, sd, percentile };
