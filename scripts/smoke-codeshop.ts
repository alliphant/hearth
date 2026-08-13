/**
 * smoke:codeshop — Code Shop settings (secret-safe) + git-config resolver +
 * the codeshop pane composer. Offline; no orchestrator, no git, no network.
 *
 *   bun run smoke:codeshop
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { resolve_git_config } from '@specialists/trainer/change_pipeline';
import { compose_codeshop_pane, type PaneBlock } from '@core/specialist_pane';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-codeshop-'));
const db = open_db(join(dir, 'codeshop.db'));

try {
  const s = new CodeShopSettings(db);

  // ── Secret safety ────────────────────────────────────────────────────────
  s.set({ gitea_token: 'secret-tok-123', gitea_owner: 'jasper', gitea_repo: 'hearth-private', paused: false });
  check('get() exposes the token to the resolver', s.get().gitea_token === 'secret-tok-123');
  const red = s.get_redacted() as Record<string, unknown>;
  check('get_redacted() NEVER returns the token value', !('gitea_token' in red) && red.gitea_token_set === true);
  check('get_redacted() reports an unset secret as false', red.github_token_set === false);

  // A form re-submit with a blank token must NOT clobber the stored secret.
  s.set({ gitea_token: '', paused: true });
  check('blank token on set() keeps the prior secret', s.get().gitea_token === 'secret-tok-123');
  check('non-secret field still updates alongside', s.get().paused === true);

  // Explicit clear.
  s.clear_secret('gitea_token');
  check('clear_secret() removes the token', s.get().gitea_token === '');

  // ── Resolver precedence (settings → env → default) ───────────────────────
  s.set({ gitea_token: 'tok-resolver', gitea_base_url: 'http://gitea.example', merge_method: 'squash' });
  const git = resolve_git_config(db);
  check('resolver picks up the gear token', git.gitea_token === 'tok-resolver');
  check('resolver picks up the gear base_url', git.gitea_base_url === 'http://gitea.example');
  check('resolver carries merge_method', git.merge_method === 'squash');

  // ── Pane composer ────────────────────────────────────────────────────────
  // The codeshop pane wraps its content in a top-level `tabs` block; the office
  // content the assertions below check for lives inside the 'office' tab.
  type TabsBlock = { type: 'tabs'; tabs: Array<{ id: string; blocks: PaneBlock[] }> };
  function office_blocks(pane: ReturnType<typeof compose_codeshop_pane>): PaneBlock[] {
    const tabs = pane.blocks.find((b) => b.type === 'tabs') as TabsBlock | undefined;
    return tabs?.tabs.find((t) => t.id === 'office')?.blocks ?? [];
  }

  // Empty board.
  const empty = compose_codeshop_pane(db);
  const emptyOffice = office_blocks(empty);
  check('pane_kind is codeshop', empty.pane_kind === 'codeshop');
  check('empty board shows an "all clear" hero', emptyOffice.some((b) => b.type === 'hero_metric' && /clear|paused/i.test((b as { value: string }).value)));
  check('pane always has the dev-metrics block', emptyOffice.some((b) => b.type === 'list' && /Dev metrics/.test((b as { title?: string }).title ?? '')));

  // A change awaiting the owner's merge → approve link + hero count.
  const store = new ChangeRecordsStore(db);
  const c = store.create({
    origin: 'apply_low_risk_fix', change_kind: 'config', target_specialist_id: 'kristi',
    branch: 'beatrice/test', pr_number: 7, pr_url: 'http://gitea/pr/7', files: ['config/specialists/kristi.yaml'],
    lines_added: 3, lines_removed: 1, languages: ['YAML'], diff_summary: '+x', rationale_md: 'surface a tool',
  });
  store.set_kate_verdict(c.id, 'approve', 'looks safe and well-scoped');
  store.attach_proposal(c.id, 'prop_abc');
  const live = compose_codeshop_pane(db);
  const liveOffice = office_blocks(live);
  check('hero reflects the pending-merge count', liveOffice.some((b) => b.type === 'hero_metric' && /awaiting your merge/.test((b as { value: string }).value)));
  check('approve-&-merge link carries codeshop:merge:<proposal_id>', liveOffice.some((b) => b.type === 'link' && (b as { deep_link: string }).deep_link === 'codeshop:merge:prop_abc'));
  check('"Awaiting your merge" list present', liveOffice.some((b) => b.type === 'list' && (b as { title?: string }).title === 'Awaiting your merge'));

  // Metrics block has the three deep-dive items (code / tokens / est. electricity).
  const metrics = liveOffice.find((b) => b.type === 'list' && /Dev metrics/.test((b as { title?: string }).title ?? '')) as { items: Array<{ title: string }> } | undefined;
  check('metrics block has code/tokens/electricity items', !!metrics && metrics.items.length === 3 && metrics.items.some((i) => /electricity/i.test(i.title)));
} finally {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} codeshop assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Code Shop assertions passed.');
