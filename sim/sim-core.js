// Fast headless Monte Carlo simulator for the ZUB auction draft.
// Deliberately does NOT call the app's own walkAwayPrice/bestLineupFrom in
// the hot loop (benchmarked at ~1.3s per player on a cold cache -- fine for
// a live UI slider, unusable for thousands of bid evaluations). Instead it
// reimplements the same economic idea -- marginal starting-lineup value
// above replacement, cap-constrained -- with a cheap greedy fill, and
// reuses the app's own vor()/lineupValue()/effMaxLegalBid() etc directly
// wherever those ARE cheap and safe to call repeatedly.

const { freshEngine } = require('./load.js');

// ---------- seeded RNG (mulberry32) so a replicate is reproducible and so
// the same underlying draws can seed multiple strategy variants ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng, mean, sd) {
  const u1 = Math.max(1e-9, rng()), u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---------- persona archetypes for the 11 rival teams ----------
// These are baselines, not fixed values -- every team gets its OWN jittered
// draw around its persona's baseline (drawTeamPersonality below), so no two
// "rational" bidders in the same room actually behave identically. That's
// the "not the same logic applied to every member" ask: persona sets the
// pattern, per-team jitter sets the individual, per-bid noise sets the mood.
const PERSONAS = ['rational', 'namechaser', 'hoarder', 'passive', 'panicker'];

const PERSONA_PARAMS = {
  rational:   { bar: 0.32, noiseSd: 0.08, marketBlend: 0.10 },
  namechaser: { bar: 0.18, noiseSd: 0.15, marketBlend: 0.65 }, // pays for the name
  hoarder:    { bar: 0.30, noiseSd: 0.12, marketBlend: 0.15 }, // loosens further if already stacked, below
  passive:    { bar: 0.55, noiseSd: 0.10, marketBlend: 0.05 },
  panicker:   { bar: 0.30, noiseSd: 0.10, marketBlend: 0.10 }, // occasional max-bid spike, below
};

const NOMINATION_STYLES = ['value', 'need', 'gut'];

// Draw one rival team's individual personality for this replicate: their
// persona sets a baseline, but the actual numbers are jittered per-team, and
// they get their own nomination habit and their own chance of an
// uncharacteristic "human" moment (wildcardChance) where they act like a
// totally different persona for a single bid.
function drawTeamPersonality(rng, personaKey) {
  const base = PERSONA_PARAMS[personaKey];
  const nomRoll = rng();
  const nominationStyle = nomRoll < 0.55 ? 'value' : (nomRoll < 0.80 ? 'need' : 'gut');
  return {
    personaKey,
    bar: Math.max(0.08, gaussian(rng, base.bar, base.bar * 0.20)),
    noiseSd: Math.max(0.03, gaussian(rng, base.noiseSd, base.noiseSd * 0.30)),
    marketBlend: Math.min(1, Math.max(0, gaussian(rng, base.marketBlend, 0.07))),
    nominationStyle,
    wildcardChance: 0.05 + rng() * 0.07, // 5-12%, varies by team
  };
}

function assignPersonalities(rng, teamCount, blakeIdx) {
  const out = new Array(teamCount);
  for (let i = 0; i < teamCount; i++) {
    if (i === blakeIdx) { out[i] = null; continue; }
    out[i] = drawTeamPersonality(rng, pick(rng, PERSONAS));
  }
  return out;
}

// A fixed slot-fill order for the cheap greedy lineup evaluation, matching
// the app's own SEED_ORDERS[0] so the "which slot gets priority" heuristic
// is consistent with production.
const FILL_ORDER = ['RB1', 'WRTE1', 'RB2', 'WRTE2', 'FLEX', 'QB', 'PK', 'DST'];

// Cheap greedy: given a list of {name,pos} and the app's SLOTS definition,
// return total VOR of the best 8-man starting lineup reachable by filling
// slots in FILL_ORDER, best-available-by-vor each time. Not exhaustive
// (no swap search), but that is fine here: it only needs to be directionally
// correct and consistent across candidates within one bid evaluation.
function greedyStarterValue(ctx, players, slotsDef) {
  const bySlot = {};
  slotsDef.forEach(s => { bySlot[s.key] = s; });
  const used = new Set();
  let total = 0;
  for (const key of FILL_ORDER) {
    const slot = bySlot[key];
    if (!slot) continue;
    let best = null, bestV = -Infinity;
    for (const p of players) {
      if (used.has(p.name)) continue;
      if (!slot.eligible.includes(p.pos)) continue;
      const v = ctx.vor(p);
      if (v > bestV) { bestV = v; best = p; }
    }
    if (best) { used.add(best.name); total += bestV; }
  }
  return total;
}

function heldPlayersFor(ctx, teamIdx, wonThisRoom) {
  const real = ctx.state.teams[teamIdx].players
    .filter(p => !p.deadCap)
    .map(p => ({ name: p.name, pos: p.pos }));
  const won = (wonThisRoom[teamIdx] || []).map(p => ({ name: p.name, pos: p.pos }));
  return real.concat(won);
}

function posCountHeld(held, pos) {
  return held.filter(p => p.pos === pos).length;
}

// Blake strategy variants under test. Each returns a target VOR-per-dollar
// bar and whether to use lineup-fit-aware marginal value (true) or raw
// player VOR with no roster-construction discount (false), and whether to
// anchor partly on market price ("chasing the name") instead of pure value.
const BLAKE_STRATEGIES = {
  walkaway:          { bar: 0.30, marginal: true,  marketBlend: 0.05, longTermDiscipline: true },
  efficiency_only:   { bar: 0.30, marginal: false, marketBlend: 0.05, longTermDiscipline: true },
  aggressive_yellow: { bar: 0.30, marginal: true,  marketBlend: 1.15, longTermDiscipline: false, marketMultiplier: 1.15 },
  // Formalizes Blake's stated core belief: pay up disproportionately for
  // players who clear a HIGH marginal-value bar (stars), and get stingier
  // than baseline on everyone else (scrubs) rather than spreading evenly.
  stars_and_scrubs:  { bar: 0.30, marginal: true, marketBlend: 0.05, longTermDiscipline: true, starPremium: true },
};

// Real drafters don't sit on cap, unspent money is worthless once the draft
// ends. This measures how far behind pace a team is (fraction of slots
// filled vs fraction of their draft-day budget spent) and returns a
// multiplier that pushes their ceiling up when they're hoarding relative to
// how far through their own roster they are. Without this, low-bar personas
// (passive especially) just kept winning $1 scraps and finished with $40-70
// of cap stranded, which nobody actually does.
function paceUrgencyMultiplier(teamIdx, wonThisRoom, initialSlots, initialCap) {
  const total = initialSlots[teamIdx];
  const budget = initialCap[teamIdx];
  if (total <= 0 || budget <= 0) return 1;
  const filled = (wonThisRoom[teamIdx] || []).length;
  const spent = (wonThisRoom[teamIdx] || []).reduce((s, p) => s + p.price, 0);
  const targetFrac = filled / total;
  const actualFrac = spent / budget;
  const behind = Math.max(0, targetFrac - actualFrac);
  // late in their own draft (few slots left) the same "behind" gap matters
  // more -- there's less runway left to fix it -- so weight it by progress
  const lateness = filled / total;
  return 1 + behind * (5 + lateness * 10);
}

// Belt-and-suspenders on top of the multiplier above: with 3 or fewer slots
// left, if a team still has real slack (meaningfully more cap than the bare
// $1-per-remaining-slot minimum), stop letting value calculations leave it
// stranded and force the ceiling to actually chase it down.
function lateSlackFloor(ctx, teamIdx) {
  const openSlots = ctx.effOpenSlots(teamIdx);
  if (openSlots > 3 || openSlots <= 0) return 0;
  const capLeft = ctx.effCapLeft(teamIdx, ctx.state.currentYear);
  const bareMin = Math.max(0, openSlots - 1);
  const slack = capLeft - bareMin;
  if (slack <= 6) return 0; // not enough slack to bother forcing
  // spread most of the slack across the remaining picks rather than saving
  // it all for the very last one
  return Math.round(bareMin + slack * 0.7);
}

// Market-wide behavioral ceiling: in this room, essentially nobody goes
// above $35 for a single player, and $38 is treated as the rare outer edge,
// independent of what a pure value calculation would legally allow. This is
// a norm of the room, not a per-team preference, so it applies to every
// bidder the same way (Blake included).
function marketWideCeiling(rng) {
  return rng() < 0.85 ? 35 : 35 + Math.round(rng() * 3); // 85% capped at 35, rest 35-38
}

function teamCeiling(ctx, teamIdx, player, held, opts, rng) {
  // opts: { isBlake, blakeStrategyKey, personality }
  const { isBlake } = opts;

  // Hard position caps: only 1 starter + 1 bench cover for PK/DST/QB.
  if ((player.pos === 'PK' || player.pos === 'DST' || player.pos === 'QB') && posCountHeld(held, player.pos) >= 2) return 0;

  let params;
  if (isBlake) {
    params = BLAKE_STRATEGIES[opts.blakeStrategyKey];
  } else {
    // "human randomness": most bids use this team's own jittered baseline,
    // but every so often (their own wildcardChance) they act like a
    // completely different archetype for just this one bid -- an
    // uncharacteristic overpay, an uncharacteristic pass, etc.
    let effective = opts.personality;
    if (rng() < opts.personality.wildcardChance) {
      const otherKey = pick(rng, PERSONAS);
      const otherBase = PERSONA_PARAMS[otherKey];
      effective = { ...opts.personality, bar: otherBase.bar, marketBlend: otherBase.marketBlend, personaKey: otherKey + '(wildcard)' };
    }
    params = effective;
  }

  const slotsDef = ctx.SLOTS;
  let value;
  if (!isBlake || params.marginal) {
    const before = greedyStarterValue(ctx, held, slotsDef);
    const after = greedyStarterValue(ctx, held.concat([{ name: player.name, pos: player.pos }]), slotsDef);
    let marginal = after - before;
    if (marginal < 0.05) {
      // didn't crack the starting eight -- still worth a little as bench
      // depth if a bench spot of the right shape is actually open
      marginal = ctx.vor(player) * ctx.BENCH_WEIGHT;
    }
    value = marginal;
  } else {
    // efficiency_only: raw VOR, no lineup-fit discount at all
    value = ctx.vor(player);
  }

  let bar = params.bar;
  if (!isBlake && (params.personaKey === 'hoarder' || (params.personaKey || '').startsWith('hoarder'))) {
    // gets MORE willing to overpay the more they already hold at this pos --
    // irrational stacking behavior, part of the "hostile room" mix
    bar = bar / (1 + 0.18 * posCountHeld(held, player.pos));
  }
  if (isBlake && params.starPremium) {
    // stars_and_scrubs: a genuine starter-caliber upgrade gets a much lower
    // (more aggressive) bar; anything that's really just bench filler gets
    // a noticeably higher (stingier) bar than baseline walkaway.
    bar = value >= 4 ? params.bar * 0.55 : params.bar * 1.35;
  }

  const market = ctx.suggestedDollar(player.mv, player.pos, player.name);
  let ceilingFromValue = bar > 0 ? value / bar : 0;

  const marketMult = (isBlake && params.marketMultiplier) ? params.marketMultiplier : 1.0;
  const marketAnchor = market * marketMult * (0.9 + 0.2 * rng());
  const blend = params.marketBlend ?? 0.1;
  let ceiling = ceilingFromValue * (1 - blend) + marketAnchor * blend;

  // per-bid noise: persona-level for rivals, small execution noise for Blake
  const noiseSd = isBlake ? 0.04 : (params.noiseSd ?? 0.1);
  ceiling *= Math.max(0.5, 1 + gaussian(rng, 0, noiseSd));

  // panicker: rare max-bid spike
  if (!isBlake && (params.personaKey === 'panicker' || (params.personaKey || '').startsWith('panicker')) && rng() < 0.12) {
    ceiling = Math.max(ceiling, ctx.effMaxLegalBid(teamIdx) * 0.9);
  }

  // Blake's long-term discipline rule: never let the ceiling imply a price
  // that would look silly on a long-term deal (LONG_TERM_PRICE_CEILING).
  // Modeled here as a soft cap on how far above market he'll go.
  if (isBlake && params.longTermDiscipline) {
    ceiling = Math.min(ceiling, market * 1.6 + 3);
  }

  // Spend-down pressure: unspent cap is dead money. Blake's own goal is
  // tighter than the room norm (finish at $1-5, ideally $1-2, vs everyone
  // else's looser "under $10"), so his multiplier is stronger.
  const urgency = paceUrgencyMultiplier(teamIdx, opts.wonThisRoom, opts.initialSlots, opts.initialCap);
  ceiling *= isBlake ? Math.pow(urgency, 1.35) : urgency;
  ceiling = Math.max(ceiling, lateSlackFloor(ctx, teamIdx));

  ceiling = Math.max(0, Math.round(ceiling));
  // A team that genuinely has an open slot this player fills will still take
  // him for a dollar over leaving the slot empty, even at ~zero marginal
  // value. Without this floor, replacement-level players got discarded by
  // resolveAuction (no bids) instead of filling anyone's bench, and the room
  // stalled well short of every roster being full.
  ceiling = Math.max(ceiling, 1);
  // Room-wide behavioral norm: essentially nobody pays past $35-38 for one
  // player, regardless of what a pure value calc would allow.
  ceiling = Math.min(ceiling, marketWideCeiling(rng));
  return Math.min(ceiling, ctx.effMaxLegalBid(teamIdx));
}

// Roster composition assumption for every team (not just Blake's): of 18
// total spots, exactly 2 QB, 2 DST, 2 PK, and the other 12 split across
// RB/WR/TE with a floor of 3 RB and 3 WR and NO floor on TE. A TE only gets
// rostered when he's genuinely the best value for one of those 12 slots,
// never because the roster construction requires one.
const FLEX_BUDGET = 12;
const MIN_RB = 3;
const MIN_WR = 3;

function flexBudgetAllows(ctx, teamIdx, pos, wonThisRoom) {
  const held = heldPlayersFor(ctx, teamIdx, wonThisRoom);
  const counts = { RB: 0, WR: 0, TE: 0 };
  held.forEach(p => { if (counts[p.pos] !== undefined) counts[p.pos]++; });
  const used = counts.RB + counts.WR + counts.TE;
  const remainingBefore = FLEX_BUDGET - used;
  if (remainingBefore <= 0) return false; // flex budget already full
  const remainingAfter = remainingBefore - 1;
  const neededRBAfter = Math.max(0, MIN_RB - counts.RB - (pos === 'RB' ? 1 : 0));
  const neededWRAfter = Math.max(0, MIN_WR - counts.WR - (pos === 'WR' ? 1 : 0));
  // block anything that would make hitting the RB/WR minimums impossible
  // with the flex slots that would remain -- this is what actually keeps TE
  // from being force-filled: once slots left == RB/WR still owed, TE (and
  // any "extra" RB/WR beyond the minimum) stops being eligible
  return remainingAfter >= neededRBAfter + neededWRAfter;
}

function teamCanUse(ctx, teamIdx, player, wonThisRoom) {
  if (ctx.effOpenSlots(teamIdx) <= 0) return false;
  // Exactly 2 max at QB/PK/DST -- 1 starter + 1 bench, same treatment for
  // all three, matching the assumed 18-man composition.
  if (player.pos === 'PK' || player.pos === 'DST' || player.pos === 'QB') {
    const held = heldPlayersFor(ctx, teamIdx, wonThisRoom);
    if (posCountHeld(held, player.pos) >= 2) return false;
    return true;
  }
  if (player.pos === 'RB' || player.pos === 'WR' || player.pos === 'TE') {
    return flexBudgetAllows(ctx, teamIdx, player.pos, wonThisRoom);
  }
  return true;
}

// Resolve one nomination via closed-form second-price English auction:
// everyone eligible submits a ceiling; highest wins, pays second-highest+1
// (floored at $1, capped at their own legal max).
function resolveAuction(ctx, nominee, personalities, blakeStrategyKey, wonThisRoom, rng, blakeIdx, initialSlots, initialCap) {
  const bids = [];
  for (let i = 0; i < ctx.state.teams.length; i++) {
    if (!teamCanUse(ctx, i, nominee, wonThisRoom)) continue;
    const held = heldPlayersFor(ctx, i, wonThisRoom);
    const isBlake = i === blakeIdx;
    const opts = isBlake
      ? { isBlake: true, blakeStrategyKey, wonThisRoom, initialSlots, initialCap }
      : { isBlake: false, personality: personalities[i], wonThisRoom, initialSlots, initialCap };
    const ceil = teamCeiling(ctx, i, nominee, held, opts, rng);
    if (ceil >= 1) bids.push({ teamIdx: i, ceil });
  }
  if (!bids.length) return null; // nobody wants him at any legal price right now
  bids.sort((a, b) => b.ceil - a.ceil);
  const winner = bids[0];
  const second = bids.length > 1 ? bids[1].ceil : 0;
  let price = Math.max(1, Math.min(winner.ceil, second + 1));

  // Pure second-price resolution can leave a team's real willingness unpaid
  // when nobody else happens to be bidding on this particular player, which
  // is fine mid-draft but not how real rooms behave late: sitting on unused
  // cap once the draft ends is worthless, so a team deep into its own board
  // with real slack tends to just pay close to what it's willing to rather
  // than pocket a discount nobody made them take.
  const openSlots = ctx.effOpenSlots(winner.teamIdx);
  const capLeft = ctx.effCapLeft(winner.teamIdx, ctx.state.currentYear);
  if (openSlots <= 4 && capLeft - Math.max(0, openSlots - 1) > 8) {
    price = Math.max(price, Math.round(winner.ceil * 0.75));
  }
  price = Math.max(1, Math.min(price, winner.ceil, ctx.effMaxLegalBid(winner.teamIdx)));
  return { teamIdx: winner.teamIdx, price };
}

// ---------- nomination: round-robin by team, each team picks according to
// their own nomination style, not a single global rule ----------
function biggestNeedPositions(ctx, teamIdx, wonThisRoom, rng) {
  const held = heldPlayersFor(ctx, teamIdx, wonThisRoom);
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, PK: 0, DST: 0 };
  held.forEach(p => { if (counts[p.pos] !== undefined) counts[p.pos]++; });
  const needs = [];
  // 2 QB / 2 PK / 2 DST is the assumed full composition, actively chase both,
  // not just the first one
  if (counts.QB < 2) needs.push('QB');
  if (counts.PK < 2) needs.push('PK');
  if (counts.DST < 2) needs.push('DST');
  // RB and WR have a real floor (3 each) worth actively chasing. TE has no
  // floor -- it's deliberately absent here so a "need"-driven nominator
  // never goes looking for a TE, only 'value'/'gut' nominations or a
  // genuinely great greedyStarterValue pick ever lands one.
  if (counts.RB < MIN_RB) needs.push('RB');
  if (counts.WR < MIN_WR) needs.push('WR');
  return needs;
}

function chooseNominee(ctx, pool, teamIdx, wonThisRoom, rng, style) {
  // pool is pre-sorted by vorRaw descending. 'value' is the common case
  // (55% of nominations) and only ever needs the FIRST eligible player, so
  // it gets a fast path instead of always building a wider candidate list.
  if (style === 'value') {
    for (let idx = 0; idx < pool.length; idx++) {
      let anyoneWants = false;
      for (let i = 0; i < ctx.state.teams.length; i++) {
        if (teamCanUse(ctx, i, pool[idx], wonThisRoom)) { anyoneWants = true; break; }
      }
      if (anyoneWants) return idx;
      pool.splice(idx, 1); // nobody in the room can ever use him again (PK/DST caps only tighten)
      idx--;
    }
    return -1;
  }

  const eligibleIdxs = [];
  const capNeeded = style === 'gut' ? 25 : 60;
  for (let idx = 0; idx < pool.length; idx++) {
    let anyoneWants = false;
    for (let i = 0; i < ctx.state.teams.length; i++) {
      if (teamCanUse(ctx, i, pool[idx], wonThisRoom)) { anyoneWants = true; break; }
    }
    if (anyoneWants) {
      eligibleIdxs.push(idx);
      if (eligibleIdxs.length >= capNeeded) break;
    } else {
      pool.splice(idx, 1);
      idx--;
    }
  }
  if (!eligibleIdxs.length) return -1;

  if (style === 'need') {
    const needs = biggestNeedPositions(ctx, teamIdx, wonThisRoom, rng);
    if (needs.length) {
      const match = eligibleIdxs.find(idx => needs.includes(pool[idx].pos));
      if (match !== undefined) return match;
    }
    return eligibleIdxs[0]; // starters covered, fall back to best available
  }
  if (style === 'gut') {
    // a real, semi-unpredictable "personal favorite" pick from a wide band,
    // weighted toward the better players but genuinely capable of surprises
    const band = eligibleIdxs.slice(0, Math.min(25, eligibleIdxs.length));
    const weights = band.map((_, i) => 1 / (i + 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < band.length; i++) {
      r -= weights[i];
      if (r <= 0) return band[i];
    }
    return band[band.length - 1];
  }
  // 'value' (default): straightforward best player left
  return eligibleIdxs[0];
}

function nextOpenTeam(ctx, startPtr) {
  const n = ctx.state.teams.length;
  for (let step = 0; step < n; step++) {
    const idx = (startPtr + step) % n;
    if (ctx.effOpenSlots(idx) > 0) return idx;
  }
  return -1;
}

// Run one full simulated auction room. blakeStrategy is a key into
// BLAKE_STRATEGIES. seed drives persona assignment + all noise/nomination
// draws, and is reused across strategy variants for a paired design.
function runRoom(seed, blakeStrategy) {
  const ctx = freshEngine();
  const rng = mulberry32(seed);
  const blakeIdx = ctx.teamIdxOf(ctx.MY_TEAM_OWNER);
  const personalities = assignPersonalities(rng, ctx.state.teams.length, blakeIdx);

  const wonThisRoom = {}; // teamIdx -> [{name,pos,price}]
  for (let i = 0; i < ctx.state.teams.length; i++) wonThisRoom[i] = [];

  // snapshot each team's draft-day budget/slots BEFORE any picks, used to
  // measure spend-down pace through the room
  const initialSlots = ctx.state.teams.map((t, i) => ctx.effOpenSlots(i));
  const initialCap = ctx.state.teams.map((t, i) => ctx.effCapLeft(i, ctx.state.currentYear));

  // sorted once; vorRaw doesn't change during a room, only availability does
  const pool = ctx.availablePool().slice().sort((a, b) => ctx.vorRaw(b) - ctx.vorRaw(a));

  let guard = 0;
  const maxPicks = 260;
  let nominatorPtr = 0;
  while (guard++ < maxPicks) {
    const teamIdx = nextOpenTeam(ctx, nominatorPtr);
    if (teamIdx === -1) break; // every roster full
    nominatorPtr = teamIdx + 1;

    const style = teamIdx === blakeIdx ? 'value' : personalities[teamIdx].nominationStyle;
    const idx = chooseNominee(ctx, pool, teamIdx, wonThisRoom, rng, style);
    if (idx === -1) break; // pool exhausted of anything anyone can use

    const nominee = pool[idx];
    const result = resolveAuction(ctx, nominee, personalities, blakeStrategy, wonThisRoom, rng, blakeIdx, initialSlots, initialCap);
    pool.splice(idx, 1); // he's off the board either way
    if (!result) continue; // shouldn't happen given chooseNominee's filter, but be safe
    wonThisRoom[result.teamIdx].push({ name: nominee.name, pos: nominee.pos, mv: nominee.mv, price: result.price });
    ctx.state.draftPicks.push({
      id: guard, name: nominee.name, pos: nominee.pos, mv: nominee.mv,
      price: result.price, length: 1, teamIdx: result.teamIdx,
      suggested: ctx.suggestedDollar(nominee.mv, nominee.pos, nominee.name),
    });
    if (process.env.SIM_TRACE_TEAM !== undefined && result.teamIdx === Number(process.env.SIM_TRACE_TEAM)) {
      console.error(`pick#${guard} won ${nominee.name}(${nominee.pos}) $${result.price}  openSlots->${ctx.effOpenSlots(result.teamIdx)} capLeft->${ctx.effCapLeft(result.teamIdx, ctx.state.currentYear)}`);
    }
  }

  // ---- final accounting for every team ----
  const teamResults = ctx.state.teams.map((t, i) => {
    const held = ctx.state.teams[i].players.filter(p => !p.deadCap).map(p => ({ name: p.name, pos: p.pos }));
    const won = wonThisRoom[i].map(p => ({ name: p.name, pos: p.pos }));
    const all = held.concat(won);
    const lv = ctx.lineupValue(all);
    const spend = wonThisRoom[i].reduce((s, p) => s + p.price, 0);
    const posSpend = { QB: 0, RB: 0, WR: 0, TE: 0, PK: 0, DST: 0 };
    wonThisRoom[i].forEach(p => { if (posSpend[p.pos] !== undefined) posSpend[p.pos] += p.price; });
    const posCount = { QB: 0, RB: 0, WR: 0, TE: 0, PK: 0, DST: 0 };
    all.forEach(p => { if (posCount[p.pos] !== undefined) posCount[p.pos]++; });
    return {
      owner: t.owner, teamIdx: i,
      starterValue: lv.starters, totalValue: lv.total, benchValue: lv.total - lv.starters,
      spend, picksWon: wonThisRoom[i].length, posSpend, posCount,
      capLeft: ctx.effCapLeft(i, ctx.state.currentYear),
      openSlotsLeft: ctx.effOpenSlots(i),
      personaMixNote: i === blakeIdx ? 'blake' : personalities[i].personaKey,
    };
  });

  teamResults.sort((a, b) => b.starterValue - a.starterValue);
  teamResults.forEach((r, rank) => { r.rank = rank + 1; });
  const blake = teamResults.find(r => r.teamIdx === blakeIdx);

  // room-composition summary, useful for the sensitivity/robustness slice
  const personaCounts = {};
  personalities.forEach(p => { if (p) personaCounts[p.personaKey] = (personaCounts[p.personaKey] || 0) + 1; });

  return { blake, teamResults, totalPicks: guard, personaCounts, allPicks: ctx.state.draftPicks.slice() };
}

module.exports = { runRoom, BLAKE_STRATEGIES, PERSONAS };
