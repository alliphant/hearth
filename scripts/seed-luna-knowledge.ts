/**
 * Seed Luna's day-1 knowledge — run once after hiring her.
 *
 *   bun run scripts/seed-luna-knowledge.ts [--force]
 *
 * Writes three ledgers under Knowledge/Luna/ in the vault:
 *
 *   - maintenance-cadence.md       a real, Pleasantville-anchored annual
 *                                  maintenance calendar (her starting
 *                                  knowledge — she refines it from here
 *                                  via update_luna_vault kind=cadence)
 *   - home-systems-inventory.md    template — TBD fields the household
 *                                  fills via nameplate captures + chat
 *   - service-providers.md         empty ledger, header only
 *
 * Idempotent: existing files are skipped unless --force. memory.md is
 * deliberately NOT seeded — the runtime's memory_files / her vault
 * writer create it in their own format on first append.
 *
 * On the box: ssh glacier, then
 *   docker exec hearth-orchestrator bun run scripts/seed-luna-knowledge.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const FORCE = process.argv.includes('--force');

const NOW = new Date().toISOString();

const CADENCE = `---
type: house_cadence
updated: ${NOW}
---

# Maintenance cadence

_Seeded ${NOW.slice(0, 10)} — Luna's starting calendar for a Pleasantville
(zone 5b, semi-arid, hail-prone, EPA radon zone 1) single-family home.
Luna refines this as the house teaches her; the full document is
re-emitted on every revision so it never decays into fragments._

## Recurring, interval-based

- **HVAC filter** — check monthly; replace every 60–90 days for 1"
  media (every 6–12 months for 4–5" media). Size/MERV: see inventory
  (TBD until a nameplate/label capture lands).
- **Smoke + CO detectors** — test buttons monthly; batteries at both
  DST changes (March + November); replace smoke units at 10 years,
  CO units at 5–7 years (date-of-manufacture on the back).
- **Water heater** — flush sediment annually (fall, with the furnace
  visit); check anode rod at year 3, then every 2 years. Install date:
  see inventory (TBD).
- **Garage door** — lubricate rollers/hinges/springs and run the
  safety-reverse test twice a year (spring + fall).
- **Dryer** — vacuum behind/under twice a year; deep-clean the full
  vent duct annually (lint duct fires are the boring catastrophe).
- **Refrigerator coils** — vacuum twice a year.
- **Garbage disposal + slow drains** — quarterly enzyme/ice-cube pass.
- **Fire extinguishers** — gauge check annually; note locations in
  inventory.
- **Radon** — test every 2 years (your county County is EPA zone 1; kits
  are cheap and the county periodically offers them discounted).
- **Sewer line** — if the lot has mature trees, camera-scope every
  3–5 years (root intrusion is common in older Pleasantville
  neighborhoods). Whether this applies: TBD in inventory.

## January – February

- Ice-dam watch after heavy snow; roof-rake the eaves above ~12" of
  accumulation.
- Watch furnace cycling behavior on the coldest nights (short-cycling
  is the early symptom worth a service call).
- Avoid magnesium-chloride deicer on concrete less than a year old;
  freeze-thaw spalling is the local concrete killer.

## March – April

- DST battery swap (detectors), part 1 of 2.
- Exterior caulk + weatherstripping walk once hard freezes taper —
  the dry winter shrinks seals.
- Gutter + downspout clean after spring winds; confirm downspout
  extensions discharge well away from the foundation BEFORE the
  spring/summer storm season.
- Window screens back in; screen repairs.
- Hoses back on the bibs only once overnight lows are reliably
  above freezing.

## May

- Sprinkler startup (after ~mid-May; an April startup gets bitten by
  a late freeze about every third year — Eleanor owns what the zones
  water, Luna owns that the system itself runs and doesn't leak).
- AC season prep: rinse the condenser coil, clear 2 ft of clearance,
  first cooling-season filter. AC tune-up visit (annual or biennial).
- Deck/fence stain + seal check — UV at altitude eats finishes fast.
- Mower/small-engine service.

## June – August (hail + monsoon season)

- **After any significant hail cell**: walk the exterior — roof from
  the ground or ladder line, gutters/downspouts for dents, window
  screens, AC condenser fins, skylights. Photograph anything
  questionable the same day (insurance documentation).
- During monsoon weeks: check the sump/crawlspace (if present — TBD)
  and the grading around the foundation after big rains.

## September

- **Furnace tune-up + first heating-season filter.** Book the visit
  in early September — Front Range HVAC calendars jam solid by
  October. Pair the water-heater flush with this visit.
- Roof + flashing inspection before snow.
- Door seals + weatherstripping check (part 2).
- Chimney sweep if wood-burning (TBD in inventory).

## October

- **Sprinkler blowout — the hard deadline.** Pleasantville' average
  first hard freeze lands in early October; book the blowout for
  late September/early October, never "sometime in fall." A missed
  blowout is a cracked manifold in spring.
- Hose bibs: disconnect hoses, drain, insulate covers on.
- Gutter clean after the main leaf drop (or early November).
- Winterize the evaporative/swamp cooler if present (TBD).

## November

- DST battery swap (detectors), part 2 of 2.
- Humidifier pad/service if the furnace has one (dry winter air —
  also the season door seals and wood trim suffer; note what needs
  spring attention).
- Draft walk on the first genuinely cold evening — feel the outlets,
  doors, and attic hatch.

## December

- Quiet month by design. Keep walks clear; watch the freeze-thaw.
- Year-end ledger pass: anything in the maintenance log that should
  move this calendar for next year?
`;

const INVENTORY = `---
type: house_inventory
updated: ${NOW}
---

# Home systems inventory

_Seeded ${NOW.slice(0, 10)} as a template. Most fields are TBD — they
fill in from appliance-nameplate photo captures (Cordelia routes them
to Luna), from service-visit paperwork, and from chat. Luna re-emits
this full document via update_luna_vault kind=inventory as facts land.
A TBD here is honest; a guess is not._

## Heating / cooling

- **Furnace** — brand/model: TBD · serial: TBD · install year: TBD ·
  filter size: TBD · last tune-up: TBD
- **AC / heat pump** — brand/model: TBD · serial: TBD · install year:
  TBD · last service: TBD
- **Thermostat** — model: TBD (HA-integrated? TBD)
- **Humidifier (furnace-mounted)** — present? TBD · pad size: TBD
- **Evaporative cooler** — present? TBD

## Water

- **Water heater** — type (tank/tankless): TBD · brand/model: TBD ·
  capacity: TBD · install year: TBD · last flush: TBD · anode last
  checked: TBD
- **Water softener** — present? TBD
- **Sump pump** — present? TBD · last tested: TBD
- **Main shutoff location** — TBD (everyone in the house should know)
- **Sprinkler backflow preventer location** — TBD

## Envelope

- **Roof** — material: TBD · age/installed: TBD · last inspection:
  TBD · hail claims history: TBD
- **Gutters** — guards? TBD · downspout extensions: TBD
- **Windows** — age/type: TBD
- **Crawlspace / basement** — type: TBD

## Appliances

- **Refrigerator** — brand/model: TBD · serial: TBD · purchase date /
  warranty: TBD
- **Range/oven** — fuel: TBD · brand/model: TBD · warranty: TBD
- **Dishwasher** — brand/model: TBD · warranty: TBD
- **Washer** — brand/model: TBD · warranty: TBD
- **Dryer** — fuel: TBD · brand/model: TBD · vent route: TBD
- **Microwave / hood** — brand/model: TBD · filter type: TBD
- **Garage door opener** — brand/model: TBD · install year: TBD

## Safety

- **Smoke detectors** — count/locations: TBD · manufacture dates: TBD
- **CO detectors** — count/locations: TBD · manufacture dates: TBD
- **Fire extinguishers** — count/locations: TBD · last gauge check: TBD
- **Radon** — last test: TBD · result: TBD · mitigation system? TBD

## Lot

- **Mature trees near sewer line** — TBD (decides the scope cadence)
- **Wood-burning fireplace/stove** — present? TBD
`;

const PROVIDERS = `# Service providers

Contractor and service-visit ledger — trade, who, what they did, and
whether we'd use them again. Rich contact detail (phone, address) lives
on the provider's Person note; this is the trade-history index. Newest
first; capped at 200 entries.

<!-- entries below -->
`;

const FILES: Array<{ rel: string; content: string }> = [
  { rel: 'Knowledge/Luna/maintenance-cadence.md', content: CADENCE },
  { rel: 'Knowledge/Luna/home-systems-inventory.md', content: INVENTORY },
  { rel: 'Knowledge/Luna/service-providers.md', content: PROVIDERS },
];

console.log(`Seeding Luna's knowledge into ${VAULT_ROOT}`);
for (const f of FILES) {
  const abs = resolve(VAULT_ROOT, f.rel);
  if (existsSync(abs) && !FORCE) {
    console.log(`  skip (exists): ${f.rel}`);
    continue;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, f.content, 'utf8');
  console.log(`  wrote: ${f.rel} (${f.content.length} bytes)`);
}
console.log('Done. The ingestor will pick the files up within ~1s.');
