/**
 * promise_followup — universal tool, ToolLoader entry point.
 *
 * The implementation lives in @core/followups, next to
 * build_followup_trigger (which the deliver-followup route imports).
 * This thin module places the tool under a loader-watched root
 * (src/tools — the home for cross-cutting tools that belong to no
 * single specialist or connector) and adapts the dependency bag.
 */
import type { Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { make_promise_followup } from '@core/followups';

export function create(deps: ToolDeps): Tool {
  return make_promise_followup(deps.db) as Tool;
}
