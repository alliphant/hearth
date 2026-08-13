/**
 * smoke:arr — read-only test of the Sonarr/Radarr/Lidarr/Readarr connector.
 *
 * For each app with an API key configured in the environment it exercises
 * media_library (status / library / queue) and media_search. An app with
 * no key is skipped cleanly. media_add is deliberately NOT tested — it
 * would add real downloads.
 *
 * Search depends on each app's upstream metadata provider; when that is
 * down (Readarr's Goodreads source is a known-broken example) the search
 * check skips rather than fails — that is upstream, not a connector bug.
 *
 * Needs the *arr apps reachable (they live on your-llm-host.local).
 *
 *   bun run smoke:arr
 */
import { media_search, media_library } from '@connectors/arr';
import type { ToolContext } from '@core/tool';

let failures = 0;
let skips = 0;
let apps_run = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
function skip(label: string): void {
  console.log(`SKIP  ${label}`);
  skips++;
}

const ctx = {} as ToolContext;
const APPS = [
  { id: 'sonarr', key: 'SONARR_API_KEY', term: 'Breaking Bad' },
  { id: 'radarr', key: 'RADARR_API_KEY', term: 'Inception' },
  { id: 'lidarr', key: 'LIDARR_API_KEY', term: 'Radiohead' },
  { id: 'readarr', key: 'READARR_API_KEY', term: 'Brandon Sanderson' },
] as const;

for (const app of APPS) {
  if (!process.env[app.key]) {
    skip(`${app.id} — no ${app.key} set`);
    continue;
  }
  apps_run++;

  // status — proves the URL + key reach a live *arr API.
  const status = await media_library.execute({ app: app.id, view: 'status' }, ctx);
  check(
    `${app.id}: media_library(status) reached the app`,
    !status.error && status.summary.length > 0,
  );
  if (status.error) {
    console.log(`      ${status.error}`);
    continue; // app unreachable — skip its remaining checks
  }

  // library — a real read of everything added.
  const lib = await media_library.execute({ app: app.id, view: 'library' }, ctx);
  check(
    `${app.id}: media_library(library) returned a count`,
    !lib.error && typeof lib.count === 'number',
  );

  // queue — a paged endpoint; exercises the records-vs-array unwrap.
  const queue = await media_library.execute({ app: app.id, view: 'queue' }, ctx);
  check(`${app.id}: media_library(queue) ok`, !queue.error);

  // search — a lookup. Hits depend on the app's metadata provider; an
  // error or empty result is upstream, not a connector bug, so skip it.
  const search = await media_search.execute({ app: app.id, term: app.term }, ctx);
  if (search.error) {
    skip(`${app.id}: media_search — upstream lookup unavailable`);
    console.log(`      ${search.error.slice(0, 120)}`);
  } else if (search.results.length === 0) {
    skip(`${app.id}: media_search("${app.term}") — 0 results (upstream metadata?)`);
  } else {
    check(`${app.id}: media_search("${app.term}") returned results`, true);
    const r = search.results[0]!;
    check(
      `${app.id}: search result carries an id + title`,
      r.id.length > 0 && r.title.length > 0,
    );
  }
}

if (apps_run === 0) {
  console.log('\nsmoke:arr — all apps skipped (no API keys configured)');
  process.exit(0);
}
console.log(
  failures === 0
    ? `\nsmoke:arr OK${skips ? ` (${skips} skipped)` : ''}`
    : `\nsmoke:arr FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
