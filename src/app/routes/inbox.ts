/**
 * Inbox HTTP routes (Prompt 6c).
 *
 *   GET  /api/inbox                    list/filter (from, to, unread_only, limit)
 *   GET  /api/inbox/:id                one message
 *   POST /api/inbox/:id/mark_read
 *   POST /api/inbox/:id/mark_actioned
 */

import { Hono } from 'hono';
import type { SpecialistInbox } from '@memory/stores/conversations';

export interface InboxRouterDeps {
  inbox: SpecialistInbox;
}

export function create_inbox_router_api(deps: InboxRouterDeps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const to = c.req.query('to') ?? undefined;
    const from = c.req.query('from') ?? undefined;
    const unread_only = c.req.query('unread_only') === '1' || c.req.query('unread_only') === 'true';
    const limit_raw = c.req.query('limit');
    const limit = limit_raw ? Math.max(1, Math.min(200, parseInt(limit_raw, 10) || 50)) : 50;
    const rows = deps.inbox.list_all({ to, from, unread_only, limit });
    return c.json({ messages: rows });
  });

  r.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = deps.inbox.get(id);
    if (!row) return c.json({ error: 'inbox message not found' }, 404);
    return c.json({ message: row });
  });

  r.post('/:id/mark_read', (c) => {
    const id = c.req.param('id');
    deps.inbox.mark_read([id]);
    return c.json({ id, marked_read: true });
  });

  r.post('/:id/mark_actioned', (c) => {
    const id = c.req.param('id');
    deps.inbox.mark_actioned(id);
    return c.json({ id, marked_actioned: true });
  });

  return r;
}
