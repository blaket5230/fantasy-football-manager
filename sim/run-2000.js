// THE "Go" SCRIPT. Run with: node run-2000.js
// Requires zub_cap_tracker.html to be present one directory up from this
// file (i.e. sibling to the sim/ folder). Takes roughly 20-25 minutes.
const fs = require('fs');
const path = require('path');
const { runInsightsBatch, buildReport } = require('./insights.js');
const { BLAKE_STRATEGIES } = require('./sim-core.js');

const N = parseInt(process.argv[2] || '2000', 10);
const strategies = Object.keys(BLAKE_STRATEGIES); // walkaway, efficiency_only, aggressive_yellow, stars_and_scrubs

process.env.SIM_PROGRESS = '1';
console.error(`Starting ${N} paired replicates x ${strategies.length} strategies (${N * strategies.length} rooms). Expect ~20-25 minutes.`);

const batch = runInsightsBatch(N, strategies, 100000);
const report = buildReport(batch);

const outDir = path.join(__dirname, '..', 'out');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `insights-report-${N}.txt`);
fs.writeFileSync(outPath, report);

console.log(report);
console.error(`\nSaved to ${outPath}`);
