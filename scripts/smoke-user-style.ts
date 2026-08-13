/**
 * smoke:user-style — the per-user register learning loop (src/core/user_style.ts).
 *
 * Self-contained: temp db, mock LLM + mock message source, no network. Exercises:
 *   - gate dark by default (HEARTH_USER_STYLE_LEARN).
 *   - learn_user_style happy path: messages -> distill -> persisted to the DB
 *     profile row + a cordoned users/<id>/style_profile.md note (private_to user).
 *   - the house-voice block reads the distilled profile with the RE-TUNED wording
 *     (register-only, "not a list of facts to recite back", no interests line).
 *   - prior profile threaded into the distill payload.
 *   - sanitize: fenced output + "Here is..." preamble stripped.
 *   - FAIL-OPEN: no messages / too-short / LLM throw (prior preserved) / empty distill.
 *   - run_user_style_sweep: no-op when disabled, dedup + drop-empty, failure isolation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { UserProfileStore } from '../src/memory/stores/user_profile';
import {
  learn_user_style,
  run_user_style_sweep,
  user_style_learning_enabled,
  type StyleMemory,
  type StyleLLM,
  type StyleMessage,
  type UserStyleDeps,
} from '../src/core/user_style';
import { render_house_voice_section } from '../src/core/house_voice';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-us-'));
const prev = process.env.HEARTH_USER_STYLE_LEARN;
const NOW = new Date('2026-06-19T12:00:00Z');

let llm_mode: 'ok' | 'empty' | 'throw' | 'fenced' = 'ok';
let last_payload = '';
const llm: StyleLLM = {
  for_role() {
    return {
      defaults: { temperature: 0.4 },
      provider: {
        async complete(req: { messages: Array<{ role: string; content: string }>; temperature?: number }) {
          last_payload = req.messages[1]?.content ?? '';
          if (llm_mode === 'throw') throw new Error('boom');
          if (llm_mode === 'empty') return { content: '   ', cost: { model: 'mock' } };
          if (llm_mode === 'fenced')
            return { content: 'Here is the profile:\n```\nWants it blunt and brief; dry humor lands.\n```', cost: { model: 'mock' } };
          return { content: 'Wants the bottom line first, allergic to filler, dry humor lands, fine with profanity.', cost: { model: 'mock' } };
        },
      },
    };
  },
};

try {
  const db = open_db(join(dir, 'hearth.db'));
  const store = new UserProfileStore(db);
  const notes: Record<string, { fm: Record<string, unknown>; body: string }> = {};
  const memory: StyleMemory = {
    get_user_profile: (uid) => store.get(uid),
    set_user_style_profile: (uid, p) => store.set_style_profile(uid, p),
    upsert_note: (path, fm, body) => {
      notes[path] = { fm, body };
    },
  };
  let msgs: StyleMessage[] = [];
  const deps: UserStyleDeps = { recent_user_messages: () => msgs, memory, llm };

  // 1. gate dark by default
  delete process.env.HEARTH_USER_STYLE_LEARN;
  assert(user_style_learning_enabled() === false, 'gate: dark by default');
  process.env.HEARTH_USER_STYLE_LEARN = '1';
  assert(user_style_learning_enabled() === true, 'gate: =1 enables');

  // 2. happy path -> persisted to DB + cordoned note
  msgs = [
    { ts: '2026-06-18T10:00:00Z', content_md: 'just give me the bottom line, skip the fluff please' },
    { ts: '2026-06-18T11:00:00Z', content_md: 'lol that is brutal, I love it. keep it short though' },
  ];
  llm_mode = 'ok';
  const r1 = await learn_user_style('sam', deps, { now: NOW });
  assert(r1.updated === true, 'learn: updated');
  assert(r1.messages_scanned === 2, 'learn: scanned 2');
  const sp = store.get('sam')?.detail['style_profile'];
  assert(typeof sp === 'string' && (sp as string).includes('bottom line first'), 'learn: profile persisted to DB');
  assert(notes['users/sam/style_profile.md']?.fm['private_to'] === 'sam', 'learn: cordoned note private_to user');

  // 3. house-voice block reads it — re-tuned register-only wording
  {
    const block = render_house_voice_section({ display_name: 'Sam', style_profile: sp as string });
    assert(block.includes('How **Sam** likes to be talked to'), 'house: per-user header');
    assert(block.includes('NOT a') && block.includes('recite back'), 'house: register-only guardrail wording');
    assert(!block.includes('cares about'), 'house: interests line GONE');
  }

  // 4. prior profile threaded into the next distill payload
  {
    llm_mode = 'ok';
    await learn_user_style('sam', deps, { now: NOW });
    assert(last_payload.includes('bottom line first'), 'prior: prior profile included in payload');
    assert(last_payload.includes('prior_profile'), 'prior: payload has prior_profile section');
  }

  // 5. sanitize — fenced + "Here is" preamble stripped
  {
    llm_mode = 'fenced';
    msgs = [{ ts: '2026-06-18T10:00:00Z', content_md: 'a real message that passes the min_chars threshold easily' }];
    await learn_user_style('kim', deps, { now: NOW });
    const lp = store.get('kim')?.detail['style_profile'] as string;
    assert(!lp.includes('```') && !/^here/i.test(lp), 'sanitize: fences + preamble stripped');
    assert(lp.includes('blunt and brief'), 'sanitize: kept the profile body');
  }

  // 6. fail-open: no messages
  {
    msgs = [];
    const r = await learn_user_style('ghost', deps, { now: NOW });
    assert(r.updated === false && r.reason === 'no_messages', 'fail-open: no messages');
    assert(store.get('ghost') === null, 'fail-open: nothing written');
  }
  // 7. fail-open: too-short messages filtered to none
  {
    msgs = [{ ts: '2026-06-18T10:00:00Z', content_md: 'hi' }];
    const r = await learn_user_style('ghost', deps, { now: NOW });
    assert(r.reason === 'no_messages', 'fail-open: min_chars filters to none');
  }
  // 8. fail-open: LLM throw -> prior preserved
  {
    store.set_style_profile('keep', 'PRIOR STYLE KEPT');
    msgs = [{ ts: '2026-06-18T10:00:00Z', content_md: 'a sufficiently long real message here for the threshold' }];
    llm_mode = 'throw';
    const r = await learn_user_style('keep', deps, { now: NOW });
    assert(r.updated === false && r.reason === 'llm_error', 'fail-open: llm error reason');
    assert(store.get('keep')?.detail['style_profile'] === 'PRIOR STYLE KEPT', 'fail-open: prior preserved on llm error');
  }
  // 9. fail-open: empty distill
  {
    msgs = [{ ts: '2026-06-18T10:00:00Z', content_md: 'a sufficiently long real message here for the threshold' }];
    llm_mode = 'empty';
    const r = await learn_user_style('emptyu', deps, { now: NOW });
    assert(r.updated === false && r.reason === 'empty_profile', 'fail-open: empty distill');
    assert(store.get('emptyu') === null, 'fail-open: nothing written on empty');
  }

  // 10. sweep — off = no-op
  {
    process.env.HEARTH_USER_STYLE_LEARN = '0';
    const res = await run_user_style_sweep(['sam', 'kim'], deps, { now: NOW });
    assert(res.length === 0, 'sweep: no-op when disabled');
    process.env.HEARTH_USER_STYLE_LEARN = '1';
  }
  // 11. sweep — iterates + dedups + drops empty ids
  {
    llm_mode = 'ok';
    msgs = [{ ts: '2026-06-18T10:00:00Z', content_md: 'a sufficiently long real message here for the threshold' }];
    const res = await run_user_style_sweep(['a', 'a', 'b', ''], deps, { now: NOW });
    assert(res.length === 2, 'sweep: dedup + drop empty -> 2 users');
    assert(res.every((r) => r.updated), 'sweep: both updated');
  }

  db.close();
  console.log(`\n✅ smoke:user-style — ${pass} checks passed`);
} catch (e) {
  console.error(`\n❌ smoke:user-style FAILED after ${pass} checks`);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (prev === undefined) delete process.env.HEARTH_USER_STYLE_LEARN;
  else process.env.HEARTH_USER_STYLE_LEARN = prev;
  rmSync(dir, { recursive: true, force: true });
}
