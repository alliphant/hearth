import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Schema is idempotent: every CREATE has IF NOT EXISTS. Bump SCHEMA_VERSION and
// add migrations below if/when the shape changes incompatibly.
export const SCHEMA_VERSION = 1;

/**
 * A single bound value for a SQL statement — the scalar leaf of bun's
 * `SQLQueryBindings`. A named-params object passed to `.run`/`.all`/`.get`
 * must be `Record<string, SqlBind>`; `SQLQueryBindings` itself is too wide
 * to use as the value type (it nests a Record and won't bind).
 */
export type SqlBind = string | number | bigint | boolean | null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preferred_name TEXT,
  relationship TEXT NOT NULL,
  birthday TEXT,
  contact_cadence TEXT,
  last_contacted TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  friday_managed INTEGER NOT NULL DEFAULT 0,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_relationship ON people(relationship);
CREATE INDEX IF NOT EXISTS idx_people_friday_managed ON people(friday_managed);
CREATE INDEX IF NOT EXISTS idx_people_birthday ON people(birthday);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  address TEXT,
  lat REAL,
  lon REAL,
  category TEXT,
  ha_zone_name TEXT,
  parking_buffer_minutes INTEGER NOT NULL DEFAULT 0,
  hours_json TEXT,
  phone TEXT,
  note_path TEXT NOT NULL UNIQUE,
  mtime TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_category ON places(category);
CREATE INDEX IF NOT EXISTS idx_places_ha_zone ON places(ha_zone_name);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);

CREATE TABLE IF NOT EXISTS journal_entries (
  date TEXT PRIMARY KEY,
  note_path TEXT NOT NULL UNIQUE,
  tags_json TEXT NOT NULL,
  mtime TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  domain TEXT NOT NULL,
  chosen TEXT NOT NULL,
  reversible INTEGER NOT NULL,
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date);
CREATE INDEX IF NOT EXISTS idx_decisions_domain ON decisions(domain);

CREATE TABLE IF NOT EXISTS clippings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  title TEXT NOT NULL,
  attachment_path TEXT,
  captured_at TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_clippings_kind ON clippings(kind);
CREATE INDEX IF NOT EXISTS idx_clippings_reviewed ON clippings(reviewed);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  context TEXT,
  PRIMARY KEY (from_path, to_path)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_path);
CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_path);

-- Household Knowledge Graph (2026-06-20) — purchased goods projected from a
-- household_good vault note (the ingestor projects this; the vault note is the
-- source of truth, mirroring people/places). Holds the date-scannable columns
-- the warranty/return reactive triggers query; full frontmatter in *_json.
-- Additive table, no SCHEMA_VERSION bump. Cordon: every row carries private_to.
CREATE TABLE IF NOT EXISTS household_goods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  merchant TEXT,
  owner TEXT,
  order_key TEXT,
  purchase_date TEXT,
  cost REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  warranty_until TEXT,
  return_window_until TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_goods_status ON household_goods(status);
CREATE INDEX IF NOT EXISTS idx_goods_warranty ON household_goods(warranty_until);
CREATE INDEX IF NOT EXISTS idx_goods_return ON household_goods(return_window_until);
CREATE INDEX IF NOT EXISTS idx_goods_order_key ON household_goods(order_key);

-- Services and Bills ledger (2026-07-04) -- standing vendor relationships
-- projected from a household_service vault note (the ingestor projects this;
-- the vault note is the source of truth, mirroring household_goods). Holds
-- the due-window-scannable columns the bills surface reads plus the
-- sender-domain match key mail-triage grounding queries; full frontmatter in
-- the json column. Additive table, no SCHEMA_VERSION bump. Cordon: every row
-- carries private_to.
CREATE TABLE IF NOT EXISTS household_services (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  vendor_anchor TEXT NOT NULL,
  category TEXT,
  cadence TEXT,
  typical_amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  autopay INTEGER,
  account_hint TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL,
  sender_domains_json TEXT NOT NULL DEFAULT '[]',
  last_bill_date TEXT,
  next_due_estimate TEXT,
  source TEXT NOT NULL DEFAULT 'mail',
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_services_status ON household_services(status);
CREATE INDEX IF NOT EXISTS idx_services_due ON household_services(next_due_estimate);
CREATE INDEX IF NOT EXISTS idx_services_anchor ON household_services(vendor_anchor);

-- Calendar Knowledge Graph (Phase 3, 2026-06-20) — attributed calendar events
-- projected from a life_event vault note (the ingestor projects this; the vault
-- note is the source of truth, mirroring people/places/household_goods). Holds
-- the date-scannable columns the cross-domain reactive triggers query
-- (birthday/vacation/appointment); full frontmatter in *_json. Additive table,
-- no SCHEMA_VERSION bump. Cordon: every row carries private_to.
CREATE TABLE IF NOT EXISTS life_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  event_date TEXT,
  end_date TEXT,
  location TEXT,
  owner TEXT,
  attribution_confidence REAL,
  owner_uncertain INTEGER NOT NULL DEFAULT 0,
  actionable INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'calendar',
  source_event_id TEXT,
  calendar_name TEXT,
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_life_events_date ON life_events(event_date);
CREATE INDEX IF NOT EXISTS idx_life_events_category ON life_events(category);
CREATE INDEX IF NOT EXISTS idx_life_events_owner ON life_events(owner);

-- Media Archive (2026-07-11) — downloaded media projected from a media_item
-- vault note. Typed browse/scan columns; frontmatter_json holds the full
-- per-site metrics. Additive table, no SCHEMA_VERSION bump. Cordon: every row
-- carries private_to (NSFW items stamp the owner id, never household).
CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media_kind TEXT,
  source_site TEXT,
  source_url TEXT,
  creator TEXT,
  genre TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  duration_s INTEGER,
  width INTEGER,
  height INTEGER,
  container TEXT,
  filesize INTEGER,
  published_at TEXT,
  archived_at TEXT,
  nas_path TEXT,
  thumbnail_path TEXT,
  note_path TEXT NOT NULL UNIQUE,
  frontmatter_json TEXT NOT NULL,
  mtime TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_items(media_kind);
CREATE INDEX IF NOT EXISTS idx_media_nsfw ON media_items(nsfw);
CREATE INDEX IF NOT EXISTS idx_media_archived ON media_items(archived_at);
CREATE INDEX IF NOT EXISTS idx_media_site ON media_items(source_site);

-- Media Archive job queue (2026-07-11) — a self-contained runner ledger (NOT a
-- projected vault note), mirroring research_investigations. One row per
-- archive_url request; the detached MediaArchiveRunner advances it through
-- probe -> nsfw -> categorize -> download -> file -> index -> report.
-- Two columns were RETIRED 2026-07-29 and are deliberately no longer declared:
-- requester_tier TEXT (the cordon stopped consulting tier — it is the requester,
-- always) and force_owner_only INTEGER (the retired archive_url slot). Neither had
-- a reader left. An already-deployed database still carries them, inert; the header
-- of memory/stores/media_jobs.ts says why they are not dropped by migration.
CREATE TABLE IF NOT EXISTS media_archive_jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  private_to TEXT,
  conversation_id TEXT,
  user_note TEXT,
  quality_override TEXT,
  audio_only INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  probe_json TEXT,
  category_json TEXT,
  quality_json TEXT,
  download_json TEXT,
  nsfw_json TEXT,
  media_item_id TEXT,
  note_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_archive_jobs(status);
CREATE INDEX IF NOT EXISTS idx_media_jobs_url ON media_archive_jobs(url);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  note_path UNINDEXED,
  chunk_idx UNINDEXED,
  chunk_text,
  tokenize='porter unicode61'
);

-- Vector embeddings for the SAME (note_path, chunk_idx) chunks indexed in
-- chunks_fts (RAG Pass 7). One row per chunk; embedding is a Float32Array
-- packed little-endian into a BLOB. model + dim are stored per row so a
-- model swap (different dimensionality) can be detected and skipped rather
-- than producing garbage cosine scores against mismatched vectors. Written
-- best-effort at library ingest + by scripts/backfill-embeddings.ts; read by
-- MemoryClient.vector_search (brute-force cosine — adequate at vault scale,
-- see docs note). Deleted alongside the chunks_fts rows on note removal.
-- Entirely behind HEARTH_RAG_VECTOR: empty/absent => retrieval is FTS-only.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  note_path  TEXT NOT NULL,
  chunk_idx  INTEGER NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  BLOB NOT NULL,
  ts_created TEXT NOT NULL,
  PRIMARY KEY (note_path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_chunk_emb_path ON chunk_embeddings(note_path);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  gate_decision TEXT,
  execution_result TEXT,
  human_verdict TEXT,
  cost TEXT,
  error TEXT,
  -- Phase 2b — id of the user whose session triggered this row.
  -- Nullable for system-initiated rows (deliberation, scheduler,
  -- ingestor). Joined against config/users.yaml ids in audit reports.
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_intent ON audit_log(intent_id);
-- Phase 2b audit_log.user_id column + idx_audit_user_id index are
-- created in the migration block below — they reference the additive
-- column which doesn't exist yet in pre-2b databases.

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL,
  ts_decided TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','approved','denied','expired')),
  tool_call_json TEXT NOT NULL,
  gate_decision_json TEXT NOT NULL,
  modified_call_json TEXT,
  human_verdict_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, ts_created);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  fire_at TEXT NOT NULL,
  intent TEXT NOT NULL,
  context_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_scheduled_fire_at ON scheduled_tasks(fire_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_tasks(status);

-- ── Specialist runtime (Prompt 6a) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL,
  ts_surfaced TEXT,
  ts_decided TEXT,
  ts_executed TEXT,
  specialist_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  rationale_md TEXT NOT NULL,
  category_signature_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  snoozed_until TEXT,
  modifications_json TEXT,
  execution_result_json TEXT,
  user_feedback TEXT,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_specialist ON proposals(specialist_id);
CREATE INDEX IF NOT EXISTS idx_proposals_sig ON proposals(category_signature_hash);
CREATE INDEX IF NOT EXISTS idx_proposals_ts_created ON proposals(ts_created);

CREATE TABLE IF NOT EXISTS category_signatures (
  hash TEXT PRIMARY KEY,
  signature_json TEXT NOT NULL,
  approval_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  denial_count INTEGER NOT NULL DEFAULT 0,
  last_action_at TEXT,
  autonomy_status TEXT NOT NULL DEFAULT 'tier2a',
  autonomy_revoked_reason TEXT,
  -- Trust Ladder (RPG XP, 2026-06-20): accrued trust XP (accept=+ / deny=−,
  -- weighted by action×risk) + the derived 0..3 level. XP gates graduation
  -- ALONGSIDE the approval count when HEARTH_TRUST_XP is on. Additive; no
  -- SCHEMA_VERSION bump (add_column_if_missing backfills existing DBs).
  xp REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signatures_autonomy ON category_signatures(autonomy_status);

-- Per-specialist Trust-Ladder XP accumulator (Hearth rank badges, 2026-06-20).
-- The SUM of XP a specialist has earned across all their skills (signatures),
-- bumped at the same ProposalsStore.decide() chokepoint as the per-signature
-- xp. Drives the copper→silver→gold→platinum→diamond badge + level + XP bar on
-- the chat surface + office. Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS specialist_xp (
  specialist_id TEXT PRIMARY KEY,
  xp REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

-- Trust teeth (2026-07-02): court-consensus auto-executions awaiting their
-- undo window. One row per armed proposal (UNIQUE); the 60s sweep executes
-- 'armed' rows past execute_after through the SAME decide()+effects path an
-- owner tap runs, and cancels rows whose proposal the owner touched first
-- (deny = the undo; the deny itself carries the negative XP signal).
-- Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS trust_autoexec (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  signature_hash TEXT,
  tier TEXT NOT NULL,
  ts_armed TEXT NOT NULL,
  execute_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'armed',
  ts_resolved TEXT,
  resolution TEXT,
  votes_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_trust_autoexec_due
  ON trust_autoexec (status, execute_after);

CREATE TABLE IF NOT EXISTS interrupts (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  originating_specialist_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_md TEXT,
  routed_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  originating_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_interrupts_status ON interrupts(status);
CREATE INDEX IF NOT EXISTS idx_interrupts_ts ON interrupts(ts);

CREATE TABLE IF NOT EXISTS specialist_inboxes (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_specialist_id TEXT NOT NULL,
  to_specialist_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_md TEXT NOT NULL,
  related_proposal_id TEXT,
  related_interrupt_id TEXT,
  read_at TEXT,
  actioned_at TEXT,
  originating_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sinbox_to ON specialist_inboxes(to_specialist_id, read_at);
CREATE INDEX IF NOT EXISTS idx_sinbox_from ON specialist_inboxes(from_specialist_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  specialist_id TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_last_message_at TEXT NOT NULL,
  title TEXT,
  -- Prompt 7: cross-surface continuity.
  user_id TEXT,
  active_surface TEXT,
  ts_last_telegram_message TEXT,
  ts_last_web_message TEXT,
  ts_last_voice_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_specialist ON conversations(specialist_id, ts_last_message_at);
-- idx_conv_user_specialist created in open_db() AFTER the user_id column
-- migration runs, otherwise pre-Prompt-7 DBs error on a missing column.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  specialist_id TEXT,
  content_md TEXT NOT NULL,
  tool_calls_json TEXT,
  proposals_created_json TEXT,
  reasoning_trace_md TEXT,
  -- Prompt 7: which surface produced this message (web | telegram | voice | null/legacy).
  surface TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON messages(conversation_id, ts);

-- Agent rooms (2026-07-21): a multi-specialist group chat. A room reuses a
-- conversations row for its thread (messages/FTS/append/list all work
-- unchanged — each message already carries the speaker specialist_id), and
-- this table records WHO is in the room. A conversation is a room iff it has
-- rows here. Fresh table + own PK/index → no add_column-before-index hazard.
CREATE TABLE IF NOT EXISTS room_participants (
  conversation_id TEXT NOT NULL,
  specialist_id   TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (conversation_id, specialist_id)
);
CREATE INDEX IF NOT EXISTS idx_room_participants_conv ON room_participants(conversation_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content_md,
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  tokenize='porter unicode61'
);

-- append_message inserts into messages_fts keyed on the message's rowid.
-- Nothing deleted the FTS row when a message was deleted, so SQLite recycling
-- the freed rowid for a new message collided with the orphan FTS row
-- (SQLITE_CONSTRAINT_PRIMARYKEY) and crashed every chat turn (2026-06-22).
-- Auto-clean the FTS row on delete so orphans can never accumulate.
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS proposals_fts USING fts5(
  body,
  proposal_id UNINDEXED,
  specialist_id UNINDEXED,
  tokenize='porter unicode61'
);

-- ── Specialist visit tracking (Prompt 6c) ────────────────────────────────
-- Server-side "last opened" timestamp per specialist so the envelope-on-
-- new-message indicator stays consistent across browser tabs.
CREATE TABLE IF NOT EXISTS specialist_visits (
  specialist_id TEXT PRIMARY KEY,
  ts_last_visited TEXT NOT NULL
);

-- ── Briefs (Prompt 6c) ────────────────────────────────────────────────────
-- A brief is the structured product of a Kate deliberation pass at a
-- scheduled "report time" (07:00, 12:30, 18:00, 22:00). sections_json is
-- the JSON-serialized morning_brief envelope from PART 5.
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  ts_generated TEXT NOT NULL,
  generated_by_specialist_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  mood TEXT NOT NULL,
  consumed_at TEXT,
  -- user_id added 2026-05-27 so Kate's deliberation can produce one
  -- brief per household member. Pre-existing rows backfilled via
  -- ALTER TABLE migration below; new schemas (fresh installs) get
  -- the column from this CREATE. Routes filter on it.
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_ts ON briefs(ts_generated DESC);
CREATE INDEX IF NOT EXISTS idx_briefs_kind ON briefs(kind, ts_generated DESC);

-- ── Pending pushes (Prompt 7) ────────────────────────────────────────────
-- Pushes deferred by quiet hours, an APNs miss (no live token yet), or a
-- future-dated snooze. The 60s sweep in push.ts polls this table and
-- dispatches rows whose not_before time has passed.
CREATE TABLE IF NOT EXISTS pending_pushes (
  id TEXT PRIMARY KEY,
  ts_queued TEXT NOT NULL,
  ts_dispatched TEXT,
  user_chat_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  queued_reason TEXT NOT NULL,
  not_before TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_pushes_dispatch ON pending_pushes(ts_dispatched, not_before);

-- ── Per-user runtime KV (Prompt 7) ───────────────────────────────────────
-- Small JSON-blob store for things like active_specialist:<user_id>,
-- manual_quiet_mode:<user_id>, last_processed_telegram_message_id.
CREATE TABLE IF NOT EXISTS kv_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  ts_updated TEXT NOT NULL
);

-- ── Multi-user web sessions (Phase 1) ──────────────────────────────────
-- One row per logged-in browser. Cookie value = id (opaque ULID).
-- Sliding 30-day expiry: every authenticated request touches
-- last_seen_at and bumps expires_at forward. Revoke = DELETE the row.
-- IP/UA captured at create time for the /admin sessions table; not
-- used for re-validation (clients move networks).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── Bearer-auth devices (2026-05-25, hearth-ios BACKEND_AUTH_BRIEF) ─────
-- Long-lived per-device tokens for native clients (iOS first). Token is
-- emitted to the client exactly once at register time and stored
-- argon2id-hashed here. The plaintext token's prefix is the device id
-- so lookup is O(1) on auth (split bearer on first '.', look up by id,
-- verify the hash). Revocation is soft (revoked_at) so audit history
-- survives.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, revoked_at);

-- ── Step-up grants (PIN as second factor for high-risk actions) ─────────
-- A successful POST /api/auth/step_up writes one row. Subject is keyed
-- to either a cookie session ('session:<sid>') or a device bearer
-- ('device:<dev_id>'). Single-use: the first handler that calls
-- requireStepUp() and finds an active grant marks it consumed. 5-min
-- TTL keeps the window tight; brief explicitly chose explicit over implicit.
CREATE TABLE IF NOT EXISTS step_up_grants (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_up_subject ON step_up_grants(subject, expires_at);

-- ── Process misses (Part B) ──────────────────────────────────────────────
-- The closed-loop accountability ledger. A process miss is opened when a
-- specialist's work fell short; Mariah (the program manager) routes it,
-- drives a redo, verifies the redo, and closes it. Its own entity — not a
-- proposal (no approve/deny) and not an interrupt (it carries a real
-- multi-step lifecycle: open -> routed -> redo_dispatched -> verified ->
-- closed, with escalated as the structural-fix branch to Beatrice).
CREATE TABLE IF NOT EXISTS process_misses (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  subject_specialist_id TEXT NOT NULL,
  reporter TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  gap TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  routed_to TEXT,
  evidence_ref TEXT,
  notes_md TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_process_misses_status ON process_misses(status, ts_created);
CREATE INDEX IF NOT EXISTS idx_process_misses_subject ON process_misses(subject_specialist_id);

-- ── Library files (Phase 2 — the file manager) ───────────────────────────
-- The metadata index for ~/hearth-library/ — a categorized file store that
-- lives OUTSIDE the markdown vault (binaries don't belong in the vault).
-- The filesystem is authoritative for file existence; this table carries
-- the metadata a directory entry can't (source URL, description, tags, who
-- fetched it). LibraryStore reconciles the two on every list. rel_path is
-- relative to the library root and unique; id is a stable lib_ handle
-- the /files API and UI use to address a file.
CREATE TABLE IF NOT EXISTS library_files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  source_url TEXT,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  downloaded_at TEXT NOT NULL,
  downloaded_by TEXT NOT NULL,
  private_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_library_category ON library_files(category);
CREATE INDEX IF NOT EXISTS idx_library_filename ON library_files(filename);

-- ── Pending questions (present_questions tool) ───────────────────────────
-- A specialist may invoke present_questions mid-turn to surface 1-4
-- structured questions to Jasper instead of writing prose with implicit
-- decisions. Each row carries the questions, optional intro, an
-- association (conversation or brief), and (once Jasper answers) the
-- collected answers. Status walks pending → answered (or superseded
-- when a later set replaces an unanswered one).
CREATE TABLE IF NOT EXISTS pending_questions (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL,
  ts_answered TEXT,
  specialist_id TEXT NOT NULL,
  conversation_id TEXT,
  brief_id TEXT,
  anchor_message_id TEXT,
  intro_md TEXT,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_pending_questions_status ON pending_questions(status, ts_created);
CREATE INDEX IF NOT EXISTS idx_pending_questions_conv ON pending_questions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_questions_brief ON pending_questions(brief_id);

-- ── Authenticity scores (scan_specialist_authenticity, Pass B) ───────────
-- Per-specialist 0-100 score derived from Mariah's daily authenticity
-- scan. Recomputed at the end of every scan run; one row per specialist.
-- signals_json carries the raw counts (turns + by-pattern breakdown) so
-- the UI can render a breakdown without re-querying the audit log.
CREATE TABLE IF NOT EXISTS authenticity_scores (
  specialist_id TEXT PRIMARY KEY,
  ts_computed TEXT NOT NULL,
  score INTEGER NOT NULL,
  lookback_hours INTEGER NOT NULL,
  turns_in_window INTEGER NOT NULL,
  signals_json TEXT NOT NULL
);

-- ── Device-as-sensor pipeline (BACKEND_SENSORS_BRIEF 2026-05-25) ────────
-- Index for the iOS sensor stream. Per § 9 + § 1.5 of architecture.md,
-- the raw JSON payload lives inside the user's vault directory
-- (vault-friday/Users/<user_id>/sensors/<signal>/<YYYY-MM-DD>/<captured_at>-<id>.json);
-- SQLite carries only the metadata used to drive derived-signal
-- computation, the Settings → Sensors UI, and 90-day retention pruning.
-- payload_path is relative to the vault root so it survives a vault move.
CREATE TABLE IF NOT EXISTS sensor_packets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  signal TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sensor_packets_user_signal_ts
  ON sensor_packets (user_id, signal, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_packets_received
  ON sensor_packets (received_at);

-- Latest bulk-snapshot calendar packet per user. Snapshots are full-state
-- (not append) — iOS re-emits the whole window every 6h and on
-- EKEventStoreChangedNotification, so we DELETE+INSERT on each receipt
-- rather than accumulate. payload_path points at the JSON in the vault,
-- same convention as sensor_packets. window_start/window_end let
-- derived-signal queries avoid loading the file when the window doesn't
-- intersect the query.
CREATE TABLE IF NOT EXISTS calendar_snapshots (
  user_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  payload_path TEXT NOT NULL
);

-- Kate-as-filter queue (BACKEND_FILTER_BRIEF.md). One row per outbound
-- proposal that passes through emit_for_proposal_created. v0.1 is
-- *observe-only*: every proposal_created event still fires, the queue
-- just records what Kate's filter *would have done* so we can audit
-- the scorer before flipping the flag. Held / batched / dropped
-- dispositions become user-actionable in /api/kate/held; engaged_at
-- + outcome get backfilled when the user interacts.
--
-- precommit_pending columns are placeholders for a future ship — the
-- pre-commit action lane (Live Activity countdown) hasn't landed yet.
CREATE TABLE IF NOT EXISTS kate_filter_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- ProposalKind: draft_message | calendar_event | …
  category TEXT,                            -- safety | decision | social | finance | …
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,                 -- ISO-8601 when the upstream emit happened
  urgency_self INTEGER,                     -- 1–10 if the originator claimed urgency
  urgency_score REAL,                       -- 0–1 from the scorer
  disposition TEXT,                         -- deliver_now | batch | hold | drop | precommit_pending
  disposition_reason TEXT,                  -- one user-facing sentence
  delivered_at TEXT,                        -- ISO when the user-visible surface fired
  engaged_at TEXT,                          -- ISO of first user interaction
  outcome TEXT,                             -- engaged | dismissed | re_elevated | expired
  precommit_window_seconds INTEGER,         -- reserved for pre-commit lane
  precommit_executes_at TEXT                -- reserved for pre-commit lane
);
CREATE INDEX IF NOT EXISTS idx_kate_filter_queue_user_disp
  ON kate_filter_queue (user_id, disposition, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kate_filter_queue_user_recent
  ON kate_filter_queue (user_id, created_at DESC);

-- ── APNs device tokens (iOS push) ───────────────────────────────────────
-- One row per (device_token, environment). Composite primary key so a
-- TestFlight install (sandbox) and an App Store install (production) on
-- the same device get distinct entries — APNs treats sandbox/production
-- as completely separate keyspaces. Re-registration on the same env
-- updates last_seen. Dead tokens (410 from APNs) get hard-deleted by
-- the sender so we never push to a stale endpoint twice.
--
-- live_activity_push_token is OPTIONAL — populated when ActivityKit on
-- iOS hands the app a per-activity push-update token. Stored on the
-- DEVICE row (not a separate table) because a device has at most a
-- single in-flight pre-commit activity in v0.1; if multiple
-- concurrent activities are needed later, split into apns_la_tokens.
CREATE TABLE IF NOT EXISTS apns_tokens (
  user_id TEXT NOT NULL,
  device_token TEXT NOT NULL,
  environment TEXT NOT NULL,                  -- 'sandbox' | 'production'
  bundle_id TEXT NOT NULL,
  app_build TEXT,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  live_activity_push_token TEXT,              -- optional ActivityKit token
  live_activity_id TEXT,                      -- which Activity that token belongs to
  PRIMARY KEY (device_token, environment)
);
CREATE INDEX IF NOT EXISTS idx_apns_tokens_user ON apns_tokens(user_id);

-- ── Cordelia visual-understanding pipeline ─────────────────────────────
-- One row per routing decision the classifier makes for a Cordelia
-- capture. capture_id matches the c_xxxxxxxxxx id minted by
-- POST /api/cordelia/capture (also the clippings.id of the wrapper
-- note). A single capture may produce multiple routes when the
-- classifier picks more than one specialist (e.g. a prescription
-- photo that's relevant to both Anya and Kate); one row per
-- (capture_id, specialist_id). confidence is 0.0-1.0 from the
-- classifier. extracted_payload_json holds the shape-specific
-- extract (receipt fields, prescription fields, etc.) the intake
-- handler will read; route_reason is the one-sentence human
-- explanation.
CREATE TABLE IF NOT EXISTS capture_routes (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  route_reason TEXT NOT NULL,
  extracted_payload_json TEXT,
  routed_at TEXT NOT NULL,
  UNIQUE (capture_id, specialist_id)
);
CREATE INDEX IF NOT EXISTS idx_capture_routes_capture
  ON capture_routes (capture_id);
CREATE INDEX IF NOT EXISTS idx_capture_routes_specialist
  ON capture_routes (specialist_id, routed_at DESC);

-- Latest music-context snapshot per user. iOS posts the full state
-- (top artists last 90d, recently-played, library counts, starred
-- playlists) via POST /api/sensors/music_context on a daily cadence
-- (also on-foreground if stale >24h). Maggie's intake_band_poster
-- handler reads from this via query_music_context() to score
-- artist affinity without standing up server-side MusicKit. Mirrors
-- calendar_snapshots — full-state replace per upload, no append.
CREATE TABLE IF NOT EXISTS music_context (
  user_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

-- Workout session headers (Astrid Pass 3 — live workout coaching).
-- One row per session, written at workout_started + updated on
-- workout_completed. Heartbeat packets (during the session) don't
-- index here — they're transient and live in the in-memory
-- WorkoutSessionTracker, persisted only at session-end as part of
-- the final summary written to the vault. Completed sessions are
-- also written to sensor_packets as signal='healthkit' /
-- sample_type='workout' for the post-hoc summary path Pass 2 uses
-- (Brigid recovery-snack flag); this table carries the live-mode
-- bookkeeping (session_id stable across packets, PR comparison, etc.).
CREATE TABLE IF NOT EXISTS workout_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_active_kcal REAL,
  total_duration_s INTEGER,
  total_distance_m REAL,
  avg_hr REAL,
  max_hr REAL,
  hr_zone_minutes_json TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned'))
);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_started
  ON workout_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_type_status
  ON workout_sessions (user_id, workout_type, status);

-- Ride Log (Live Ride Companion Phase 2.5) — per-heartbeat time series,
-- one row per 30s heartbeat. This is what lets the workout detail
-- surfaces (iOS Ride Log + /app/rides) draw HR / pace / elevation
-- curves after the fact; before this table the only persisted shape
-- was the session header's latest rolling values. ~120 rows/hour of
-- riding — negligible. Kept forever (it's the user's training log);
-- rows are owner-cordoned through the session's user_id.
CREATE TABLE IF NOT EXISTS workout_heartbeats (
  session_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  elapsed_s INTEGER NOT NULL,
  active_kcal REAL,
  distance_m REAL,
  current_hr REAL,
  current_hr_zone INTEGER,
  elevation_gain_m REAL,
  PRIMARY KEY (session_id, elapsed_s)
);
CREATE INDEX IF NOT EXISTS idx_workout_heartbeats_session
  ON workout_heartbeats (session_id, captured_at);

-- Upcoming shows Maggie is tracking for the user — the structured
-- backing for the Listening pane's "Coming to town" section AND the
-- check_show_status tool's ticket-status writes. Maggie's deliberation
-- discovers shows via her existing concert-research workflow and calls
-- check_show_status as the all-in-one "capture + verify tickets"
-- step; the row carries enough provenance (source_url, rationale,
-- affinity_at_capture) to render a glanceable list block without
-- re-reading memory.md. Idempotent on (user_id, artist, venue,
-- show_date) so a re-discovery of the same show updates last_seen_at
-- + ticket_status rather than inserting a duplicate.
--
-- ticket_status values:
--   - 'available'    — tickets confirmed available at primary
--   - 'low'          — primary inventory thin / "last few"
--   - 'sold_out'     — primary sold out; resale may exist
--   - 'resale_only'  — explicit resale-platform-only signal
--   - 'unknown'      — Maggie discovered the show but hasn't / couldn't
--                      check tickets yet (default for fresh rows; also
--                      the fallback when the fetch errors)
--
-- The Listening pane filters Coming to town to non-sold_out rows so a
-- sold-out marquee never reads as "the room." check_show_status
-- updates ticket_status_checked_at on every call so a stale check is
-- visible at the pane layer; "checked >7d ago" can render with a hint.
CREATE TABLE IF NOT EXISTS upcoming_shows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  artist TEXT NOT NULL,
  venue TEXT NOT NULL,
  city TEXT,
  show_date TEXT NOT NULL,
  tickets_url TEXT,
  source_url TEXT,
  ticket_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ticket_status IN ('available', 'low', 'sold_out', 'resale_only', 'unknown')),
  ticket_status_checked_at TEXT,
  ticket_status_signals_json TEXT,
  affinity_at_capture INTEGER,
  rationale TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (user_id, artist, venue, show_date)
);
CREATE INDEX IF NOT EXISTS idx_upcoming_shows_user_date
  ON upcoming_shows (user_id, show_date);
CREATE INDEX IF NOT EXISTS idx_upcoming_shows_user_status_date
  ON upcoming_shows (user_id, ticket_status, show_date);

-- Maggie's thematic media recommendations — the structured store behind
-- the Listening pane's "Worth a look" section. Replaces the old
-- propose_action({kind:'recommendation'}) path that shoved advisory media
-- picks (with no execution affordance — "ask Cordelia to add it") through
-- the Approve/Edit/Deny proposal rail. Picks now land here and surface in
-- Maggie's office; only a standout pick is flagged to Kate for the brief.
-- The suggest_media tool dedups against the *arr/Plex library BEFORE
-- inserting (media_search.in_library) so an already-owned title (e.g.
-- Severance already in Plex) never surfaces. dedup_key = media_kind + a
-- normalized title so re-suggesting across passes is idempotent.
-- status: active (in the pane) | added (Jasper had Cordelia acquire it) |
-- dismissed (he passed). media_kind buckets the app the dedup check hit.
CREATE TABLE IF NOT EXISTS media_recommendations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  media_kind TEXT NOT NULL
    CHECK (media_kind IN ('movie', 'tv', 'music', 'book')),
  rationale TEXT NOT NULL,
  profile_match TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'added', 'dismissed')),
  dedup_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_media_recs_user_status_seen
  ON media_recommendations (user_id, status, last_seen_at DESC);

-- Per-user specialist UI preferences — favorites + display order.
-- Powers (a) the iOS Today bento's "favorited specialists first"
-- sort, (b) the Staff roster's drag-reorder. Single table because
-- favorites are a binary mark on the same ordered list — see the
-- ship entry in the private shipped-log archive and the design
-- decision in PLAN.md "Star to favorite + drag-reorder."
-- Absent row = unfavorited + no explicit position (client falls
-- back to alphabetic). Specialist deletions don't cascade — a
-- stale prefs row for a removed specialist is harmless; the join
-- against the live registry drops it silently.
CREATE TABLE IF NOT EXISTS specialist_prefs (
  user_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  favorited INTEGER NOT NULL DEFAULT 0 CHECK (favorited IN (0, 1)),
  sort_order INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, specialist_id)
);
CREATE INDEX IF NOT EXISTS idx_specialist_prefs_user_order
  ON specialist_prefs (user_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_specialist_prefs_user_fav
  ON specialist_prefs (user_id, favorited, sort_order);

-- Ruby's civic findings — the structured store behind her civic office
-- pane (Pleasantville Civic Correspondent). Ruby's deliberation captures
-- findings via the record_civic_item tool rather than only free-form
-- memory.md, so the office reads them with cheap SQL and ranks by
-- interest_score. kind buckets the pane's sections; event_at is the
-- meeting/agenda/event time when one applies (drives the "next council
-- meeting" hero + chronological ordering); interest_score 0..1 splits
-- the at-a-glance items (>= threshold) from the scrollable "also watching"
-- outskirts; corridor_match is set when the item's location falls on one
-- of Jasper's learned location corridors (see location_corridors); dedup_key
-- makes re-capture idempotent across deliberation passes (UNIQUE per user).
CREATE TABLE IF NOT EXISTS civic_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('council_meeting','agenda_item','new_in_town','corridor_alert','announcement','watching')),
  title TEXT NOT NULL,
  summary TEXT,
  event_at TEXT,
  url TEXT,
  location_label TEXT,
  lat REAL,
  lon REAL,
  corridor_match TEXT,
  interest_score REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','dismissed','expired')),
  dedup_key TEXT NOT NULL,
  source TEXT,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_civic_items_user_status_score
  ON civic_items (user_id, status, interest_score DESC);
CREATE INDEX IF NOT EXISTS idx_civic_items_user_kind_event
  ON civic_items (user_id, kind, event_at);
-- Cassandra's face-enrollment roster (the People room of her office).
-- One row per enrolled person; the biometric embedding itself lives in the
-- CodeProject.AI server, keyed by cpai_userid. Hearth holds only roster
-- metadata + a pointer to the owner-private enrollment photos on disk.
-- Owner-scoped by user_id; this table never enters the cordon/RAG/search
-- machinery (it is not a clipping/library row), so no private_to column.
-- cpai_userid is a slug of the display name so CPAI stays human-debuggable.
CREATE TABLE IF NOT EXISTS enrolled_persons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cpai_userid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  relationship TEXT,
  image_count INTEGER NOT NULL DEFAULT 0,
  -- Vault-relative dir holding the enrollment photos (owner-private; raw
  -- bytes, never a markdown note, so nothing for the ingestor/RAG to index).
  photo_rel_dir TEXT,
  created_at TEXT NOT NULL,
  last_recognized_at TEXT,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, cpai_userid)
);
CREATE INDEX IF NOT EXISTS idx_enrolled_persons_user
  ON enrolled_persons (user_id, ts_updated DESC);


-- Linda's marketplace listing drafts. One row per item a seller hands
-- her; listings_json holds the three platform drafts she composed (eBay /
-- Poshmark / Facebook Marketplace) plus their per-platform fields. Scoped
-- per user_id so friend-tier sellers (e.g. Kim) are isolated from the
-- owner and from each other; dedup_key keys off the source capture / item
-- so a re-draft upserts in place rather than piling up duplicates.
CREATE TABLE IF NOT EXISTS listing_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  conversation_id TEXT,
  item_title TEXT NOT NULL,
  listings_json TEXT NOT NULL,
  comps_summary TEXT,
  source_capture_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','archived')),
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_listing_drafts_user
  ON listing_drafts (user_id, ts_updated DESC);
CREATE INDEX IF NOT EXISTS idx_listing_drafts_conversation
  ON listing_drafts (conversation_id, ts_created);

-- Linda's resale sales ledger — the outcome layer over listing_drafts. One
-- row per item the seller actually ran, tracked through its lifecycle
-- (active to sold/unsold/archived): which marketplace she chose, when she
-- listed it, at what price, any markdowns (price_drops_json), and the final
-- sale price. cost_basis + fees are optional and feed profit/margin. Scoped
-- per user_id so friend-tier sellers (e.g. Kim) stay isolated; dedup_key
-- keys off the listing_draft / source capture / item so a lifecycle update
-- upserts in place. This is what Linda''s resale office pane reads and what
-- a later pass mines to narrow pricing recommendations.
CREATE TABLE IF NOT EXISTS resale_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  listing_draft_id TEXT,
  source_capture_id TEXT,
  item_title TEXT NOT NULL,
  category TEXT,
  platform TEXT
    CHECK (platform IS NULL OR platform IN ('ebay','poshmark','facebook','other')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','sold','unsold','archived')),
  list_price REAL,
  listed_at TEXT,
  price_drops_json TEXT,
  sold_price REAL,
  sold_at TEXT,
  cost_basis REAL,
  fees REAL,
  notes TEXT,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_resale_items_user_status
  ON resale_items (user_id, status, ts_updated DESC);
CREATE INDEX IF NOT EXISTS idx_resale_items_user_sold
  ON resale_items (user_id, sold_at);

-- ── Beatrice's scrum / dev-board ────────────────────────────────────────────
-- An AI-run scrum board Beatrice grooms for building Hearth itself, adapted
-- from the scrum-starter-kit blueprint: projects → epics (the unit of work,
-- sized S/M/L for effort AND value → roi = value/effort) living in one of five
-- lanes, weekly sprints holding a committed-epic set, and a lane-transition
-- event log (the metrics gold the blueprint warns never to skip). Two
-- refinements on the blueprint: epics carry a type (feature | bug) and bugs a
-- severity, so the board tracks feature-adds AND bug-adds and a critical bug
-- can outrank a high-ROI feature at grooming. The board partition is repurposed
-- to backend|ios (the two repos) -- ONE sprint + ONE capacity pool across both,
-- per the blueprint's hard rule. System-global (no user_id): owner-only internal
-- dev work, same scoping as beatrice_changes. Decisions are NOT a table here --
-- a blocking judgment call is filed as a scrum_decision proposal so it lands in
-- the one "awaiting you" queue (push + step-up) the rest of Hearth already uses,
-- rather than a parallel decision inbox.
CREATE TABLE IF NOT EXISTS scrum_projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  board       TEXT NOT NULL DEFAULT 'backend'
    CHECK (board IN ('backend','ios')),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  archived    INTEGER NOT NULL DEFAULT 0,
  ts_created  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrum_sprints (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  start_date    TEXT NOT NULL,           -- ISO YYYY-MM-DD
  end_date      TEXT NOT NULL,           -- ISO YYYY-MM-DD
  capacity_pts  INTEGER NOT NULL DEFAULT 10,
  committed_ids TEXT,                    -- JSON array of committed epic ids
  committed_at  TEXT,                    -- when planning closed
  closed_at     TEXT,                    -- when the sprint ended
  notes         TEXT,
  ts_created    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrum_epics (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES scrum_projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'feature'
    CHECK (type IN ('feature','bug')),
  size        TEXT CHECK (size  IS NULL OR size  IN ('S','M','L')),   -- effort
  value       TEXT CHECK (value IS NULL OR value IN ('S','M','L')),   -- impact (features)
  value_note  TEXT,
  severity    TEXT CHECK (severity IS NULL OR severity IN ('critical','high','medium','low')),  -- bugs
  description TEXT,
  lane        TEXT NOT NULL DEFAULT 'product_backlog'
    CHECK (lane IN ('product_backlog','sprint_backlog','in_progress','review','done')),
  board       TEXT CHECK (board IS NULL OR board IN ('backend','ios')),  -- nullable per-epic override
  sprint_id   TEXT REFERENCES scrum_sprints(id),
  position    REAL NOT NULL DEFAULT 65536,   -- ordering within lane (insert at max+1024)
  source_key  TEXT,                          -- importer dedup key, e.g. 'next:0d' (re-runnable upsert)
  ts_created  TEXT NOT NULL,
  ts_updated  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrum_epics_project_lane ON scrum_epics(project_id, lane);
CREATE INDEX IF NOT EXISTS idx_scrum_epics_sprint ON scrum_epics(sprint_id);
-- NOTE: the source_key index is created in the migrations block below, AFTER the
-- add_column_if_missing — an existing scrum_epics table won't have the column
-- when SCHEMA_SQL runs, so indexing it here would throw before the ALTER.

-- DO NOT SKIP: lane-transition event log. Write a row on EVERY move (the
-- blueprint's hard-won lesson — without it, cycle-time / lane-age / throughput
-- are unrecoverable from ts_updated alone).
CREATE TABLE IF NOT EXISTS scrum_epic_events (
  id          TEXT PRIMARY KEY,
  epic_id     TEXT NOT NULL REFERENCES scrum_epics(id) ON DELETE CASCADE,
  from_lane   TEXT,
  to_lane     TEXT NOT NULL,
  sprint_id   TEXT REFERENCES scrum_sprints(id),
  actor       TEXT,                      -- 'beatrice' | 'human' | 'system'
  ts_created  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrum_epic_events_epic ON scrum_epic_events(epic_id, ts_created);

CREATE TABLE IF NOT EXISTS scrum_retros (
  id          TEXT PRIMARY KEY,
  sprint_id   TEXT NOT NULL REFERENCES scrum_sprints(id),
  went_well   TEXT,
  slipped     TEXT,
  lessons     TEXT,
  ts_created  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrum_notes (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES scrum_projects(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'fyi'
    CHECK (kind IN ('fyi','progress','observation')),
  pinned       INTEGER NOT NULL DEFAULT 0,
  dismissed_at TEXT,
  ts_created   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrum_notes_active
  ON scrum_notes (dismissed_at) WHERE dismissed_at IS NULL;

-- Beatrice change-control ledger. One row per change the trainer meta-agent
-- proposes (config tuning via apply_low_risk_fix OR code via propose_code_change),
-- each tied to an isolated beatrice/* branch + PR. Carries the embedded diff
-- (Kate reviews this without repo-read access), code metrics (LOC / languages /
-- coding tok-per-sec) shown in the Code Shop office, Kate's skeptic verdict, and
-- the lifecycle status. System-global (no user_id) — owner-scoped self-improve.
-- The non-bypassable merge gate: merge_approved_change refuses any status other
-- than pending_owner_merge (only Kate's approval moves a row there).
CREATE TABLE IF NOT EXISTS beatrice_changes (
  id TEXT PRIMARY KEY,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  origin TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  target_specialist_id TEXT,
  branch TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  commit_sha TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  languages_json TEXT NOT NULL DEFAULT '[]',
  diff_summary TEXT NOT NULL DEFAULT '',
  diff_truncated INTEGER NOT NULL DEFAULT 0,
  rationale_md TEXT NOT NULL DEFAULT '',
  dedup_key TEXT,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending_kate_review'
    CHECK (status IN ('pending_kate_review','pending_owner_merge','merged','denied_by_kate','superseded','merge_failed')),
  kate_verdict TEXT
    CHECK (kate_verdict IS NULL OR kate_verdict IN ('approve','approve_with_concerns','deny')),
  kate_reasons_md TEXT,
  related_proposal_id TEXT,
  gen_tokens_out INTEGER,
  gen_ms REAL,
  gen_tok_per_sec REAL,
  merged_at TEXT,
  merged_sha TEXT,
  audit_id TEXT,
  -- Deterministic-gate verdict (tsc --noEmit + guard) at PR-open time. A red
  -- change throws before a record is created, so a stored row is GREEN (1) or
  -- NULL (test-mode / legacy / not opened through the pipeline); false (0) is a
  -- defense-in-depth backstop the Kate-review gate hard-refuses to approve.
  -- NO index references these columns (a CREATE INDEX on a column added by ALTER
  -- only — before the ALTER runs — is the boot-only crash class; these are plain
  -- additive columns).
  checks_passed INTEGER,
  checks_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_bchanges_status ON beatrice_changes (status, ts_created DESC);
CREATE INDEX IF NOT EXISTS idx_bchanges_dedup ON beatrice_changes (dedup_key);

-- Utility readings — Anna's energy/water time series, parsed from uploaded
-- utility bills (Cordelia → intake_utility_bill). Shared in the main DB on
-- purpose: Anna analyses usage, Vivian reads the cost trend. One row per bill
-- per service period; (private_to, provider, period) is the natural key so a
-- re-upload of the same bill upserts instead of duplicating.
CREATE TABLE IF NOT EXISTS utility_readings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  utility_provider TEXT,
  service TEXT,                 -- 'electric' | 'gas' | 'water' | 'combined'
  period_start TEXT,
  period_end TEXT,
  electric_kwh REAL,
  gas_therms REAL,
  water_gallons REAL,
  electric_cost REAL,
  gas_cost REAL,
  water_cost REAL,
  total_cost REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  account_number TEXT,
  source_capture_id TEXT,
  source_note_path TEXT,
  extractor_confidence REAL,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_utility_readings_user
  ON utility_readings (user_id, period_end DESC);

-- Ruby's civic intelligence (Pleasantville city desk). civic_members +
-- civic_votes turn her from a news scraper into an analyst who can answer
-- "how did Councilmember X vote on Y" across time; civic_watch_events is a
-- dated per-issue timeline — one row per DEVELOPMENT, so a story's arc is
-- reconstructable and its liveness is DERIVED from when it last moved
-- (summarize_watch_topics in civic_analysis.ts), never stored. User-scoped,
-- Ruby-owned. Votes REQUIRE a source_url — no civic claim lands without a
-- citation (the verification floor).
CREATE TABLE IF NOT EXISTS civic_members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  district TEXT,
  term TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  source_url TEXT,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_civic_members_user_active ON civic_members(user_id, active);

CREATE TABLE IF NOT EXISTS civic_votes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  member_id TEXT,
  member_name TEXT NOT NULL,
  meeting_id TEXT,
  meeting_date TEXT,
  item_title TEXT NOT NULL,
  vote TEXT NOT NULL
    CHECK (vote IN ('aye','nay','abstain','absent','recused')),
  outcome TEXT,
  source_url TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_civic_votes_user_member ON civic_votes(user_id, member_name);
CREATE INDEX IF NOT EXISTS idx_civic_votes_user_item ON civic_votes(user_id, item_title);

CREATE TABLE IF NOT EXISTS civic_watch_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  headline TEXT NOT NULL,
  detail TEXT,
  event_at TEXT NOT NULL,
  -- The state of the TOPIC as of this development. 'resolved' / 'dormant'
  -- on the newest event is Ruby closing the story by hand; the age-based
  -- close is derived, so most rows stay 'open' and the board still ages.
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','dormant')),
  -- Why this cleared the bar for tracking, stated when the story opened
  -- (proximity, money, a pending decision, a scheduled vote, recurrence,
  -- direct effect on the household). Makes the board auditable: a topic
  -- whose reason no longer holds is one to close. Added 2026-07-28.
  why_tracked TEXT,
  source_url TEXT,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_civic_watch_topic ON civic_watch_events(user_id, topic, event_at DESC);

-- A civic CAMPAIGN — the household acting on a story, not just following
-- it (2026-07-28). A watch topic answers "what happened"; a campaign
-- answers "what do we want, who decides it, when is it decidable, and
-- what work is running." It composes rather than duplicates: the factual
-- spine is the linked watch topic's timeline, the deep background is
-- linked deep_research investigations, and the deliverable Jasper actually
-- sends or reads aloud still ships through propose_action. Campaigns
-- close like stories do — won / lost / closed — so the board can't
-- accumulate dead crusades. User-scoped, Ruby-owned.
CREATE TABLE IF NOT EXISTS civic_campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  -- What's at stake for THIS household — the tracking criteria made explicit.
  stake_md TEXT,
  -- What we want to happen, and the argument for it.
  position_md TEXT,
  -- The 90-second version: what Jasper says at the podium or in the email.
  talking_points_md TEXT,
  -- JSON array of who can actually decide it (a body, a member, staff).
  targets TEXT,
  -- The next moment the outcome can move, and when.
  next_milestone TEXT,
  next_milestone_at TEXT,
  -- The watch topic whose timeline is this campaign's factual spine.
  watch_topic TEXT,
  -- JSON array of deep_research investigation ids working this campaign.
  investigation_ids TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','won','lost','closed')),
  outcome_md TEXT,
  dedup_key TEXT NOT NULL,
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_civic_campaigns_user_status
  ON civic_campaigns (user_id, status, ts_updated DESC);

-- Jasper's learned location "corridors" — clusters of where he actually
-- goes, built by Ruby's cluster_location_corridors background job from
-- the location sensor_packets stream (visit / region / significant-change
-- events). Powers corridor-affinity scoring: a civic traffic / construction
-- item whose location falls within radius_m of a corridor is promoted in
-- Ruby's office (the music-affinity pattern applied to geography). Refines
-- over time as location history accumulates — a low visit_count corridor is
-- noise until it earns its place. center_* is a running centroid; radius_m
-- is derived from member spread (floored so a single anchor still has a
-- sensible catchment).
CREATE TABLE IF NOT EXISTS location_corridors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  center_lat REAL NOT NULL,
  center_lon REAL NOT NULL,
  radius_m REAL NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, label)
);
CREATE INDEX IF NOT EXISTS idx_location_corridors_user
  ON location_corridors (user_id, visit_count DESC);

-- Live episode ledger for the deterministic safety alerters (2026-07-27).
-- EpisodicAlertEngine's contract is "GENTLE = ONCE PER EPISODE" — an ongoing
-- danger alerts once and stays silent until it has been ABSENT for a full
-- clear-gap. That ledger used to live only in a process-local Map, so every
-- orchestrator restart re-fired every ongoing danger as 'fresh'. For a CHRONIC
-- condition (basement radon parked above its threshold) that meant a push on
-- every single deploy — 41 radon pushes, clustered entirely on deploy-heavy
-- days. Persisting it makes the once-per-episode contract hold across the
-- process lifecycle, which is what it always meant.
-- The scope column namespaces the driver (air / weather / house) so keys can't
-- collide; rows are DELETED when an episode ends, so this stays tiny (one row
-- per currently-active danger, normally zero).
CREATE TABLE IF NOT EXISTS alert_episodes (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  last_delivered_ms INTEGER NOT NULL,
  last_seen_current_ms INTEGER NOT NULL,
  worst_band INTEGER NOT NULL DEFAULT 0,
  tone TEXT NOT NULL DEFAULT 'notice',
  PRIMARY KEY (scope, key)
);

-- Behavioral eval results (2026-06-10) — one row per golden-task run.
-- The eval harness (src/core/evals) replays curated past-failure
-- scenarios (fixture tool results, REAL model) nightly; Mariah reads
-- pass rates and a pass-to-fail regression files a process_miss keyed
-- 'eval:<task_id>' (the evidence_ref chokepoint dedups recurrences).
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  task_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_task ON eval_runs (task_id, ts DESC);

-- Eval TRACES (2026-08-03) — the evidence a failure leaves behind, kept only
-- for failures. eval_runs.detail answers "what broke" in 1000 chars; it
-- cannot answer "WHY", which is what a fix has to be grounded in. One row per
-- failing run, carrying the assertions that failed, the full reply, and the
-- tool calls WITH their args and errors (the runtime already produces all of
-- this in SpecialistTurnOutput.tool_calls_made — the harness was discarding it).
-- Read by src/core/eval_diagnosis.ts. Passing runs write nothing: a green
-- trace has no consumer and this table would otherwise grow by the whole suite
-- every night.
CREATE TABLE IF NOT EXISTS eval_traces (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  task_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  failed_assertions_json TEXT NOT NULL DEFAULT '[]',
  reply TEXT NOT NULL DEFAULT '',
  calls_json TEXT NOT NULL DEFAULT '[]',
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_traces_task ON eval_traces (task_id, ts DESC);

-- Skills (2026-08-03) — Tier-1 procedural memory. A recipe a specialist worked
-- out once, written down as DATA and read back as prose. See src/core/skills.ts
-- for the invariant that makes this cheap: a skill is a DOCUMENT, never a
-- program — the runtime renders it and the model still makes every tool call
-- itself through the ordinary gated dispatch, so a skill can never widen what a
-- specialist may do. UNIQUE(specialist_id, name) is what makes re-learning a
-- name an overwrite-and-reset rather than a duplicate.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  specialist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'shadow',
  learned_from TEXT NOT NULL DEFAULT '',
  invocations INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  dismissals INTEGER NOT NULL DEFAULT 0,
  ts_created TEXT NOT NULL,
  ts_last_used TEXT,
  UNIQUE (specialist_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_live ON skills (specialist_id, status);

-- News items (2026-06-10) - discrete headlines parsed from FEED-shaped
-- source subscriptions by the nightly refresh (src/core/feed_parse.ts).
-- The News Desk in Kate's office reads these; the library shelf keeps a
-- clean markdown digest of the same items for RAG. One row per story,
-- keyed on link (INSERT OR IGNORE - re-fetches never duplicate).
-- category mirrors the subscription entry's category at fetch time.
CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  link TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  category TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_items_cat ON news_items (category, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_fetched ON news_items (fetched_at DESC);

-- Kate's Read (2026-06-10) - her grounded takes over the News Desk.
-- One row per take per compose run (history kept; readers take the
-- latest per category). category NULL = the desk-wide lead take.
-- cited_links is a JSON array of news_items.link values the take is
-- grounded on - the composer drops any take whose citations do not
-- resolve against news_items (no citations, no take).
CREATE TABLE IF NOT EXISTS news_takes (
  id TEXT PRIMARY KEY,
  category TEXT,
  take_md TEXT NOT NULL,
  cited_links TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_takes_cat ON news_takes (category, ts DESC);

-- Vivian's Market Radar (2026-06-12) - momentum snapshots behind the
-- fuel office's second tab. One row per (run, theme, symbol); a run is
-- one refresh_market_radar background-job firing over the
-- config/market-themes.yaml universes. Readers take the latest run;
-- history is kept ~14 days (the job prunes) for future trend deltas.
-- momentum_score is relative WITHIN a theme universe (rank-percentile),
-- so the cross-theme spotlight ranks on the raw return columns instead.
CREATE TABLE IF NOT EXISTS market_radar_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  theme TEXT NOT NULL,
  theme_label TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  momentum_score INTEGER NOT NULL,
  r_1mo_pct REAL,
  r_3mo_pct REAL,
  pct_off_52w_high REAL,
  volume_surge REAL,
  rsi_14 REAL,
  annualized_volatility_pct REAL,
  max_drawdown_3mo_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_market_radar_run ON market_radar_snapshots (run_id, theme, momentum_score DESC);
CREATE INDEX IF NOT EXISTS idx_market_radar_ts ON market_radar_snapshots (ts DESC);

-- Research commissions (2026-06-11) - Cordelia's durable deep-research
-- jobs (src/specialists/cordelia/research_runner.ts). One row per
-- commissioned repository build: plan/progress/results persist here so
-- a run survives restarts and advances in bounded slices (the detached
-- kick after commission_research, plus the nightly
-- advance_research_commissions background job). JSON columns hold the
-- planner plan, runner cursor state, and the shelved/proposed/skipped
-- ledgers; statuses walk pending - acquiring - synthesizing - done
-- (failed/cancelled terminal).
CREATE TABLE IF NOT EXISTS research_commissions (
  id TEXT PRIMARY KEY,
  target_specialist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  seed_urls TEXT NOT NULL DEFAULT '[]',
  depth TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  private_to TEXT,
  plan_json TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  shelved_json TEXT NOT NULL DEFAULT '[]',
  proposed_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  index_note_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_commissions_status
  ON research_commissions (status, created_at DESC);

-- Deep-research investigations (2026-06-19) - subject-oriented detached
-- deep research. One row per "deep research X" ask Kate hands off. Sibling
-- of research_commissions, but question/dossier-oriented (not roster/catalog):
-- the runner (src/specialists/kate/research_investigation_runner.ts) advances
-- it in bounded slices - plan, investigate (parallel sub-investigators),
-- verify, synthesize. JSON columns hold the sub-questions, per-sub-question
-- findings + cited sources, the verification verdicts, the runner state, and
-- the synthesized cited dossier. Statuses walk pending - planning -
-- investigating - verifying - synthesizing - done (failed/cancelled terminal).
CREATE TABLE IF NOT EXISTS research_investigations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'general',
  brief TEXT NOT NULL,
  person_id TEXT,
  depth TEXT NOT NULL DEFAULT 'deep',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  -- Which SPECIALIST filed it. The dossier shelves to this specialist's
  -- library, so a research front other than Kate can actually read its own
  -- work back (2026-07-29). NULL = pre-column rows, which shelved to Kate.
  agent_id TEXT,
  private_to TEXT,
  conversation_id TEXT,
  plan_json TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  findings_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT,
  dossier_md TEXT,
  dossier_note_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_investigations_status
  ON research_investigations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_investigations_user
  ON research_investigations (requested_by, created_at DESC);

-- Persisted source BODIES for deep-research investigations (Deep Research v2
-- phase 1, 2026-07-29). Until this table existed a sub-investigator fetched a
-- page, fed 6k characters to the extractor, and threw the text away - so the
-- verifier had no corpus and graded findings against themselves (a tautology
-- that returned zero verdicts on a dossier carrying a false claim), a page's
-- own publication date was unrecoverable, and the synthesiser could not anchor
-- a verbatim quote. One row per (investigation, url), upserted so a resumed
-- phase refreshes rather than duplicates. body_md is CAPPED and truncation is
-- recorded, so a failed quote check downstream can tell "the page does not say
-- that" from "we only kept the first N chars". content_hash is sha256 of the
-- FULL fetched text. published_at is a best-effort date parsed from the page
-- itself and is NEVER the fetch date standing in for it. Bodies expire on a
-- retention window swept by the runner. Cordon: private_to mirrors the
-- investigation row - the owner has NO god-view of a member's evidence trail.
-- Additive table, no SCHEMA_VERSION bump. See src/memory/stores/research_sources.ts.
CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  sub_question_id TEXT,
  url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  title TEXT,
  body_md TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  publisher TEXT,
  published_at TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  body_chars INTEGER NOT NULL DEFAULT 0,
  private_to TEXT,
  UNIQUE (investigation_id, url)
);
CREATE INDEX IF NOT EXISTS idx_research_sources_investigation
  ON research_sources (investigation_id, fetched_at ASC);
-- Retention sweep scans by fetch age across all investigations.
CREATE INDEX IF NOT EXISTS idx_research_sources_fetched
  ON research_sources (fetched_at);

-- Kate sub-agent delegations (2026-07-03) - one row per delegated task run
-- through the DelegationRunner (src/core/delegation.ts). A quick delegation
-- that finishes inside the wall cap completes synchronously; one that
-- overruns (or a background dispatch) completes detached and reports back
-- via a specialist-inbox FYI to the requester. digest_md is the bounded,
-- self-contained result the requester reads; user_id cordons status reads.
-- Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  task TEXT NOT NULL,
  context TEXT,
  mode TEXT NOT NULL DEFAULT 'quick',
  status TEXT NOT NULL DEFAULT 'running',
  user_id TEXT,
  conversation_id TEXT,
  digest_md TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegations_requester
  ON delegations (requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegations_status
  ON delegations (status, created_at DESC);

-- Review swarm (2026-07-21) — a red/blue/judge bench of critic sub-agents over
-- ONE Beatrice code change. swarm_reviews is one run; swarm_findings is its
-- ledger. Inform-only: Kate still rules + the owner still merges. Additive
-- On the Fire (2026-07-30) — per-user dismissals of ledger rows.
--
-- The ONLY table core/jobs.ts writes, and deliberately so: a dismissal is view
-- state about the LEDGER, not about the domain row. The projection stays
-- read-only over media_archive_jobs / research_investigations / swarm_reviews —
-- clearing a finished download from your pane must never touch the download.
--
-- Keyed by (user_id, job_key) where job_key is kind:id, so two users
-- clear independently and a household member's tidy-up is invisible to the
-- owner. Brand-new table, so the index is safe in SCHEMA_SQL.
CREATE TABLE IF NOT EXISTS job_dismissals (
  user_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (user_id, job_key)
);
CREATE INDEX IF NOT EXISTS idx_job_dismissals_user ON job_dismissals (user_id, ts DESC);

-- tables (brand-new, so a SCHEMA_SQL index here is safe); DARK behind
-- HEARTH_REVIEW_SWARM. The iOS bee icon + web Code Shop panel read these.
CREATE TABLE IF NOT EXISTS swarm_reviews (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  title TEXT NOT NULL DEFAULT '',
  bench_json TEXT NOT NULL DEFAULT '[]',
  user_id TEXT,
  started_at TEXT NOT NULL,
  judged_at TEXT,
  -- Higher court (2026-07-21): a block verdict from the bench escalates ONCE to
  -- a deeper, decorrelated bench. tier='bench' is the first pass; 'higher_court'
  -- is the appeal, with escalated_from pointing at the review it is appealing.
  tier TEXT NOT NULL DEFAULT 'bench',
  escalated_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_swarm_reviews_change
  ON swarm_reviews (change_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_reviews_status
  ON swarm_reviews (status, started_at DESC);
CREATE TABLE IF NOT EXISTS swarm_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  refuted INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swarm_findings_review
  ON swarm_findings (review_id, ts);

-- System-health incidents (2026-06-20) - one OPEN row per degraded/down
-- dependency (recovered_at IS NULL while open; closed rows are history). The
-- scan (Kate's scan_system_health) opens an incident on a flip-to-down EDGE
-- and escalates ONCE; while down it bumps last_checked; on recovery it stamps
-- recovered_at. first_seen gives an honest "down for N days". restart_attempts
-- + last_restart_at back Beatrice's restart circuit-breaker. Additive table;
-- no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS health_incidents (
  id TEXT PRIMARY KEY,
  dependency TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT,
  first_seen TEXT NOT NULL,
  last_checked TEXT NOT NULL,
  recovered_at TEXT,
  restart_attempts INTEGER NOT NULL DEFAULT 0,
  last_restart_at TEXT,
  -- observations: consecutive scans seen down (alert-hysteresis input).
  -- alerted_at: the one time the scan escalated to the owner. A blip that
  -- self-heals before crossing the alert threshold never stamps alerted_at,
  -- so the owner is never paged about it (2026-06-28 firecrawl noise fix).
  observations INTEGER NOT NULL DEFAULT 1,
  alerted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_incidents_open
  ON health_incidents (dependency, recovered_at);

-- health_diagnoses — the self-diagnosis + scored-fix ledger (2026-06-20).
-- When Kate's scan flags a dependency down, Beatrice's diagnose_dependency
-- tool gathers an evidence pack (container logs + audit error samples + config)
-- and the LOCAL deep model produces a grounded root-cause diagnosis plus N
-- typed, adversarially-scored candidate fixes. One row per diagnosis run.
-- root_cause is the grounded narrative; fixes_json is the ranked scored fix
-- list; recommended_index points at the pick (-1 = escalate). proposal_id links
-- the owner-facing recommendation card. Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS health_diagnoses (
  id TEXT PRIMARY KEY,
  dependency TEXT NOT NULL,
  incident_id TEXT,
  root_cause TEXT NOT NULL,
  inconclusive INTEGER NOT NULL DEFAULT 0,
  confidence REAL,
  diagnosis_md TEXT,
  fixes_json TEXT,
  recommended_index INTEGER NOT NULL DEFAULT -1,
  evidence_json TEXT,
  ungrounded_json TEXT,
  model TEXT,
  proposal_id TEXT,
  applied_fix_json TEXT,
  status TEXT NOT NULL DEFAULT 'diagnosed',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_diagnoses_dep
  ON health_diagnoses (dependency, created_at);

-- Cordelia's shelf-synthesis pass (consolidation cycle Phase 1, 2026-06-14).
-- One row per library shelf. last_synthesized_at gates the cheap "anything
-- new since?" trigger; produced_json is a map of synthesis-note path to the
-- sha256 of the sources it was built from, so a re-run skips the planner LLM
-- for any topic whose source set is byte-identical (idempotency without a
-- frontmatter round-trip). Machine-owned; additive, no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS shelf_synthesis_state (
  shelf_path TEXT PRIMARY KEY,
  last_synthesized_at TEXT,
  produced_json TEXT NOT NULL DEFAULT '{}'
);

-- Synthesis retrieval usage (the Second Brain WORTH axis, loop Phase B,
-- 2026-06-15). One row per synthesis-note path; hits increments each time the
-- note is retrieved into a turn top-k, last_retrieved_at stamps when. Feeds
-- score_synthesis retrieval_hits so worth stops being neutral, and gives the
-- nightly heal pass a disuse signal. Machine-owned; additive, no SCHEMA_VERSION
-- bump.
CREATE TABLE IF NOT EXISTS synthesis_usage (
  note_path TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT
);

-- Capability-demand ledger (2026-07-14) — one row per tool-surface MISS: a
-- specialist called a tool it lacks the capability for ('forbidden'), a tool
-- that exists nowhere ('unknown_tool'), or asked load_tools for a name outside
-- its catalog ('load_miss'). The tool-capability sibling of knowledge demand;
-- Kate reads the clustered report via read_capability_demand and commissions
-- recurring gaps through file_build_request. Content-free by design (no
-- message text — cordon-safe). Additive table; no SCHEMA_VERSION bump. The
-- indexes reference only columns in THIS create (never the ALTER-added class).
CREATE TABLE IF NOT EXISTS capability_demand (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forbidden','unknown_tool','load_miss')),
  tool_name TEXT NOT NULL,
  missing_capability TEXT,
  surface TEXT
);
CREATE INDEX IF NOT EXISTS idx_capability_demand_ts
  ON capability_demand (ts DESC);
CREATE INDEX IF NOT EXISTS idx_capability_demand_tool
  ON capability_demand (tool_name, ts DESC);

-- LLM role overrides (2026-08-01) - the hot layer over config/llm-roles.yaml,
-- which is readFileSync'd ONCE at router construction and has no watcher. This
-- is what makes "revert the model behind a role" a write instead of a
-- docker compose restart. The YAML stays the base and the git source of truth;
-- an override is an explicitly temporary layer that records what it displaced
-- (prev_json) so lifting it is always possible.
-- At most ONE active row per role (reverted_at IS NULL) - applying a second
-- auto-reverts the first, so this can never become a stack nobody can reason
-- about under pressure.
CREATE TABLE IF NOT EXISTS llm_role_overrides (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  prev_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  reverted_at TEXT,
  reverted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_role_overrides_active
  ON llm_role_overrides (role, reverted_at);

-- Change windows (2026-08-01) - every automated change carries a metric
-- baseline so the next eval run can score it. baseline_json is a
-- task_id -> passed MAP, not a pass rate: the live golden suite runs a standing
-- mix of passing and known-failing tasks (~110/151), so an absolute rate says
-- nothing and a per-task before/after delta says everything.
-- The baseline must be captured at APPLY time or the evidence is gone.
CREATE TABLE IF NOT EXISTS change_windows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  verdict TEXT,
  measured_at TEXT,
  delta_summary TEXT,
  action_taken TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_windows_pending
  ON change_windows (verdict, applied_at);

-- Directed-dispatch journal (2026-08-10) - a directed deliberation (approved
-- proposal fan-out, court conversion, scrum "start developing", owner-directed
-- fire) runs fire-and-forget IN-PROCESS, so an orchestrator restart mid-build
-- killed it silently: the proposal is already terminal (acknowledged) and the
-- trainer FYI says "do NOT re-file", so nothing anywhere re-fired the work
-- (2026-08-10: four approved builds died this way during deploys). Every
-- directed fire journals a row here BEFORE the pass runs; boot reconciliation
-- in server.ts re-fires rows with finished_at IS NULL (attempt-capped).
-- task_json is the full DirectedTask (instruction, tools, max_tokens, think).
-- Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS directed_dispatches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  proposal_id TEXT,
  specialist_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  user_id TEXT,
  task_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  fired_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_directed_dispatches_unfinished
  ON directed_dispatches (finished_at, fired_at);

-- Guard-rejection telemetry (2026-08-11, directed-build postmortem). One
-- counter per (guard, scope): change_pipeline check failures, change-record
-- dedup supersessions, tool-round-ceiling exhaustions, directed duplicate-
-- failure cuts. Incremented fail-open at the guard call sites; read by
-- Mariah's scan_program_health recurrence sweep so a gate that repeatedly
-- blocks approved work becomes a process miss without a human reading
-- audit_log rows. Telemetry only - never decremented; the sweep windows on
-- last_at. Additive table; no SCHEMA_VERSION bump.
CREATE TABLE IF NOT EXISTS guard_counters (
  guard TEXT NOT NULL,
  scope TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  last_detail TEXT,
  PRIMARY KEY (guard, scope)
);
CREATE INDEX IF NOT EXISTS idx_guard_counters_recent
  ON guard_counters (last_at, count);
`;

// ── bun:sqlite bind guard ─────────────────────────────────────────────────
// Two bun:sqlite footguns that fail SILENTLY (better-sqlite3 was permissive;
// bun is not) and have each already cost this repo a debugging session:
//
//  1. Bare-key named bind — `stmt.run({ id: 'x' })` against SQL using `@id`
//     binds NULL with no error (the `NOT NULL constraint failed: audit_log.ts`
//     mystery). Named binds MUST carry their sigil: `{ '@id': 'x' }`.
//  2. Mixed named + positional — `stmt.run({ '@foo': 1 }, ...arr)` does NOT
//     throw; it silently no-ops, affecting zero rows (the supersession UPDATE
//     in proposals.ts that "logged success" but flipped nothing).
//
// The guard wraps every statement's bind methods at the open_db chokepoint so
// both surface as a thrown, actionable error instead of corrupt/no-op writes.
// Cost on the hot path is a single cheap key scan, and ONLY on object binds —
// positional (`?` + spread) and no-arg calls pass through untouched.

/** SQLite's three named-parameter sigils. bun requires the bind-object key to
 *  carry the matching one; a bare key is the footgun. */
const NAMED_PARAM_SIGILS = ['@', '$', ':'] as const;

/** A first bind arg is "named params" only when it's a plain object literal —
 *  NOT an array (positional binds), a TypedArray/Buffer (blob binds), a Date,
 *  or any class instance. Those reach the driver as positional values and must
 *  not be key-scanned. */
function is_named_params(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throw a clear, actionable error for either footgun; no-op otherwise. */
function assert_safe_bind(method: string, args: unknown[]): void {
  const first = args[0];
  if (!is_named_params(first)) return; // positional / no-arg — driver handles it

  if (args.length > 1) {
    throw new Error(
      `bun:sqlite bind error: statement.${method}() received a named-params ` +
        `object AND ${args.length - 1} trailing positional argument(s). bun ` +
        `silently no-ops this (zero rows affected) — pass EITHER one named ` +
        `object OR positional values, never both.`,
    );
  }

  for (const key of Object.keys(first)) {
    if (!NAMED_PARAM_SIGILS.some((s) => key.startsWith(s))) {
      throw new Error(
        `bun:sqlite bind error: statement.${method}() bind key "${key}" is ` +
          `missing its sigil. bun binds bare keys to NULL silently — prefix ` +
          `it to match the SQL placeholder ("@${key}", "$${key}", or ":${key}").`,
      );
    }
  }
}

/** Statement methods that accept bind values. (`raw`/`isFinalized` don't.) */
const GUARDED_STMT_METHODS = ['run', 'get', 'all', 'values', 'iterate'] as const;
const BIND_GUARD_MARK = Symbol('hearth_bind_guarded');

/** Wrap a prepared statement's bind methods in place (idempotent). bun exposes
 *  them as writable own-properties, so we shadow each with a guarded version. */
function guard_statement<S extends object>(stmt: S): S {
  if (!stmt || (stmt as Record<symbol, unknown>)[BIND_GUARD_MARK]) return stmt;
  for (const method of GUARDED_STMT_METHODS) {
    const orig = (stmt as Record<string, unknown>)[method];
    if (typeof orig !== 'function') continue;
    (stmt as Record<string, unknown>)[method] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      assert_safe_bind(method, args);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  Object.defineProperty(stmt, BIND_GUARD_MARK, {
    value: true,
    enumerable: false,
  });
  return stmt;
}

/** Install the bind guard on a Database by wrapping both statement factories
 *  (`prepare` and the cached `query`). Every store opens through open_db, so
 *  this single install covers the whole system — including open_db's own
 *  migration statements, since it runs before them. */
function install_bind_guard(db: Database): void {
  for (const factory of ['prepare', 'query'] as const) {
    const orig = db[factory].bind(db) as (...a: unknown[]) => object;
    (db as unknown as Record<string, unknown>)[factory] = (...args: unknown[]) =>
      guard_statement(orig(...args));
  }
}

// ── Migrations ────────────────────────────────────────────────────────────
// For existing databases predating Prompt 7, ALTER TABLE in additive ways
// only. `IF NOT EXISTS` doesn't exist for ALTER on older SQLite, so the
// helper below swallows duplicate-column errors which are the only failure
// mode we expect here.
//
// RETURNS whether this call actually ADDED the column — i.e. whether this is
// the one boot that migrated the table. A one-time backfill (see the
// `user_id` / `private_to` / `originating_user_id` cordon columns below) MUST
// be gated on that return value, because `open_db` runs on EVERY boot of
// EVERY process (orchestrator + ingestor). An ungated
// `UPDATE ... SET c = COALESCE(c, <owner>) WHERE c IS NULL` does not just
// backfill the pre-migration rows it was written for — it re-fires forever,
// overwriting every NULL a later row legitimately means. NULL is load-bearing
// in the cordon columns: it means "owner-global / not cordoned to one user",
// which `ProposalsStore.create` writes deliberately
// (src/core/proposals.ts — SYSTEM_PROPOSAL_KINDS and every background scan)
// and which `rollup_eligible` (src/core/proposal_court.ts) requires. Boot-only
// bugs of this shape are invisible to `bun run smoke:boot-check`, which opens
// `:memory:` — a fresh DB has no pre-existing rows, so the stray UPDATE is
// always a no-op there. See docs/archive/ for the 2026-07-18 queue-drain fix.
function add_column_if_missing(
  db: Database,
  table: string,
  column: string,
  type_sql: string,
): boolean {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type_sql}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column name')) {
      throw err;
    }
    return false;
  }
}

export function open_db(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Install the silent-footgun guard first so even the migration statements
  // below (and every store opening through here) are protected.
  install_bind_guard(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // SQLite WAL allows many readers but only one writer at a time. When
  // two writers race (ingestor projecting notes while runtime logs an
  // audit row), the loser sees SQLITE_BUSY and throws immediately —
  // crashing the turn mid-flight. busy_timeout makes the writer wait
  // up to N ms for the lock instead, eliminating the race in practice
  // (typical write is <1ms; 5s is generous). Set on every open_db so
  // orchestrator, ingestor, and scheduler all back off cooperatively.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);

  // Prompt 7 additive migrations for pre-7 databases.
  add_column_if_missing(db, 'conversations', 'user_id', 'TEXT');
  add_column_if_missing(db, 'conversations', 'active_surface', 'TEXT');
  add_column_if_missing(db, 'conversations', 'ts_last_telegram_message', 'TEXT');
  add_column_if_missing(db, 'conversations', 'ts_last_web_message', 'TEXT');
  add_column_if_missing(db, 'conversations', 'ts_last_voice_message', 'TEXT');
  add_column_if_missing(db, 'messages', 'surface', 'TEXT');

  // 2026-07-24 — the People-graph BOND: an enrolled face identity points at
  // the person's dossier (`people` row) it belongs to, so visual learnings
  // (appearance observations, the widen-only prior) bind deterministically
  // instead of by display-name matching. NULL = not yet bonded (the T3
  // profile writer self-heals it on the next successful name resolve). No
  // index — the roster is tens of rows, and a CREATE INDEX on an ALTER-only
  // column is the boot-only crash class.
  add_column_if_missing(db, 'enrolled_persons', 'person_ref', 'TEXT');

  // 2026-06-10 — Live Ride Companion: per-session cue mute, flipped by
  // POST /api/workout/cues/mute and checked by the live-throttle
  // subscriber before any coaching push. Additive; NULL reads as
  // unmuted; no index (point lookups by session_id PK).
  add_column_if_missing(db, 'workout_sessions', 'cues_muted', 'INTEGER');
  // 2026-06-12 — device autopause state, warmed per heartbeat; the live
  // pane + throttle read it (NULL = not paused / pre-autopause client).
  add_column_if_missing(db, 'workout_sessions', 'paused', 'INTEGER');
  // 2026-06-12 — route learning: the fingerprint group this session's
  // GPS track matched (see workout_routes). NULL = no route uploaded.
  add_column_if_missing(db, 'workout_sessions', 'route_group_id', 'TEXT');

  // 2026-06-11 — Ride Log (Live Ride Companion Phase 2.5). All additive,
  // no indexes on the new columns (see backend-boot-only-errors gotcha:
  // a SCHEMA_SQL index on a migration-added column crashes existing DBs).
  //   elevation_gain_m — cumulative barometric gain; rolling on active
  //     rows (warmed each heartbeat), final total once completed.
  //   avg_power_w      — Watch-estimated cycling power average, end
  //     packet only. Re-scoped IN by Jasper 2026-06-11 for naming/recap
  //     evidence (was deliberately out per astrid-cycling-metrics-scope).
  //   route_notes_json — JSON string[] of on-device-derived route
  //     descriptors (road/place NAMES only — coordinates never leave
  //     the phone, per design §10).
  //   ride_name        — Astrid's grounded ~10-15 word sentence name,
  //     written async after session end (ride_name.ts). NULL until
  //     named; fallback name on LLM failure.
  //   end_weather_json — weather snapshot at session end (temp/condition/
  //     wind), captured for the name and kept for the detail surfaces.
  add_column_if_missing(db, 'workout_sessions', 'elevation_gain_m', 'REAL');
  add_column_if_missing(db, 'workout_sessions', 'avg_power_w', 'REAL');
  add_column_if_missing(db, 'workout_sessions', 'route_notes_json', 'TEXT');
  add_column_if_missing(db, 'workout_sessions', 'ride_name', 'TEXT');
  add_column_if_missing(db, 'workout_sessions', 'end_weather_json', 'TEXT');

  // 2026-06-05 — scrum_epics gains source_key so the NEXT.md → board importer
  // is re-runnable (upsert on 'next:<id>' instead of duplicating). Index above
  // is created idempotently in SCHEMA_SQL.
  add_column_if_missing(db, 'scrum_epics', 'source_key', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scrum_epics_source ON scrum_epics(source_key)`);

  // 2026-06-07 — soft-archive: an epic can be removed from the board (junk /
  // obsolete / wrong) without a destructive delete. Additive, backfills 0 for
  // existing rows; filtered out of every board read by default. No index — the
  // board is tens of rows, and a CREATE INDEX on an ALTER-only column is the
  // boot-only crash class.
  add_column_if_missing(db, 'scrum_epics', 'archived', 'INTEGER NOT NULL DEFAULT 0');

  // Prompt 7.5 — Person spatial fields.
  add_column_if_missing(db, 'people', 'address', 'TEXT');
  add_column_if_missing(db, 'people', 'lat', 'REAL');
  add_column_if_missing(db, 'people', 'lon', 'REAL');

  // 2026-06-28 — health-incident ALERT hysteresis. observations counts
  // consecutive down-scans; alerted_at stamps the one escalation. The scan
  // waits until observations crosses the confirmation threshold before paging
  // the owner, so a self-healing blip (firecrawl recovering within the hour)
  // never alerts. Additive, backfills existing open rows (1 / NULL); no index
  // (boot-only CREATE-INDEX-on-ALTER crash class).
  add_column_if_missing(db, 'health_incidents', 'observations', 'INTEGER NOT NULL DEFAULT 1');
  add_column_if_missing(db, 'health_incidents', 'alerted_at', 'TEXT');

  // 2026-06-20 — Trust Ladder (RPG XP). category_signatures gains xp + level.
  // Additive, backfills 0; no index (boot-only CREATE-INDEX-on-ALTER crash
  // class). The XP gate only engages when HEARTH_TRUST_XP is on.
  add_column_if_missing(db, 'category_signatures', 'xp', 'REAL NOT NULL DEFAULT 0');
  add_column_if_missing(db, 'category_signatures', 'level', 'INTEGER NOT NULL DEFAULT 0');
  // Phase 2b — audit_log gains user_id so an admin can answer
  // "what did Sam look at?" with a single SQL query. Backfills
  // NULL on existing rows; new writes populate it.
  add_column_if_missing(db, 'audit_log', 'user_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id)`);
  // Provable cordon Phase 1a — subject_user_id: the user whose data a row
  // TARGETS (vs user_id = who triggered it). Set on cross-user actions like
  // owner-oversight; powers the member-facing "who reached my data" log.
  add_column_if_missing(db, 'audit_log', 'subject_user_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_user_id)`);
  // Provable cordon Phase 1b — tamper-evident hash-chain (audit_chain.ts).
  // prev_hash/row_hash link each row to the previous chained one; an edit /
  // delete / reorder breaks the chain. Backfilled NULL (unchained) on
  // existing rows; new writes populate via log_action. No index — the
  // verifier walks by rowid, and a CREATE INDEX on an ALTER-only column is
  // the boot-only crash class.
  add_column_if_missing(db, 'audit_log', 'prev_hash', 'TEXT');
  add_column_if_missing(db, 'audit_log', 'row_hash', 'TEXT');

  // 2026-05-26 — proposals gain human-readable title/summary,
  // computed at create time from (kind, payload), plus a
  // supersession discriminator (dedup_key + superseded_by /
  // superseded_at) so a newer proposal targeting the same subject
  // (e.g. a refined persona-tuning for Maggie) marks the older one
  // superseded instead of leaving both rows in the user's queue.
  // See `src/core/proposal_render.ts` for the kind-aware compute.
  add_column_if_missing(db, 'proposals', 'title', 'TEXT');
  add_column_if_missing(db, 'proposals', 'summary', 'TEXT');
  add_column_if_missing(db, 'proposals', 'dedup_key', 'TEXT');
  add_column_if_missing(db, 'proposals', 'superseded_by', 'TEXT');
  add_column_if_missing(db, 'proposals', 'superseded_at', 'TEXT');
  // 2026-05-26 — dynamic proposal actions. Each row carries the
  // tappable action set computed at create time
  // (compute_proposal_actions in src/core/proposal_render.ts). Legacy
  // rows leave actions_json NULL; the read layer falls back to the
  // default Approve/Deny set. `action_taken` records which action_id
  // the user picked when deciding — useful both for audit and for
  // dashboards ("how often does Jasper pick 'edit time' on
  // calendar_event proposals?").
  add_column_if_missing(db, 'proposals', 'actions_json', 'TEXT');
  add_column_if_missing(db, 'proposals', 'action_taken', 'TEXT');
  // 2026-07-04 — Proposal Court split memory (owner-queue triage gate): a
  // case the bench SPLIT on is the owner's now; the stamp excludes it from
  // future dockets so the court can't re-litigate + re-digest the same case
  // daily (three ids split on both 07-03 and 07-04 pre-fix). Additive; NULL =
  // never split. No index — docket reads are bounded scans (and a SCHEMA_SQL
  // index on an ALTER-only column is the boot-only crash class).
  add_column_if_missing(db, 'proposals', 'court_split_at', 'TEXT');
  // 2026-08-02 — Court PARK, generalizing the split stamp above. A split was
  // only ONE of the two ways the bench hands a case to the owner; the other —
  // `owner_class`, the permanent send_/spend_/step-up floor — stamped nothing
  // and so was re-seated at every convening, forever. Measured that date: 12
  // of the 28 pending proposals were >29 days old, and three ids drew an
  // owner_class/skipped verdict three times in a single day. One concept, one
  // column: NULL = the bench may still seat it. Backfilled from court_split_at
  // so already-split rows stay parked across the deploy. Additive, no index —
  // docket reads are bounded scans (and a SCHEMA_SQL index on an ALTER-only
  // column is the boot-only crash class).
  add_column_if_missing(db, 'proposals', 'court_parked_at', 'TEXT');
  add_column_if_missing(db, 'proposals', 'court_parked_reason', 'TEXT');
  db.run(
    `UPDATE proposals SET court_parked_at = court_split_at, court_parked_reason = 'split'
      WHERE court_parked_at IS NULL AND court_split_at IS NOT NULL`,
  );
  // 2026-08-02 — how many times the bench has RE-heard a parked split. A split
  // park is a cooldown, not a grave (see `rehear_split`), and this bounds the
  // retry so a case the bench can never agree on lapses instead of cycling.
  // DEFAULT 0 so no backfill UPDATE is needed — an unconditional
  // `UPDATE ... WHERE col IS NULL` after an ALTER re-fires on every boot of
  // both the orchestrator AND the ingestor (see the boot-only-errors class).
  add_column_if_missing(db, 'proposals', 'court_rehear_count', 'INTEGER NOT NULL DEFAULT 0');
  // 2026-07-05 — Precedent memory (Kate self-direction C3): the decided
  // history's nearest cases, stamped at create() as EVIDENCE for the
  // court/owner surfaces ({ matched_at, matches: [...] }). Additive; NULL =
  // filed dark / no matches. No index — read by id only.
  add_column_if_missing(db, 'proposals', 'precedent_json', 'TEXT');
  // Index on (dedup_key, status) so the lookup at create time is
  // O(1) — without this the supersession check would scan the
  // whole proposals table on every new proposal.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_proposals_dedup_open
     ON proposals (dedup_key, status)
     WHERE dedup_key IS NOT NULL`,
  );
  // Index has to be created AFTER the column migration so pre-7 DBs
  // don't error on "no such column: user_id" at first boot.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conv_user_specialist
     ON conversations(user_id, specialist_id, ts_last_message_at)`,
  );

  // 2026-05-27 — briefs grow `user_id` so Kate's deliberation can
  // produce one brief per household member instead of a single
  // owner-only brief. Backfill existing rows to the legacy owner
  // (or `jasper` if no env override) so the column can stay queryable
  // without nulling out the historical record. New inserts MUST
  // provide user_id; the BriefsStore.insert signature enforces it.
  // Routes filter by caller user_id (briefs.ts no longer gates by
  // tier === 'owner') so household users see their own brief.
  if (add_column_if_missing(db, 'briefs', 'user_id', 'TEXT')) {
    db.exec(
      `UPDATE briefs SET user_id = COALESCE(user_id, '${
        process.env.HEARTH_OWNER_USER_ID ?? 'jasper'
      }') WHERE user_id IS NULL`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_briefs_user_kind_ts
     ON briefs(user_id, kind, ts_generated DESC)`,
  );

  // 2026-06-04 — per-user data cordon (Phase 2b finish).
  // clippings.private_to mirrors the wrapper note's `private_to`
  // frontmatter so the unified search can filter vault hits with a JOIN
  // instead of re-reading each note. The ingestor backfills it on the
  // next projection pass; scripts/backfill-private-to.ts stamps legacy
  // wrapper notes. Legacy rows stay NULL (broad-visibility) until then.
  add_column_if_missing(db, 'clippings', 'private_to', 'TEXT');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_clippings_private_to ON clippings(private_to)`,
  );
  // library_files.private_to scopes the /files manager + library search.
  // NULL = shelf-wide reference material (curate_for_specialist auto-
  // ingests); a direct user upload stamps the uploader's id (personal).
  // Existing rows predate the cordon and were the owner's curation —
  // backfill them to the owner so the file manager doesn't leak them to
  // household/friend users (each starts with their own uploads).
  if (add_column_if_missing(db, 'library_files', 'private_to', 'TEXT')) {
    db.exec(
      `UPDATE library_files SET private_to = COALESCE(private_to, '${
        process.env.HEARTH_OWNER_USER_ID ?? 'jasper'
      }') WHERE private_to IS NULL`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_library_private_to ON library_files(private_to)`,
  );
  // proposals.user_id — the per-user cordon split. For NEW proposals:
  // NULL = system / self-improvement (recommendation, binding_proposal,
  // persona_tuning, trusted_source_addition) — owner-global, surfaces to
  // the owner regardless of which user's session triggered it; a
  // user-action proposal (draft_message, action_proposal, calendar_event,
  // book_candidate) carries the originating user's id so it cordons to
  // them. EXISTING rows backfill to the owner (not NULL): they predate the
  // cordon and were all the owner's era, so scoping them to the owner
  // keeps the owner's queue intact while preventing a historical action
  // proposal from surfacing in a household member's queue (which a NULL
  // backfill — read as owner-global — would do).
  //
  // The backfill is GATED on the column actually being added (2026-07-18).
  // Ungated, it re-ran on every orchestrator + ingestor boot and clobbered
  // the NULL that `create` writes for every owner-global card — which is
  // precisely what `rollup_eligible` (src/core/proposal_court.ts) keys on.
  // Net effect: the Court's theme-rollup rung could only ever see cards
  // filed since the last restart, and `proposal_court_rollup` had fired
  // ZERO times in 49 convenings / 947 verdicts while 41 rollup-shaped cards
  // sat pending in the owner's queue.
  if (add_column_if_missing(db, 'proposals', 'user_id', 'TEXT')) {
    db.exec(
      `UPDATE proposals SET user_id = COALESCE(user_id, '${
        process.env.HEARTH_OWNER_USER_ID ?? 'jasper'
      }') WHERE user_id IS NULL`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_proposals_user_id ON proposals(user_id, status)`,
  );
  // 2026-06-05 — inbox-flag / interrupt cordon. originating_user_id =
  // the user whose session/capture produced the flag, or NULL =
  // household/system-shared. Kate's per-user brief (and any specialist's
  // chat-turn inbox floor) reads `(originating_user_id IS NULL OR =
  // <viewer>)` so a household member's personal flag can't surface in the
  // owner's brief — the last passive cross-user seam. Existing rows
  // predate the cordon and were the owner's era → backfill to owner (most
  // are already actioned and never re-surface anyway).
  const _inboxes_migrated = add_column_if_missing(
    db, 'specialist_inboxes', 'originating_user_id', 'TEXT',
  );
  const _interrupts_migrated = add_column_if_missing(
    db, 'interrupts', 'originating_user_id', 'TEXT',
  );
  const _owner_uid = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
  if (_inboxes_migrated) {
    db.exec(
      `UPDATE specialist_inboxes SET originating_user_id = COALESCE(originating_user_id, '${_owner_uid}') WHERE originating_user_id IS NULL`,
    );
  }
  if (_interrupts_migrated) {
    db.exec(
      `UPDATE interrupts SET originating_user_id = COALESCE(originating_user_id, '${_owner_uid}') WHERE originating_user_id IS NULL`,
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sinbox_to_user ON specialist_inboxes(to_specialist_id, actioned_at, originating_user_id)`,
  );

  // 2026-05-31 — workout_sessions gains rolling LIVE columns so an
  // active session survives an orchestrator restart. Pre-fix the only
  // live state lived in the in-memory WorkoutSessionTracker; on restart
  // the Activity pane fell to a "Live readings unavailable" stub even
  // though the row still says status='active'. The route now warms these
  // columns on every heartbeat (last-known rolling values), and
  // MemoryClient.query_active_workout reads them so the pane + Astrid's
  // get_workout_state rehydrate from the DB without the tracker. These
  // are the CURRENT (in-flight) values, distinct from the total_*
  // rollups written once at session end. Rolling HR-zone minutes reuse
  // the existing hr_zone_minutes_json column (NULL on the start packet,
  // overwritten with the final rollup on end — the standby aggregate
  // only reads it for status='completed' rows, so no collision).
  add_column_if_missing(db, 'workout_sessions', 'current_hr', 'REAL');
  add_column_if_missing(db, 'workout_sessions', 'current_hr_zone', 'INTEGER');
  add_column_if_missing(db, 'workout_sessions', 'elapsed_s', 'INTEGER');
  add_column_if_missing(db, 'workout_sessions', 'active_kcal', 'REAL');
  add_column_if_missing(db, 'workout_sessions', 'distance_m', 'REAL');
  add_column_if_missing(db, 'workout_sessions', 'last_packet_at', 'TEXT');

  // 2026-05-31 — upcoming_shows gains `going_marked_at`: an ISO timestamp
  // set when Jasper tells Maggie in chat he already has tickets (the
  // mark_show_going tool). Non-null = he's going; the Listening pane's
  // Coming-to-town section filters these out so it stops re-surfacing a
  // show he's already committed to, and the mark is the trigger for
  // Maggie's openers/adjacent-scene research pivot. Distinct from
  // ticket_status (availability) — a show can be 'available' AND
  // going_marked_at IS NOT NULL (he bought, others still can).
  add_column_if_missing(db, 'upcoming_shows', 'going_marked_at', 'TEXT');

  // 2026-06-06 — beatrice_changes gains the deterministic-gate verdict
  // (tsc --noEmit + guard) recorded at PR-open time. Additive nullable columns;
  // NO index on them (a CREATE INDEX on an ALTER-only column before the ALTER is
  // the boot-only crash class). Existing rows backfill NULL = "not recorded".
  add_column_if_missing(db, 'beatrice_changes', 'checks_passed', 'INTEGER');
  add_column_if_missing(db, 'beatrice_changes', 'checks_summary', 'TEXT');

  // 2026-06-11 — beatrice_changes gains the original change INPUTS (the
  // files/edits handed to open_change_pr), so merge recovery can re-land an
  // owner-approved change whose PR went stale against a moved main. Additive
  // nullable column, NO index; legacy rows backfill NULL = "inputs not
  // recorded" and recovery degrades to update-branch-or-park for them.
  add_column_if_missing(db, 'beatrice_changes', 'change_inputs_json', 'TEXT');

  // 2026-07-21 — swarm_reviews gains the higher-court appeal. The table shipped
  // earlier the same day, so existing DBs already have it WITHOUT these columns:
  // the SCHEMA_SQL CREATE TABLE only covers fresh DBs, so they must be ALTERed
  // in here too. Additive + nullable/defaulted, NO index on them (a CREATE INDEX
  // on an ALTER-only column before the ALTER is the boot-only crash class).
  // Legacy rows backfill tier='bench', escalated_from NULL = "never appealed".
  add_column_if_missing(db, 'swarm_reviews', 'tier', "TEXT NOT NULL DEFAULT 'bench'");
  add_column_if_missing(db, 'swarm_reviews', 'escalated_from', 'TEXT');

  // 2026-07-28 — Ruby's beat became self-managing: a watch topic now states
  // WHY it cleared the bar for tracking, so the board is auditable and a
  // story whose reason no longer holds is visibly closeable. Additive
  // nullable column, NO index (the board rolls up the existing topic index);
  // NULL = a development recorded before the field existed, or one appended
  // to a story that already stated its reason.
  add_column_if_missing(db, 'civic_watch_events', 'why_tracked', 'TEXT');

  // 2026-07-29 — a deep-research dossier used to shelve to Kate's library
  // unconditionally, so Ruby's first investigation landed outside her own
  // knowledge_scope and she could never read it back. Record the filing
  // specialist so the writeback follows it. Additive nullable, NO index.
  add_column_if_missing(db, 'research_investigations', 'agent_id', 'TEXT');

  // 2026-07-29 (Deep Research v2 phase 2) — the coverage ledger. A six-facet
  // brief used to lose most of its facets silently: nothing tracked whether a
  // sub-question was ANSWERED, so an unattempted one vanished without a trace
  // and the dossier read as complete. This column holds the per-facet
  // checklist (answered / partial / unanswerable(reason) / not_attempted) the
  // dossier now OPENS with. Additive nullable column, NO index — the ledger is
  // only ever read alongside its own row (a CREATE INDEX on an ALTER-only
  // column inside SCHEMA_SQL is the documented boot-only crash class).
  // NULL = a row from before the ledger existed; the runner recomputes it from
  // findings on the next slice, so nothing needs backfilling.
  add_column_if_missing(db, 'research_investigations', 'coverage_json', 'TEXT');

  // 2026-07-30 — disambiguating facts the OWNER supplied about the subject
  // ("she works at BrightCase", "she lives in Milton", a profile URL). The
  // "Josie Kim Reyes" investigation found only strangers because a private
  // person's name alone is not a searchable identity; the fix is to let the
  // owner hand over an anchor and re-run. These ride into query planning and
  // into the extractor's prompt. Additive nullable column, NO index.
  add_column_if_missing(db, 'research_investigations', 'anchor_facts_json', 'TEXT');

  // 2026-07-30 — how many times this investigation's dossier has been REVISED.
  // A dossier that gets rebuilt from scratch on every refinement can never get
  // deep (the lesson people_synthesis learned on 2026-07-26); revisions are how
  // a subject's file accumulates instead of resetting. Additive, NO index.
  add_column_if_missing(db, 'research_investigations', 'revision', 'INTEGER NOT NULL DEFAULT 0');

  // ── 2026-08-04 — drop the camera/vision layer's tables ────────────────────
  // Frigate and everything that consumed it were removed on 2026-08-04. These
  // ten tables were verified dead before this drop was written, on the LIVE
  // database and against a full-repo reference scan:
  //   * nothing CREATEs them (the stores that did are deleted),
  //   * nothing reads or writes them — the only two grep hits left were prose
  //     inside comments (`crop_quality.ts`, `wifi_presence.ts`),
  //   * no foreign key points at them, and they hold none outbound.
  // Row counts at drop time, for the record: person_sightings 39,303;
  // person_tracks 7,222; appearance_gallery 1,251; face_vectors 180;
  // face_assign_journal 73; face_sighting_presence 34; camera_cosine_stats 24;
  // face_ref_exemplars 7; known_face_vectors 4; visitor_askbacks 1.
  // A pre-drop backup lives at /data/db/backups/hearth-pre-face-table-drop-20260804.db.
  // DROP TABLE also drops the table's indexes, so there is nothing else to clean.
  // Idempotent (IF EXISTS) because open_db runs on every boot of every process.
  for (const dead_table of [
    'person_sightings',
    'person_tracks',
    'appearance_gallery',
    'face_vectors',
    'face_assign_journal',
    'face_sighting_presence',
    'camera_cosine_stats',
    'face_ref_exemplars',
    'known_face_vectors',
    'visitor_askbacks',
    // Second wave (owner-decided, same day): these three DID have live
    // readers, which were removed with them — get_household_occupancy's
    // camera half fed Luna's Home-office room map, and grounding_packs read
    // the security ledger into Kate's pack. Both are gone now.
    // face_clusters 156 rows, face_sightings 321, security_events 4,419.
    'face_clusters',
    'face_sightings',
    'security_events',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${dead_table}`);
  }

  // Record schema version
  const current = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  if (!current) {
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('version', ?)`,
    ).run(String(SCHEMA_VERSION));
  }

  return db;
}
