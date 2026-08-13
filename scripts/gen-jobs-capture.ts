/**
 * gen-jobs-capture — dump the EXACT wire payloads `GET /api/jobs` and the
 * `job_progress` SSE event produce, from the real mapper against a `:memory:` DB
 * with real store writes.
 *
 * This exists so the iOS `JobDTOTests` fixture is GENERATED, not hand-authored.
 * `MediaChapter.start_s` and the Security Room `keyNotFound("id")` were both
 * client-invented contracts that passed a hand-written fixture and then failed
 * on the wire; a fixture nobody typed cannot drift from the mapper.
 *
 *   bun run scripts/gen-jobs-capture.ts > /tmp/jobs-capture.json
 *
 * Still not a substitute for curling the DEPLOYED endpoint with the owner token —
 * this proves the client agrees with the mapper, not that the LLM host runs it.
 */
import { open_db } from '../src/memory/stores/structured';
import { MediaArchiveJobStore } from '../src/memory/stores/media_jobs';
import { ResearchInvestigationStore } from '../src/memory/stores/research_investigations';
import { list_jobs, emit_job_progress } from '../src/core/jobs';
import { progress_of } from '../src/app/routes/research';

const db = open_db(':memory:');
const deps = { db, progress_of };
const media = new MediaArchiveJobStore(db);
const research = new ResearchInvestigationStore(db);

const j = media.create({ url: 'https://www.youtube.com/watch?v=OSayp2tArqA', requested_by: 'jasper', conversation_id: '01KYR0THX1Q59W4NA449V1PJG4' });
media.update(j.id, { status: 'downloading', probe: { title: 'JO PARIS 2024 - Le magnifique "Nightcall" par KAVINSKY, ANGÈLE et PHOENIX au Stade de France', source: 'yt-dlp', extractor: 'youtube' }, category: { media_kind: 'clip', folder_segments: ['Video','YouTube','Eurosport','Olympics 2024','Opening Ceremony'] }, state: { log: ['probed youtube: JO PARIS 2024 - Le magnifique "Nightcall"', 'categorized clip (Video/YouTube/Eurosport/Olympics 2024/Opening Ceremony) · nsfw_pre=sfw'] } });
const done = media.create({ url: 'https://example.com/d', requested_by: 'jasper', conversation_id: 'c2' });
media.update(done.id, { status: 'done', media_item_id: 'mi_n4pv1cxx', probe: { title: 'Lower back pain mobility routine' }, category: { media_kind: 'tutorial', folder_segments: ['Video','YouTube','Xtine Cardenas'] }, state: { log: ['downloaded Video/YouTube/Xtine Cardenas/mi_n4pv1cxx.mp4 (mp4) · nsfw_final=sfw'] } });
const ri = research.create({ subject: 'Chris Barrett', subject_kind: 'person', brief: 'Pleasantville councilmember', requested_by: 'jasper', conversation_id: 'c3', agent_id: 'kate' });
research.update(ri.id, { status: 'verifying' });

const feed = list_jobs(deps, { user_id: 'jasper', tier: 'owner' });
const events: unknown[] = [];
emit_job_progress({ emit: (e: unknown) => events.push(e) } as never, feed.active[0]!);
console.log(JSON.stringify({ feed, event: events[0] }, null, 2));
