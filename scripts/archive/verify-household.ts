import { UserRegistry } from '@core/users';
import { set_household_context } from '@core/household';
import { load_specialist_file } from '@core/specialist';
import { load_extra_capabilities } from '@core/capabilities';

// Match orchestrator boot order: extra capabilities first.
load_extra_capabilities('./config/capabilities.yaml');

const users = new UserRegistry();
const ctx = users.household_context();
console.log('Context built from users.yaml:');
console.log(JSON.stringify(ctx, null, 2));

set_household_context(ctx);

console.log('\n--- ANYA persona (first 400 chars, post-substitution) ---');
const anya = load_specialist_file('./config/specialists/anya.yaml');
console.log(anya.persona.slice(0, 400));

console.log('\n--- BRIGID — partner_name lines ---');
const brigid = load_specialist_file('./config/specialists/brigid.yaml');
brigid.persona.split('\n').filter((l) => l.includes('Sam') || l.includes('Sam')).slice(0, 4).forEach((l) => console.log('  ' + l.trim()));

console.log('\n--- ELEANOR — climate lines ---');
const eleanor = load_specialist_file('./config/specialists/eleanor.yaml');
eleanor.persona.split('\n').filter((l) => l.includes('Pleasantville') || l.includes('Zone')).slice(0, 4).forEach((l) => console.log('  ' + l.trim()));

console.log('\n--- IRIS — household_brand lines ---');
const iris = load_specialist_file('./config/specialists/iris.yaml');
iris.persona.split('\n').filter((l) => l.includes('FRIDAY')).slice(0, 3).forEach((l) => console.log('  ' + l.trim()));

console.log('\n--- LEAK CHECK: any unsubstituted {{token}} in bound personas? ---');
const specs = ['anya', 'brigid', 'cassandra', 'cordelia', 'eleanor', 'iris', 'kate', 'maggie', 'marguerite', 'mariah', 'trainer', 'vivian'];
for (const id of specs) {
  const s = load_specialist_file(`./config/specialists/${id}.yaml`);
  const leftover = s.persona.match(/\{\{[a-z_]+(?::[^}]*)?\}\}/g);
  if (leftover) {
    console.log(`  ${id}: unsubstituted tokens — ${[...new Set(leftover)].join(', ')}`);
  } else {
    console.log(`  ${id}: ✓ no unsubstituted tokens`);
  }
}
