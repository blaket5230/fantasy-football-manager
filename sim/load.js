const fs = require('fs');
const path = require('path');
const vm = require('vm');
const buildSandbox = require('./dom-mock.js');

// Reads directly from zub_cap_tracker.html (expected one directory up from
// this file) and pulls the inline <script> out at load time, rather than
// depending on a separately-extracted script.js that could go stale the
// next time the html changes.
const HTML_PATH = path.join(__dirname, '..', 'zub_cap_tracker.html');
const HTML_SRC = fs.readFileSync(HTML_PATH, 'utf8');
const SCRIPT_MATCH = HTML_SRC.match(/<script>([\s\S]*?)<\/script>/);
if (!SCRIPT_MATCH) throw new Error('Could not find inline <script> block in zub_cap_tracker.html');
const SRC = SCRIPT_MATCH[1];
const script = new vm.Script(SRC, { filename: 'zub_engine.js' });

// function declarations bind to the vm global object automatically, but
// `let`/`const` top-level bindings (state, DRAFT_POOL, CAP, SLOTS, ...) live
// in the context's global lexical environment only, not as properties of
// the sandbox object. Bridge the ones we need onto globalThis explicitly,
// from inside the context, so plain property access works from Node.
const NEEDED_NAMES = [
  'state', 'DRAFT_POOL', 'CAP', 'SLOTS', 'STARTER_REQ', 'POSITIONS',
  'RBWR_FLEX_TOTAL', 'LONG_TERM_PRICE_CEILING', 'EFFICIENCY_BAR',
  'BENCH_WEIGHT', 'EXECUTION', 'MY_TEAM_OWNER', 'CBS_AUCTION',
  'SEED_TEAMS_JSON', 'SEED_VERSION', 'REAL_FEES', 'BENCH_SLOTS',
];
const BRIDGE_SRC = 'globalThis.__b = {' +
  NEEDED_NAMES.map(n => `${n}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(',') +
  '};';
const bridgeScript = new vm.Script(BRIDGE_SRC, { filename: 'bridge.js' });

function freshEngine() {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);
  bridgeScript.runInContext(ctx);
  const b = ctx.__b;
  // functions declared with `function` at top level DO attach to the vm
  // global object, so ctx.vor, ctx.suggestedDollar etc. already work.
  return Object.assign(ctx, b);
}

module.exports = { freshEngine };
