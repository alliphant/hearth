/**
 * Vivian's specialist tool pack. Picked up by ToolLoader's
 * src/specialists scan (pattern /tools/) via the create(deps) factory —
 * mirror of kate/tools/index.ts.
 */
import type { Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { make_refresh_market_radar } from './refresh_market_radar';
import { make_update_market_themes } from './update_market_themes';

export function create(deps: ToolDeps): Tool[] {
  return [
    make_refresh_market_radar(deps.db) as Tool,
    make_update_market_themes() as Tool,
  ];
}
