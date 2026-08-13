/**
 * Moving an archived item's files — the ONE set of filesystem primitives for
 * re-shelving media on the NAS, shared by the two paths that do it:
 *
 *  - the WRITE path: `apply_final_cordon` below, called from the runner's filing
 *    phase when the final keyframe verdict flips an item explicit after the
 *    download already landed in the open tree (the folder is chosen at classify
 *    time from the pre-download thumbnail — it has to be, the download must know
 *    where to write — so the final verdict can disagree with the shelf);
 *  - the REPAIR path: `rescan_media_metadata` facet:'taxonomy', which re-files
 *    legacy/misfiled items against `media_canonical_path`.
 *
 * These lived as module-locals inside the rescan tool until the runner needed
 * the same moves; two copies of "move an item's files without eating someone
 * else's" is the same class of defect as two copies of the cordon rule.
 *
 * Every mover here shares the invariants the repair path established:
 *  - containment (`safe_archive_abs`) — nothing outside the archive root is
 *    ever read, written or deleted;
 *  - ownership (`media_entry_belongs_to`) — the unit of a move is the ITEM's
 *    entries, never a directory that legitimately holds other items' files;
 *  - never overwrite — a destination that already exists is left alone (an
 *    interrupted earlier run, or pathologically a duplicate id: either way the
 *    safe read is "both stay");
 *  - idempotence — re-running any move finds the files already at the target
 *    and does nothing, which is what makes a crash between "bytes moved" and
 *    "paths rewritten" recoverable instead of stranding.
 */
import { dirname, join, resolve, sep } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import {
  media_canonical_entry_name,
  media_dir_of,
  media_entry_belongs_to,
  media_is_private_path,
  media_normalize_path,
  MEDIA_PRIVATE_SEGMENT,
} from './taxonomy';
import type { MediaDownloadResult } from './types';

/** Resolve an archive-relative path, clamped inside the root (null = escapes). */
export function safe_archive_abs(archive_root: string, rel: string): string | null {
  const root = resolve(archive_root);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // containment
  return abs;
}

/**
 * Every on-disk entry that belongs to ONE item, paired with the name it should
 * have when the move is done.
 *
 * The unit of a move is the item's FILES, not the directory — a taxonomy
 * directory legitimately holds several items (that is the point of grouping), so
 * moving the directory would drag its neighbours along. Every artefact of an item
 * shares its stem: `<stem>.mp4`, `<stem>.webp`, `<stem>.info.json`,
 * `<stem>.en-orig.srt`, and for an image gallery the per-item directory `<stem>`
 * itself.
 *
 * ── the id-resolution contract (do not weaken this) ────────────────────────────
 * Membership is `media_entry_belongs_to`, the taxonomy module's ONE id-recogniser,
 * shared with the write path's `locate_result`. It accepts the legacy bare `<id>`
 * stem AND the canonical `<title> [<id>]` one, which is what lets the repair sweep
 * find the files of items archived before the rename existed — the archive holds
 * both shapes at once until the sweep has run. Resolution stays BY ID: a title is
 * never trusted to identify anything (titles collide, and they carry separators
 * and emoji), it only ever decorates a name whose id is still the key.
 */
export function item_entries(
  dir_abs: string,
  id: string,
  title: string | null | undefined,
): Array<{ from: string; to: string }> {
  let names: string[];
  try {
    names = readdirSync(dir_abs);
  } catch {
    return []; // the source directory is gone — nothing to move
  }
  return names
    .filter((n) => media_entry_belongs_to(n, id))
    .sort()
    .map((from) => ({ from, to: media_canonical_entry_name(from, id, title) }));
}

/** Move one file/directory, falling back to copy+delete only across devices. */
export function move_entry(from_abs: string, to_abs: string): void {
  try {
    renameSync(from_abs, to_abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from_abs, to_abs, { recursive: true });
    rmSync(from_abs, { recursive: true, force: true });
  }
}

/** Remove `dir_abs` and each now-empty ancestor, stopping below the archive root. */
export function prune_empty_dirs(root_abs: string, dir_abs: string): void {
  let cur = dir_abs;
  while (cur !== root_abs && cur.startsWith(root_abs + sep)) {
    try {
      if (readdirSync(cur).length > 0) return;
      rmdirSync(cur);
    } catch {
      return; // gone already, or not ours to remove — either way, stop
    }
    cur = dirname(cur);
  }
}

/**
 * The remainder of `path` below `from_dir`, or undefined if it isn't below it.
 *
 * BOTH sides go through `media_normalize_path` — the same normalisation
 * `media_dir_of` applies when it produces `from_dir` — because a prefix test
 * between two different spellings of the same path silently fails. It used to
 * collapse only backslashes, so a stored `./Videos/…` or `Videos/YouTube//chan/…`
 * moved its files and then failed to match its own `from_dir`: `nas_path` was
 * never rewritten and no later sweep could ever repair it (the DB pointed at an
 * empty directory forever). Normalising here also HEALS the spelling, since the
 * repointed path is rebuilt from the normalised remainder.
 */
export function under(path: string | undefined, from_dir: string): string | undefined {
  if (path === undefined) return undefined;
  const norm = media_normalize_path(path);
  const dir = media_normalize_path(from_dir);
  // An item filed at the archive ROOT has no directory to strip off.
  if (dir.length === 0) return norm.length > 0 ? norm : undefined;
  const prefix = `${dir}/`;
  if (!norm.startsWith(prefix)) return undefined;
  return norm.slice(prefix.length);
}

/**
 * Re-point a stored archive-relative path from `from_dir` to `to_dir`, applying
 * `rename` to the ENTRY the path belongs to. Returns undefined when the path
 * doesn't live under `from_dir` (leave it alone).
 *
 * The rename lands on the first component below `from_dir` — the entry — and never
 * on what follows it. That is what makes one function serve every stored path an
 * item has: a media file and a sidecar ARE the entry (`Title [id].mp4`), while a
 * gallery poster is a file INSIDE it (`Title [id]/001.jpg`), whose per-image name
 * gallery-dl chose and we must not touch.
 */
export function repoint(
  path: string | undefined,
  from_dir: string,
  to_dir: string,
  rename: (entry: string) => string,
): string | undefined {
  const rest = under(path, from_dir);
  if (rest === undefined) return undefined;
  const parts = rest.split('/');
  parts[0] = rename(parts[0]!);
  return [to_dir, ...parts].filter((s) => s.length > 0).join('/');
}

/** What `apply_final_cordon` did, for the runner's job log and the smoke. */
export interface FinalCordonResult {
  download: MediaDownloadResult;
  /** entries physically moved THIS call (0 on the resume-after-crash adopt). */
  moved: number;
  /** true when the download's paths now agree with the flag (moved or adopted). */
  aligned: boolean;
}

/**
 * Align a just-downloaded item's shelf with the FINAL verdict, in EITHER
 * direction — fold under `Private/` when the flag came up, fold OUT when a
 * review cleared it (owner directive 2026-08-10: no auto-private; the folder
 * records what was discerned, not what a threshold defaulted). The repair-path
 * twin is the taxonomy sweep, which derives the prefix from the stored flag +
 * review provenance; see `media_canonical_path`.
 *
 * This function is MECHANICAL: it moves whichever way `is_nsfw` says. The
 * judgment that licenses the un-private direction (a real review or a real
 * frame classification — never an absent verdict) is the caller's, where the
 * verdict's provenance lives.
 *
 * Runs in the runner's FILING phase, before the note freezes any path, so the
 * note, the row and the shelf agree from the item's first appearance. The move
 * is a pure prefix fold — `<dir>/…` ⇄ `Private/<dir>/…` — never a re-derive:
 * category/filename decisions were made at their own moments and are not this
 * function's to re-open.
 *
 * Idempotent against every crash window the filing phase has:
 *  - already on the right side (or nothing downloaded) → unchanged, no fs touch;
 *  - crashed after the bytes moved but before the job row persisted → the
 *    source entries are gone, the destination exists, so the paths are ADOPTED
 *    (rewritten with zero moves) and the resume completes;
 *  - a destination that already exists is never overwritten, and a stored path
 *    is only rewritten when its entry really is at the target — a partial move
 *    stays honest and the next resume finishes it.
 *
 * Throws only on a path escaping the archive root (corrupt job state — the
 * runner's error-streak handling is the right consumer, not a silent skip that
 * would file explicit content in the open tree).
 */
export function apply_final_cordon(args: {
  archive_root: string;
  id: string;
  title?: string | null;
  download: MediaDownloadResult;
  /** The final flag — `true` folds under Private/, `false` folds out of it. */
  is_nsfw: boolean;
}): FinalCordonResult {
  const { archive_root, id, title, download, is_nsfw } = args;
  const nas_path = media_normalize_path(download.nas_path);
  if (nas_path.length === 0 || media_is_private_path(nas_path) === is_nsfw) {
    return { download, moved: 0, aligned: nas_path.length > 0 };
  }

  const from_dir = media_dir_of(nas_path);
  const to_dir = is_nsfw
    ? [MEDIA_PRIVATE_SEGMENT, from_dir].filter((s) => s.length > 0).join('/')
    : from_dir.split('/').slice(1).join('/');
  const root_abs = resolve(archive_root);
  const from_abs = safe_archive_abs(archive_root, from_dir.length > 0 ? from_dir : '.');
  const to_abs = safe_archive_abs(archive_root, to_dir);
  if (from_abs === null || to_abs === null) {
    throw new Error(`final cordon: path escapes the archive root (${from_dir} → ${to_dir})`);
  }

  // The download just wrote these names via the same canonical stem, so the
  // rename map is identity — the fold changes the directory, never the name.
  const entries = item_entries(from_abs, id, title);
  let moved = 0;
  if (entries.length > 0) mkdirSync(to_abs, { recursive: true });
  for (const { from } of entries) {
    const src = join(from_abs, from);
    const dest = join(to_abs, from);
    if (existsSync(dest)) continue; // never overwrite (interrupted earlier run)
    move_entry(src, dest);
    moved += 1;
  }
  if (moved > 0) prune_empty_dirs(root_abs, from_abs);

  // Re-point only what is really at the target — same honesty rule as the
  // repair path's `owns()`: a stored path never aims at bytes that aren't there.
  const at_target = (p: string | undefined): boolean => {
    const entry = under(p, from_dir)?.split('/')[0];
    return entry !== undefined && existsSync(join(to_abs, entry));
  };
  const identity = (entry: string): string => entry;
  const next: MediaDownloadResult = { ...download };
  let aligned = false;
  if (at_target(nas_path)) {
    const p = repoint(nas_path, from_dir, to_dir, identity);
    if (p !== undefined) {
      next.nas_path = p;
      aligned = true;
    }
  }
  const thumb = download.thumbnail_path;
  if (thumb !== undefined && at_target(thumb)) {
    const p = repoint(thumb, from_dir, to_dir, identity);
    if (p !== undefined) next.thumbnail_path = p;
  }
  return { download: next, moved, aligned };
}

/** Fold segments to agree with the flag — `Private/` first once, or absent. */
export function cordoned_segments(segments: string[], is_nsfw = true): string[] {
  const has = segments[0] === MEDIA_PRIVATE_SEGMENT;
  if (is_nsfw) return has ? segments : [MEDIA_PRIVATE_SEGMENT, ...segments];
  return has ? segments.slice(1) : segments;
}
