const fs = require('fs');
const { buildReport } = require('./insights.js');
const { BLAKE_STRATEGIES } = require('./sim-core.js');

const inFile = process.argv[2];
const raw = fs.readFileSync(inFile, 'utf8').trim().split('\n');
const rows = raw.map(l => JSON.parse(l));
const strategies = Object.keys(BLAKE_STRATEGIES);
const n = rows.length / strategies.length;

const batch = { rows, elapsed: 0, n, strategies };
const report = buildReport(batch);
console.log(report);

const outPath = inFile.replace(/\.jsonl$/, '-report.txt');
fs.writeFileSync(outPath, report);
console.error(`\nSaved report to ${outPath}`);
