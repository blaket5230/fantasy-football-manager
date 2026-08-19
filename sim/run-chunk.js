// Runs COUNT replicates starting at START_SEED, across all 4 strategies,
// and appends one JSON line per (replicate, strategy) result to OUT_FILE.
// Built to be called repeatedly across several short invocations (this
// environment tears down background/nohup processes between tool calls, so
// a single 20-minute blocking run isn't reliable -- chunking is).
const fs = require('fs');
const { runRoom, BLAKE_STRATEGIES } = require('./sim-core.js');

const startSeed = parseInt(process.argv[2], 10);
const count = parseInt(process.argv[3], 10);
const outFile = process.argv[4];
const strategies = Object.keys(BLAKE_STRATEGIES);

const t0 = Date.now();
const lines = [];
for (let k = 0; k < count; k++) {
  const seed = startSeed + k;
  strategies.forEach(s => {
    const res = runRoom(seed, s);
    lines.push(JSON.stringify({
      seed, strategy: s,
      starter: res.blake.starterValue, total: res.blake.totalValue, bench: res.blake.benchValue,
      rank: res.blake.rank, spend: res.blake.spend,
      posSpend: res.blake.posSpend, posCount: res.blake.posCount, personaCounts: res.personaCounts,
    }));
  });
}
fs.appendFileSync(outFile, lines.join('\n') + '\n');
console.log(`chunk done: seeds ${startSeed}-${startSeed + count - 1}, ${lines.length} rows, ${Date.now() - t0}ms`);
