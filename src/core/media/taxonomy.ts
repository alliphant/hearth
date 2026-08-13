/**
 * The media-archive TAXONOMY — the ONE definition of where an archived item
 * lives on disk. The write path (the runner's classify phase, via
 * `@connectors/media_category`) and the repair path (`rescan_media_metadata`
 * facet:'taxonomy') both derive the path from here; two copies of a filing rule
 * is how an archive ends up with `Private/PornHub`, `Private/Video` and
 * `Private/Videos` side by side.
 *
 * OWNER REPORT 2026-07-29 — *"the folder structures need to be better. Private
 * has 'Porn Hub', 'Video' and 'Videos'."* Three defects, one cause: the path was
 * a MODEL OUTPUT.
 *
 *   1. **No vocabulary.** The category prompt asked the planner for
 *      `folder_segments` and gave loose EXAMPLES, so the top segment was free
 *      text — `Videos` (plural) grew up next to `Video`.
 *   2. **Two producers of the `Private/` prefix.** The prompt ALSO said "if the
 *      NSFW verdict is not sfw, make the FIRST folder segment Private", while
 *      `apply_nsfw_cordon` prepends it deterministically anyway. A model that
 *      obeyed the prompt surrendered its KIND slot to `Private`, so the next
 *      thing it emitted landed in the kind position — that is literally how the
 *      SITE `PornHub` became a top-level folder (`["Private","PornHub",
 *      "MewSlut"]`, verified in `media_archive_jobs` for mi_kjfxj9qs).
 *   3. **Variable depth, so values slid between slots.** `mi_arxnmccn` was filed
 *      `["Video","SickJunk","Leaked Video Of Step Mom …"]` — the creator in the
 *      SITE slot, the TITLE in the creator slot.
 *
 * The fix is structural, not a better prompt: the model keeps CLASSIFYING
 * (media_kind / genre / creator / title_clean / mood_tags / confidence) and this
 * module DERIVES the path from those structured fields plus the measured probe.
 * A closed vocabulary and a constant depth make defects 1 and 3 unrepresentable;
 * removing the prompt instruction leaves `apply_nsfw_cordon` as the single
 * producer of the `Private/` prefix, which fixes defect 2.
 *
 * LAW #1 still holds. Nothing here is a judgment: the kind comes from the
 * model's `media_kind`, the creator from the model's metadata-attributed
 * `creator`, and the site/date from fields the extractor MEASURED. There is no
 * genre list, no channel→artist table, no per-site carve-out — the only per-site
 * knowledge is one CASING correction (`youtube` → `YouTube`), which changes how
 * a name is spelled and never where anything is filed.
 *
 * ── OWNER CORRECTION 2026-07-29 (same day, after the first shape shipped) ─────
 *
 * *"'Hot Wet Delirious' is what should be seen. From Zero Livestream."* and
 * *"you're not trimming the important part of the files right? The names???"*
 *
 * The first shape put the item's NAME nowhere on disk. Two independent causes,
 * both fixed here:
 *
 *   4. **The Music/Audio third slot had no title rung.** `album → year` gave a
 *      YouTube single the upload year (`Music/Rebecca Black/2026`), because no
 *      extractor reports an album for one. The ladder is now
 *      `album → TITLE → year → Unknown`.
 *   5. **The filename was the bare media id.** `download_media` has always
 *      stemmed its output at `<id>`, which was survivable only while a variable-
 *      depth path happened to carry the title in a 4th folder segment; constant
 *      depth removed that segment and the name lost its last foothold. Every
 *      archived file is now stemmed `<title> [<id>]` — see `media_canonical_stem`.
 *
 * ── REVIEW 2026-07-29 (the same defect class, one layer down) ─────────────────
 *
 * Deriving the segments here did not make them what lands on disk, and the title
 * rung is what turned that from a curiosity into a bug:
 *
 *   6. **Two producers of one folder NAME.** `media_download`'s `dest_dir` mapped
 *      its OWN second sanitiser over these segments — `SEG_UNSAFE`, an ASCII
 *      allowlist that replaced everything else with `_` — so the taxonomy derived
 *      `Music/Rebecca Black/Don't Stop` while the writer created
 *      `Music/Rebecca Black/Don_t Stop`, stored the taxonomy's spelling in
 *      `nas_path`, and the just-downloaded item was instantly `is_off_schema`.
 *      (Likewise `Café Del Mar` → `Caf_ Del Mar`, `100% Pure` → `100_ Pure`.)
 *      Survivable while every folder segment was a closed-vocabulary word, an
 *      extractor id or a channel handle — defect 4 made segment 2 an arbitrary
 *      TITLE, the highest-entropy string in the system and the one most likely to
 *      carry an apostrophe. `media_safe_segment` is now the ONE producer of a
 *      folder name: the writer applies that same function and `SEG_UNSAFE` is
 *      gone. Pinned by `smoke:media-taxonomy` section G3, which builds the path
 *      through the REAL `download_media` and requires it byte-identical to
 *      `media_canonical_path`.
 *   7. **The SMB-reserved class was applied to filenames only.** `<>:"|?*` were
 *      stripped from a stem for the stated reason "the archive is browsed over
 *      SMB", and not from a directory — on the same live CIFS mount
 *      (`//192.168.0.206/Serapeum → /mnt/nas2`, `mapposix`), where the effect is
 *      not a failed `mkdir` but a silent one: `mkdir "Album: The Return"`
 *      succeeds from the Linux side and renders as a U+F0xx private-use glyph to
 *      every other client on the share. The old writer hid this by accident
 *      (`:` → `_`); the migration is what would have created such a folder. Both
 *      components now share ONE hostile class (`COMPONENT_HOSTILE_CHARS`), and a
 *      filename adds exactly two characters on top of it — for reasons that are
 *      about PARSING A NAME rather than about the filesystem, which is the only
 *      asymmetry the module allows itself.
 *
 * Both rungs read the SAME resolved title (`real_title`) and the SAME cleaning
 * core (`clean_component`), and the writer consumes the segments this module
 * produces, so the folder and the filename can never disagree about what an item
 * is called beyond those two documented characters.
 */

import type { MediaKind } from './types';

// ── the closed top-level vocabulary ──────────────────────────────────────────

/**
 * Every top-level folder the archive may contain. CLOSED on purpose: an open
 * vocabulary is what produced `Video`/`Videos`, and a household browsing the
 * NAS in Finder needs the first level to be memorisable rather than descriptive.
 */
export const MEDIA_TOP_LEVELS = ['Music', 'Audio', 'Video', 'Talks', 'Images', 'Other'] as const;

export type MediaTopLevel = (typeof MEDIA_TOP_LEVELS)[number];

/**
 * Every `MediaKind` → its top level. TOTAL over `MEDIA_KINDS` (the compiler
 * enforces it via the `Record<MediaKind, …>` type), so a kind added to
 * `types.ts` cannot silently fall through to `Other`.
 */
const KIND_TO_TOP_LEVEL: Record<MediaKind, MediaTopLevel> = {
  // Music: the artist is the browsing axis, whatever the platform.
  song: 'Music',
  album: 'Music',
  music_video: 'Music',
  live_set: 'Music',
  // Audio: a spoken-word show, identified by the show rather than the platform.
  podcast: 'Audio',
  // Talks: a named speaker addressing an audience.
  talk: 'Talks',
  interview: 'Talks',
  lecture: 'Talks',
  // Video: platform video of every stripe.
  film: 'Video',
  episode: 'Video',
  trailer: 'Video',
  clip: 'Video',
  tutorial: 'Video',
  gameplay: 'Video',
  // Images: a still set (gallery-dl).
  image_gallery: 'Images',
  photoset: 'Images',
  // The honest "nothing fits".
  other: 'Other',
};

/**
 * Aliases onto the canonical vocabulary, keyed lowercase.
 *
 * This is NOT a second classifier — nothing on the write path consults it, since
 * the write path starts from a typed `MediaKind`. It exists so a top segment
 * that arrived from somewhere ELSE can be read: the folder names already on the
 * NAS (`Videos`), and any folder a human types by hand. `media_top_level_of_segment`
 * is what lets the repair sweep tell "this is `Video`, spelled wrong" apart from
 * "this is not a kind at all" (`PornHub`) — the latter being the corrupted-slot
 * signature, which must not be quietly accepted as a top level.
 *
 * Plurals, the obvious synonyms, and the placeholders we ourselves emit.
 *
 * Exported so the vocabulary is TESTABLE as a whole — the smoke asserts every
 * entry resolves and that nothing outside its expectation table has crept in.
 * `media_top_level_of_segment` is the accessor; don't read this map directly.
 */
export const MEDIA_TOP_LEVEL_ALIASES: Readonly<Record<string, MediaTopLevel>> = {
  // → Music
  music: 'Music',
  song: 'Music',
  songs: 'Music',
  album: 'Music',
  albums: 'Music',
  track: 'Music',
  tracks: 'Music',
  artist: 'Music',
  artists: 'Music',
  // → Audio
  audio: 'Audio',
  podcast: 'Audio',
  podcasts: 'Audio',
  audiobook: 'Audio',
  audiobooks: 'Audio',
  // → Video
  video: 'Video',
  videos: 'Video',
  movie: 'Video',
  movies: 'Video',
  film: 'Video',
  films: 'Video',
  tv: 'Video',
  show: 'Video',
  shows: 'Video',
  episode: 'Video',
  episodes: 'Video',
  clip: 'Video',
  clips: 'Video',
  // → Talks
  talk: 'Talks',
  talks: 'Talks',
  lecture: 'Talks',
  lectures: 'Talks',
  interview: 'Talks',
  interviews: 'Talks',
  conference: 'Talks',
  conferences: 'Talks',
  // → Images
  image: 'Images',
  images: 'Images',
  picture: 'Images',
  pictures: 'Images',
  pic: 'Images',
  pics: 'Images',
  photo: 'Images',
  photos: 'Images',
  photoset: 'Images',
  photosets: 'Images',
  gallery: 'Images',
  galleries: 'Images',
  // → Other
  other: 'Other',
  misc: 'Other',
  miscellaneous: 'Other',
  unsorted: 'Other',
  unknown: 'Other',
};

/**
 * A folder segment → the canonical top level it MEANS, or null when the segment
 * is not a kind at all. `null` is the interesting answer: it is how the repair
 * sweep recognises a path whose kind slot was overwritten by something else
 * (a site, a creator, a title).
 */
export function media_top_level_of_segment(segment: string | null | undefined): MediaTopLevel | null {
  const key = (segment ?? '').trim().toLowerCase();
  if (key.length === 0) return null;
  return MEDIA_TOP_LEVEL_ALIASES[key] ?? null;
}

/** The top level for a (possibly unknown / mislabelled) `media_kind` string. */
export function media_top_level_of_kind(media_kind: string | null | undefined): MediaTopLevel {
  const k = (media_kind ?? '').trim().toLowerCase();
  if (k.length === 0) return 'Other';
  const mapped = KIND_TO_TOP_LEVEL[k as MediaKind];
  if (mapped !== undefined) return mapped;
  // A kind we don't know (a model typo, a legacy row) still has to land
  // SOMEWHERE deterministic — try it as a folder alias before conceding 'Other'.
  return media_top_level_of_segment(k) ?? 'Other';
}

// ── segment safety + placeholders ────────────────────────────────────────────

/** Readability cap, in CHARACTERS (code points — never UTF-16 code units). */
const MAX_SEGMENT_LEN = 80;
/**
 * Hard cap, in UTF-8 BYTES. A path component is byte-limited on every filesystem
 * the archive lands on (255 on ext4/APFS/NFS); 80 characters is only 80 bytes of
 * ASCII but up to 320 of emoji, so the character cap alone does not bound it.
 */
const MAX_SEGMENT_BYTES = 200;

/**
 * Hard cap, in UTF-8 BYTES, for the TITLE part of a filename stem.
 *
 * Lower than `MAX_SEGMENT_BYTES` because a stem is not the whole budget: the
 * ` [<id>]` suffix (~15 bytes) and the longest sidecar tail (`.info.json`,
 * `.en-orig.srt` — ~12) share the same 255-byte component limit. 150 leaves ~78
 * bytes of headroom, which is slack rather than arithmetic on purpose: a
 * filename that is one byte too long fails the WRITE, and the readability cap
 * (80 characters, shared with folder segments) binds first for every real title.
 */
const MAX_FILE_TITLE_BYTES = 150;

const utf8 = new TextEncoder();

/**
 * Truncate to both caps, counting whole CHARACTERS.
 *
 * `slice` on the raw string would cut UTF-16 code units and can therefore split
 * a surrogate pair, emitting a LONE SURROGATE: deterministic, but not valid
 * UTF-8, so the string stored in `nas_path` and the name the kernel actually
 * receives (Node substitutes U+FFFD) would differ — and a stored path that
 * doesn't compare equal to the file on disk is exactly what the migration's
 * idempotence rests on.
 */
function truncate_chars(s: string, max_bytes: number): string {
  let chars = Array.from(s); // code points, so a pair is never split
  if (chars.length > MAX_SEGMENT_LEN) chars = chars.slice(0, MAX_SEGMENT_LEN);
  while (chars.length > 0 && utf8.encode(chars.join('')).length > max_bytes) {
    chars.pop();
  }
  return chars.join('');
}

/** The `Private/` prefix the NSFW cordon prepends. Not a top level — see below. */
export const MEDIA_PRIVATE_SEGMENT = 'Private';

/**
 * The stand-in for a slot with no value.
 *
 * Load-bearing: the shapes below are CONSTANT DEPTH, so a missing creator must
 * fill its slot rather than vanish. Dropping an empty segment is exactly the
 * left-shift that put `mi_arxnmccn`'s title in the creator position — every
 * value after the hole slides one slot up and lands somewhere it doesn't belong.
 * Filling the hole makes each position mean one thing forever, at the cost of a
 * visible `Unknown` folder, which is the honest report anyway.
 */
export const MEDIA_UNKNOWN_SEGMENT = 'Unknown';

/**
 * The stand-in `media_note` writes into a note's `name` when neither the model's
 * `title_clean` nor the probe's `title` produced anything.
 *
 * Exported and consumed by `media_note` so there is ONE spelling. It has to be a
 * value this module RECOGNISES rather than a private string over there, because
 * the write path derives from `title_clean` (absent) while the repair path
 * derives from the note's `name` (this sentinel): treating it as a real title on
 * one side only would make the two paths derive different folders and different
 * filenames, and a migration that disagrees with the writer re-moves the same
 * files every sweep. `real_title` maps it back to "no title".
 */
export const MEDIA_UNTITLED_NAME = '(untitled)';

/**
 * Characters no path component the archive writes may contain — FOLDER SEGMENTS
 * AND FILENAME STEMS ALIKE. One class for both, because both are created by the
 * same `mkdir`/`open`, on the same filesystem, served over the same SMB share.
 * Each entry is load-bearing, not tidiness:
 *
 *   • `%` — the write path hands yt-dlp an `-o` value that is a %-FORMAT
 *     TEMPLATE, and that value is the whole path (`<dir>/<stem>.%(ext)s`). A
 *     literal `%` anywhere in it — a directory segment exactly as much as the
 *     stem — is read as a field spec and the file lands somewhere we never
 *     predicted. Escaping it as `%%` would work only for as long as yt-dlp's
 *     escaping matches ours; removing it cannot drift.
 *   • `<>:"|?*` — reserved on Windows/SMB. The archive lives on a NAS that is
 *     also browsed over SMB, and the mount's `mapposix` makes the failure SILENT
 *     rather than loud: a reserved character is remapped to a U+F0xx private-use
 *     codepoint on the wire, so `mkdir "Album: The Return"` succeeds from the
 *     Linux side and renders as an unreadable glyph to every other client on the
 *     share. This is the "explicitly safe" half of the promise: safe on every
 *     filesystem AND protocol the archive is served from, not just on APFS/ext4
 *     where only `/` is forbidden.
 *
 * Path separators, control characters and invisible format characters are NOT in
 * this class because they are unconditional — `clean_component` removes them from
 * every component whatever class it is given.
 */
const COMPONENT_HOSTILE_CHARS = '%<>:"|?*';

/**
 * The characters a FILENAME loses on top of `COMPONENT_HOSTILE_CHARS` — the only
 * asymmetry between the two components, and both halves of it are about PARSING
 * A NAME rather than about the filesystem, which is why only the LAST path
 * component (the one anything ever parses) is subject to them:
 *
 *   • `.` — the stem/extension boundary. `media_split_entry_name` splits an entry
 *     name at its FIRST dot, and that is only unambiguous because a canonical
 *     stem contains none: with dots allowed, `Vol. 2 [mi_x].en.srt` has no
 *     parseable stem, and the id-recognition every file lookup rests on breaks.
 *     Cosmetic cost, stated plainly: "Vol. 2" files as "Vol 2". A DIRECTORY is
 *     never split at a dot, and stripping them there would corrupt a MEASURED
 *     fact: for a generic extractor the site slot IS a hostname
 *     (`sickjunk.com` — a live archive folder), and `sickjunk com` is a worse
 *     name, not a safer one.
 *   • `[` `]` — the id delimiter, which exists only in a stem. Stripping them
 *     from the title makes the LAST bracket group in a stem provably the one WE
 *     added, so `<title> [<id>]` cannot be spoofed by an item whose own title
 *     ends in brackets. A directory has no id to delimit, and an album name
 *     legitimately carries brackets (`Nine [Deluxe]`).
 *
 * Nothing is LOST by any of this: the full, exact title stays on the note
 * (`name`), the `media_items` row, and the API. This is only what the file is
 * CALLED.
 */
const FILENAME_ONLY_HOSTILE_CHARS = '.[]';

/**
 * `chars` as a global character-class regex, its class metacharacters escaped.
 *
 * Built from the two strings above rather than written out as two literals so
 * that **`FILENAME_HOSTILE ⊇ COMPONENT_HOSTILE` holds BY CONSTRUCTION**: a
 * character added to the shared class cannot be forgotten in the filename one.
 * Defect 7 was exactly that omission in the other direction, and this module
 * exists to make "two subtly different rules for one thing" unrepresentable —
 * here applied to characters instead of slots.
 */
const char_class = (chars: string): RegExp =>
  new RegExp(`[${chars.replace(/[\\\]^-]/g, '\\$&')}]`, 'g');

const COMPONENT_HOSTILE = char_class(COMPONENT_HOSTILE_CHARS);
const FILENAME_HOSTILE = char_class(COMPONENT_HOSTILE_CHARS + FILENAME_ONLY_HOSTILE_CHARS);

/**
 * The shared cleaning core for anything that becomes a path component — one
 * producer, so a directory name and a filename can never be sanitised by two
 * subtly different rules (that is the defect class this whole module exists to
 * abolish, applied to characters instead of slots).
 *
 * `\p{Cf}` is in the strip class with `\p{Cc}` on purpose: a bidi override
 * (U+202E) or a zero-width space inside a name renders as nothing and can
 * reorder the name a human reads in Finder, which is a misleading path rather
 * than an unsafe one — but the archive's whole job is that a name says what it
 * holds.
 *
 * **IDEMPOTENT**, and that is load-bearing rather than tidy: the WRITE path
 * re-applies `media_safe_segment` to the segments this module already derived
 * (see `dest_dir` in @connectors/media_download — the decision crosses a JSON
 * round-trip through `media_archive_jobs`, so the writer cannot assume they are
 * clean), and a non-idempotent cleaner would make the writer's path differ from
 * the taxonomy's on the second application, which is the divergence being fixed.
 * Two orderings pay for it, both of them corrections in their own right:
 *
 *   • the leading/trailing strip runs AFTER truncation, so a cut that lands on a
 *     dot (`…ab.` at exactly the character cap) cannot leave a trailing dot for a
 *     second pass to remove;
 *   • it strips leading/trailing DOTS AND WHITESPACE together, until neither is
 *     at either end. Stripping only dots left `'. . .'` → `'.'` — a path
 *     component that `split_path` drops and `resolve` collapses, so the derived
 *     path (`Music/./x`) and the path on disk (`Music/x`) disagreed forever:
 *     off-schema on every sweep, moved on none of them. A trailing space is also
 *     illegal in an SMB name, so this is the same promise as `<>:"|?*`.
 *
 * Returns '' when nothing survives; each caller owns its own fallback, because
 * they differ (a folder slot must be filled with `Unknown` to hold constant
 * depth; a filename stem falls back to the bare id instead).
 */
function clean_component(raw: string | null | undefined, hostile: RegExp, max_bytes: number): string {
  let s = (raw ?? '')
    .replace(/[/\\]+/g, ' ') // path separators
    .replace(/[\p{Cc}\p{Cf}]/gu, '') // control + invisible format chars (bidi, ZWSP, BOM)
    .replace(hostile, ' ') // → space: "Vol. 2" reads "Vol 2"
    .replace(/\s+/g, ' ')
    .trim();
  s = truncate_chars(s, max_bytes);
  return s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
}

/**
 * Make one taxonomy segment safe as a directory name: strip path separators,
 * control chars, invisible FORMAT chars and the `COMPONENT_HOSTILE` class,
 * collapse whitespace, drop leading/trailing dots and spaces (no `..`, no hidden
 * dirs, no name SMB refuses), cap length. Stays READABLE (spaces kept, not
 * slugified, non-ASCII letters kept). Returns the placeholder if nothing survives.
 *
 * **This is the ONE producer of a folder name.** `media_folder_segments` returns
 * its output and `download_media` writes exactly that — there is no second
 * sanitiser downstream (there was: see defect 6 in the header).
 */
export function media_safe_segment(raw: string | null | undefined): string {
  const s = clean_component(raw, COMPONENT_HOSTILE, MAX_SEGMENT_BYTES);
  return s.length > 0 ? s : MEDIA_UNKNOWN_SEGMENT;
}

/** Trimmed value, or undefined when absent/blank — never trust untyped input. */
const first_nonempty = (v: string | null | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : undefined;
};

/**
 * The item's title when it IS one, else undefined — the ONE resolver both title
 * consumers share (`album_segment` for the folder slot, `media_canonical_stem`
 * for the filename). Sharing it is what makes "the folder and the file agree
 * about the name" true by construction rather than by coincidence, and it is
 * where `MEDIA_UNTITLED_NAME` stops being mistaken for a real title.
 */
const real_title = (v: string | null | undefined): string | undefined => {
  const s = first_nonempty(v);
  return s === undefined || s === MEDIA_UNTITLED_NAME ? undefined : s;
};

// ── the site slot ────────────────────────────────────────────────────────────

/**
 * yt-dlp extractors that name the EMBED TECHNIQUE rather than a site. There is
 * no site identity in `html5` — `mi_arxnmccn` came from sickjunk.com through
 * `extractor: 'html5'` — so for these the honest site is the page's own host.
 */
const GENERIC_EXTRACTORS = new Set(['generic', 'html5', 'html5mediaembed']);

/**
 * CASING corrections only. yt-dlp's extractor ids are mostly already the brand
 * spelling (`PornHub`, `XHamster`, `Vimeo`), so the default rule below — keep
 * the extractor's own casing, upper-case a lone leading letter — is right almost
 * everywhere. This map is for the residue where it isn't, and it is deliberately
 * evidence-driven (one entry, for the site we actually have folders for) rather
 * than a speculative brand table: getting a name's capitalisation wrong is
 * cosmetic, and inventing per-site rules is how LAW #1 dies.
 */
const SITE_LABEL_CASING: Record<string, string> = {
  youtube: 'YouTube',
};

const upper_first = (s: string): string => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

/** `https://www.sickjunk.com/x/` → `sickjunk.com`; undefined when unparseable. */
function url_host(webpage_url: string | null | undefined): string | undefined {
  const raw = (webpage_url ?? '').trim();
  if (raw.length === 0) return undefined;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, '').trim();
    return host.length > 0 ? host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SITE segment: the platform an item came from, derived from the measured
 * extractor. Sub-extractors (`youtube:shorts`, `youtube:tab`) collapse onto
 * their parent — they are the same site, and letting them through would split
 * one channel across two folders.
 */
export function media_site_label(args: {
  extractor?: string | null;
  webpage_url?: string | null;
}): string {
  const raw = (args.extractor ?? '').trim();
  const base = raw.split(':')[0]?.trim() ?? '';
  const key = base.toLowerCase();
  if (base.length === 0 || GENERIC_EXTRACTORS.has(key)) {
    return media_safe_segment(url_host(args.webpage_url) ?? MEDIA_UNKNOWN_SEGMENT);
  }
  return media_safe_segment(SITE_LABEL_CASING[key] ?? upper_first(base));
}

// ── the deriver ──────────────────────────────────────────────────────────────

/**
 * Everything the deriver reads. Every field is optional and tolerantly typed —
 * this is fed both by a fresh probe (rich) and by an archived item's note
 * frontmatter (thinner), and it must be TOTAL over both.
 */
export interface MediaTaxonomyInput {
  /** the model's `MediaKind` (tolerant string — a legacy/unknown value is fine) */
  media_kind?: string | null;
  /**
   * The metadata-attributed creator. `media_category` already resolves this as
   * `model.creator ?? probe.channel ?? probe.uploader`, so it is the single
   * resolved identity — see the preference note in `creator_segment`.
   */
  creator?: string | null;
  /** MEASURED: yt-dlp / gallery-dl extractor id (`youtube`, `PornHub`, `html5`) */
  extractor?: string | null;
  /** MEASURED: the page URL — the site fallback for a generic extractor */
  webpage_url?: string | null;
  /** MEASURED: platform channel — a fallback for `creator` on the write path */
  channel?: string | null;
  /** MEASURED: platform uploader handle — the last creator fallback */
  uploader?: string | null;
  /** MEASURED: yt-dlp `upload_date` (raw yyyymmdd) */
  upload_date?: string | null;
  /** MEASURED: ISO `YYYY-MM-DD` (the note's `published_at`) — same signal, projected */
  published_at?: string | null;
  /** MEASURED: album title, when the extractor reported one (info-json passthrough) */
  album?: string | null;
  /**
   * The item's human title — the model's `title_clean` on the write path, the
   * note's `name` on the repair path (they are the same value; see
   * `MEDIA_UNTITLED_NAME` for the one case where they spell "absent" differently).
   *
   * ── why this is here now, having been deliberately excluded ────────────────
   * The first shape refused it with: *"a title names an ITEM, not a group of
   * them; the moment a title is allowed into a folder slot you get one directory
   * per file and, worse, a title competing for a slot that belongs to a creator
   * — which is exactly the `mi_arxnmccn` defect."* The second half of that was
   * the real argument, and it was an argument about VARIABLE DEPTH: with a
   * variable-length segment list, a title could slide into whichever slot a
   * missing value had vacated. **Depth is now constant at 3, so nothing can
   * slide** — and the owner, seeing `Music/Rebecca Black/2026`, ruled that the
   * name is what he wants to read there.
   *
   * The first half turned out to be the lesser cost: `Music/<Artist>/<Title>` is
   * one directory per single, but only where no album was measured — which is
   * exactly the case that was otherwise going to say `2026`. A year is not a
   * group either; it is just a less informative name for the same one-item
   * folder. So this buys the name at no real loss of grouping.
   *
   * ⚠ **CONSTRAINED BY CONSTRUCTION to the album slot.** It is impossible for a
   * title to reach slot 0, the site slot or the creator slot, and that is
   * enforced by the TYPE of each slot function's parameter, not by discipline:
   * `creator_segment` takes `Pick<…, 'creator' | 'channel' | 'uploader'>` and
   * `media_site_label` takes `{ extractor?, webpage_url? }`, so a future author
   * who reaches for `input.title` in either one gets a COMPILE ERROR. Slot 0 is
   * `media_top_level_of_kind(input.media_kind)`, which takes a bare string.
   * `album_segment` is the only reader, and `media_folder_segments` places its
   * result at index 2 of the creator-first shape and nowhere else. Pinned by
   * `smoke:media-taxonomy` section A over every `MediaKind`.
   */
  title?: string | null;
  /**
   * The item's explicit FLAG (`nsfw_flag_for` over the final verdict — the same
   * value the note's frontmatter and the projected row carry), consumed by
   * `media_canonical_path` / `is_off_schema` as a producer of the `Private/`
   * prefix: a flag-true item derives its home under `Private/` wherever it
   * currently sits (the classify-time-folder deviation's repair).
   */
  nsfw?: boolean | null;
  /**
   * True when the note carries REVIEW PROVENANCE (`review` frontmatter — a VL
   * frame review or the metadata judge actually produced the verdict; see
   * @core/media/types MediaReview). This is the license for the un-private
   * direction: a flag-FALSE item derives an open-tree home only when reviewed —
   * an unreviewed flag-false item keeps whatever prefix its current path has
   * (fail-closed carry, exactly the pre-review rule). Owner directive
   * 2026-08-10: no auto-private — but unlooked-at is never "safe" either.
   */
  reviewed?: boolean | null;
  /**
   * OWNER-PINNED directory (archive-relative, normalized), from the note's
   * `placement` frontmatter — written only by a directed move ("Kate, put this
   * under Music/Concerts"). When present it IS the canonical directory,
   * verbatim: it outranks the derived folder AND the cordon-prefix rule,
   * because it records explicit owner intent about this one item — including,
   * deliberately, an explicit-flagged item the owner pins outside `Private/`.
   * Without this pin, the tidy sweep would "repair" every hand-placed item
   * back to its derived home on the next run, which is how a directed move
   * stays moved. The FILENAME still derives (`<title> [<id>]`) — the pin
   * places an item, it never renames one. Who can SEE the item is untouched
   * either way (@core/media/cordon — the requester, always).
   */
  placement?: string | null;
}

/**
 * The creator slot. ONE preference order for every kind, and `creator` leads on
 * purpose: `media_category` has already folded `channel`/`uploader` into it, so
 * preferring it makes the whole path reproducible **from the note alone**. That
 * is what makes the repair sweep idempotent — re-deriving an item from its
 * frontmatter (which has `creator` but neither `channel` nor `uploader`, since
 * those are typed probe fields that never reach the note) yields byte-identical
 * segments to the write path's derivation from the full probe. Preferring the
 * measured handle instead would make the two paths disagree, and a migration
 * that disagrees with the writer re-moves the same files every sweep.
 *
 * The parameter is NARROWED rather than the whole input: that is what makes
 * "a title can never land in the creator slot" a compile error instead of a
 * convention. Same for `media_site_label`'s object literal above.
 */
function creator_segment(input: Pick<MediaTaxonomyInput, 'creator' | 'channel' | 'uploader'>): string {
  const pick =
    first_nonempty(input.creator) ?? first_nonempty(input.channel) ?? first_nonempty(input.uploader);
  return media_safe_segment(pick ?? MEDIA_UNKNOWN_SEGMENT);
}

/** `20240905` or `2024-09-05` → `2024`; undefined when neither is present. */
function year_segment(input: Pick<MediaTaxonomyInput, 'upload_date' | 'published_at'>): string | undefined {
  const raw = first_nonempty(input.upload_date) ?? first_nonempty(input.published_at);
  if (raw === undefined) return undefined;
  const m = /^(\d{4})/.exec(raw.replace(/-/g, ''));
  return m ? m[1] : undefined;
}

/**
 * The grouping slot for a creator-first kind: the measured album, else the
 * item's TITLE, else the upload YEAR.
 *
 * `album` first keeps the Plex/Jellyfin shape (`Music/<Artist>/<Album>/…`)
 * wherever an extractor actually reported one, so real albums still group.
 *
 * ── the title rung (OWNER DECISION 2026-07-29) ─────────────────────────────
 * The first shape ranked `album → year` and recorded the title as a REJECTED
 * alternative, on the grounds that a title yields one single-file directory per
 * song and re-opens a slot a title must never occupy. The owner overruled it on
 * sight of the result — *"'Hot Wet Delirious' is what should be seen. From Zero
 * Livestream."* — and the rejection does not survive scrutiny either:
 *
 *   • **The slot risk was a depth risk, and depth is now constant.** A title
 *     could only ever "occupy the wrong slot" while a missing value could shift
 *     the list; with exactly three slots that always exist, the album slot is the
 *     album slot. The type narrowing above closes the other half.
 *   • **The grouping loss is nearly nil.** This rung fires only when NO album was
 *     measured — i.e. precisely where the alternative was going to write a bare
 *     `2026`. Both are one-item folders; only one of them says what is inside.
 *
 * `year` stays as the rung below, for an item with neither an album nor a title.
 */
function album_segment(
  input: Pick<MediaTaxonomyInput, 'album' | 'title' | 'upload_date' | 'published_at'>,
): string {
  return media_safe_segment(
    first_nonempty(input.album) ?? real_title(input.title) ?? year_segment(input) ?? MEDIA_UNKNOWN_SEGMENT,
  );
}

/**
 * The canonical folder segments for one item — **always exactly three**, top
 * segment first, WITHOUT the `Private/` prefix (see `media_canonical_dir`).
 *
 * Two shapes, and the asymmetry is a RULE rather than the accident the old
 * prompt's examples encoded (its Music example had no site segment while its
 * Video example did, with nothing to say why):
 *
 *   creator-first — `Music/<Artist>/<Album-or-Title-or-Year>`,
 *                   `Audio/<Show>/<Album-or-Title-or-Year>`
 *   site-first    — `Video/<Site>/<Creator>`, `Talks/<Site>/<Speaker>`,
 *                   `Images/<Site>/<Uploader>`, `Other/<Site>/<Creator>`
 *
 * The rule: **the site segment exists exactly where the creator's identity is
 * platform-scoped.** `jawed` means nothing without `YouTube` and `luke49`
 * nothing without `XHamster` — a platform handle is only unique inside its
 * platform, and two channels on different sites can share a name, so filing
 * those without the site would collide names that are not the same creator. An
 * ARTIST, by contrast, is a global identity that exists independently of where
 * the bytes came from: interposing the site there fragments one artist across
 * YouTube / Bandcamp / SoundCloud for no benefit, so Music and Audio are
 * creator-first. Talks was the one shape worth changing from the sketch —
 * `Talks/<Series-or-Venue>/<Speaker>` puts an UNMEASURED value (no probe field
 * carries a series or a venue) in slot 2, which is a guaranteed `Unknown`
 * folder; on the platform-scoped rule Talks is site-first like Video, and every
 * slot is measured.
 *
 * Constant depth is the other half of the fix: with three slots that always
 * exist, no value can slide into a position that isn't its own.
 */
export function media_folder_segments(input: MediaTaxonomyInput): string[] {
  const top = media_top_level_of_kind(input.media_kind);
  if (top === 'Music' || top === 'Audio') {
    return [top, creator_segment(input), album_segment(input)];
  }
  return [top, media_site_label(input), creator_segment(input)];
}

// ── paths: current vs canonical ──────────────────────────────────────────────

/** Split an archive-relative path into segments, tolerant of `\` and doubles. */
function split_path(path: string): string[] {
  return path
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * An archive-relative path in ONE canonical spelling: forward slashes, no
 * doubles, no `.` segments, no trailing slash.
 *
 * Exported because every consumer that compares a stored path against a derived
 * one has to normalise it the SAME way, and two spellings of "normalise" is the
 * same class of defect as two spellings of the filing rule. `rescan_media_metadata`'s
 * `under()` used to collapse only backslashes, so a legacy `nas_path` of
 * `./Videos/…` or `Videos/YouTube//chan/…` produced a directory that its own
 * prefix test could not match: the files MOVED and `nas_path` was never rewritten,
 * and every later sweep reported "no files found at the old path" forever. Not
 * producible by the current writer — but this facet exists to repair messy legacy
 * state, and the failure was silent.
 */
export function media_normalize_path(path: string | null | undefined): string {
  return split_path(path ?? '').join('/');
}

/** True when a stored archive path sits under the NSFW cordon's `Private/`. */
export function media_is_private_path(path: string | null | undefined): boolean {
  const first = split_path(path ?? '')[0];
  return first !== undefined && first.toLowerCase() === MEDIA_PRIVATE_SEGMENT.toLowerCase();
}

/**
 * The taxonomy DIRECTORY a stored `nas_path` currently sits in, archive-relative
 * and normalised (forward slashes, no trailing slash).
 *
 * Uniform across both item shapes, which is why it can be one function: an A/V
 * item's `nas_path` is `<segments>/<stem>.<ext>` and an image gallery's is the
 * per-item DIRECTORY `<segments>/<stem>`, so the taxonomy dir is the parent of
 * either. (`<stem>` is `media_canonical_stem`'s `<title> [<id>]`, or a bare `<id>`
 * for anything archived before that existed — this function reads neither.)
 */
export function media_dir_of(nas_path: string | null | undefined): string {
  const segs = split_path(nas_path ?? '');
  return segs.slice(0, -1).join('/');
}

/**
 * The directory this item SHOULD live in, archive-relative.
 *
 * `is_private` is passed in rather than re-judged: the NSFW *verdict* is not
 * this module's business (`apply_nsfw_cordon` in `@connectors/media_category`
 * owns verdict → prefix on the write path). What the callers pass is
 * `current-path-Private OR the item's stored flag` — see `media_canonical_path`
 * — which carries an existing cordon forward (never widens) and folds a
 * flag-true item in (tighten-only).
 */
export function media_canonical_dir(input: MediaTaxonomyInput, is_private: boolean): string {
  const segs = media_folder_segments(input);
  return (is_private ? [MEDIA_PRIVATE_SEGMENT, ...segs] : segs).join('/');
}

// ── the filename: the item's NAME, on disk ───────────────────────────────────

/**
 * Split one on-disk ENTRY name into its stem and its extension chain.
 *
 * The split is at the FIRST dot, and that is only unambiguous because a canonical
 * stem provably contains no dot (`FILENAME_HOSTILE` removes them) and a legacy
 * bare-id stem contains none either. That is what lets ONE rule read every
 * artefact an item owns — `<stem>.mp4`, `<stem>.webp`, `<stem>.info.json`,
 * `<stem>.en-orig.srt` (a real live case: mi_qk97e6kw carries `en` AND
 * `en-orig`), and a gallery's extensionless per-item directory.
 *
 * A dotfile (`.DS_Store`) yields an EMPTY stem, so it can never be mistaken for
 * an item's artefact — which is the correct reading of a name that is all suffix.
 */
export function media_split_entry_name(name: string): { stem: string; suffix: string } {
  const dot = name.indexOf('.');
  return dot < 0 ? { stem: name, suffix: '' } : { stem: name.slice(0, dot), suffix: name.slice(dot) };
}

/**
 * The canonical filename STEM for one item: `<title> [<id>]`, or the bare `<id>`
 * when the title sanitises to nothing.
 *
 * OWNER 2026-07-29 — *"you're not trimming the important part of the files right?
 * The names???"* The archive had the item's name in its DB, its note and its
 * `.info.json` sidecar, and nowhere a human browsing the NAS in Finder could see
 * it. This is where the name lives on disk.
 *
 * **The id is retained, and its position is the whole design.** File resolution
 * is by ID — `item_entries` in the repair path and `locate_result` on the write
 * path both find an item's files by asking which names belong to an id — and a
 * title can never be trusted with that job: titles collide between items, and
 * they contain separators, emoji, quotes and 200-character runs. So the id stays
 * in every name, bracketed at the END where it reads as provenance rather than a
 * prefix, and `media_entry_belongs_to` is the ONE recogniser both call sites use.
 *
 * Fully idempotent by construction: re-deriving from an id + a title always
 * yields the same stem, and a stem that is already canonical re-derives to
 * itself, so the migration is a fixed point rather than a rename treadmill.
 */
export function media_canonical_stem(id: string | null | undefined, title?: string | null): string {
  const key = (id ?? '').trim();
  const name = clean_component(real_title(title), FILENAME_HOSTILE, MAX_FILE_TITLE_BYTES);
  if (key.length === 0) return name.length > 0 ? name : MEDIA_UNKNOWN_SEGMENT; // never an empty stem
  return name.length > 0 ? `${name} [${key}]` : key;
}

/**
 * Does this on-disk entry name belong to item `id`? The ONE id-resolution rule.
 *
 * Accepts BOTH stem shapes on purpose — the legacy bare `<id>` (everything
 * archived before this change) and the canonical `<title> [<id>]` — because the
 * archive holds both at once for as long as it takes the repair sweep to run, and
 * a resolver that only knew the new shape would strand every existing file.
 *
 * The `<title> [<id>]` test is `endsWith(' [<id>]')` on the STEM, never a
 * substring search over the whole name. Two properties make that exact rather
 * than approximate: `FILENAME_HOSTILE` strips `[`, `]` and `.` from titles, so
 * the only bracket group in any stem is the one we appended, and it is
 * necessarily last. A looser "the id appears anywhere in the stem" test would let
 * an item whose own title ends in `[mi_other]` claim another item's files.
 */
export function media_entry_belongs_to(name: string, id: string | null | undefined): boolean {
  const key = (id ?? '').trim();
  if (key.length === 0) return false;
  const { stem } = media_split_entry_name(name);
  return stem === key || stem.endsWith(` [${key}]`);
}

/**
 * Rename one on-disk entry onto the canonical stem, PRESERVING its extension
 * chain — the single renamer, used by the migration's move loop and by
 * `media_canonical_path`, so a file's new name and the path stored for it cannot
 * be computed two different ways.
 *
 * Extension-preserving is not a detail: the container (`.mp4` / `.m4a`) and the
 * sidecar tails (`.info.json`, `.en-orig.srt`) are MEASURED facts about what
 * landed, and this function's job is the name, never the format.
 */
export function media_canonical_entry_name(
  name: string,
  id: string | null | undefined,
  title?: string | null,
): string {
  const { suffix } = media_split_entry_name(name);
  return `${media_canonical_stem(id, title)}${suffix}`;
}

/**
 * The full archive-relative path this item's media SHOULD have: the canonical
 * directory plus the canonical entry name.
 *
 * Uniform across both item shapes for the same reason `media_dir_of` is: an A/V
 * item's `nas_path` ends in the media FILE and a gallery's ends in the per-item
 * DIRECTORY, and either way the last component is the entry to rename and
 * everything before it is the directory to re-file.
 */
export function media_canonical_path(
  nas_path: string | null | undefined,
  input: MediaTaxonomyInput,
  id: string | null | undefined,
): string {
  const norm = media_normalize_path(nas_path);
  if (norm.length === 0) return '';
  const segs = norm.split('/');
  const name = media_canonical_entry_name(segs[segs.length - 1]!, id, input.title);
  // An owner pin outranks every derivation — it IS the canonical directory
  // (see the `placement` field doc). The filename still derives.
  const pin = media_normalize_path(input.placement ?? '');
  if (pin.length > 0) return `${pin}/${name}`;
  // The Private/ prefix, decided by DISCERNMENT rank (owner 2026-08-10):
  //  1. flag TRUE → Private/, wherever the path currently sits;
  //  2. flag FALSE + review provenance → the open tree (a model really looked,
  //     or really read the metadata — the only license to un-private);
  //  3. flag FALSE, unreviewed → carry the CURRENT path's prefix (fail-closed:
  //     a legacy verdict with no provenance may shelve in, never out).
  const is_private =
    input.nsfw === true ? true : input.reviewed === true ? false : media_is_private_path(norm);
  const dir = media_canonical_dir(input, is_private);
  return dir.length > 0 ? `${dir}/${name}` : name;
}

/**
 * Is this item filed off-schema? ONE rule, testable on its own: the path the item
 * has is not the path the taxonomy derives for it.
 *
 * Stated that way it subsumes every defect in the owner's two reports — a
 * non-canonical top segment (`Videos`), a corrupted kind slot (`PornHub`), a
 * shifted value, a wrong depth, AND a filename that doesn't carry the item's name
 * — without enumerating any of them, and it stays true as the shapes evolve. It
 * was the DIRECTORY comparison until the filename became part of the taxonomy;
 * widening it to the whole path is why the migration renames as well as moves,
 * with no second predicate to keep in sync. The cordon prefix follows
 * `media_canonical_path`'s tighten-only rule: a `Private/` item is always
 * compared against a `Private/` target (re-filing moves it WITHIN the cordon),
 * and a flag-true item in the open tree compares against a `Private/` target,
 * so the migration is also what folds it in.
 *
 * The one exemption is an ABSENT stored path — nothing to re-file. That is
 * deliberately tested on the path, not on its directory: `media_dir_of` is `''`
 * for both `undefined` AND for an item filed at the archive ROOT (`mi_x.mp4`),
 * and conflating the two declared a root-filed item on-schema forever, which was
 * a hole in this rule's claim to subsume every filing defect.
 */
export function is_off_schema(
  nas_path: string | null | undefined,
  input: MediaTaxonomyInput,
  id: string | null | undefined,
): boolean {
  const norm = media_normalize_path(nas_path);
  if (norm.length === 0) return false; // never filed → nothing to move
  return norm !== media_canonical_path(norm, input, id);
}
