import type { Tool, ToolCall, ToolContext } from '@core/tool';
import { append_journal_entry } from './tools/append_journal_entry';
import { find_or_create_person } from './tools/find_or_create_person';
import { upsert_person_note } from './tools/upsert_person_note';
import { record_decision } from './tools/record_decision';
import { link_notes } from './tools/link_notes';

export interface InvokeResult {
  result: unknown;
  error?: string;
}

export class Scribe {
  public name = 'scribe' as const;
  public tools: ReadonlyMap<string, Tool>;

  constructor() {
    const tools: Tool[] = [
      append_journal_entry as Tool,
      find_or_create_person as Tool,
      upsert_person_note as Tool,
      record_decision as Tool,
      link_notes as Tool,
    ];
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Validate input, execute, validate output, return result or error. */
  async invoke(call: ToolCall, ctx: ToolContext): Promise<InvokeResult> {
    const tool = this.tools.get(call.tool_name);
    if (!tool) {
      return { result: null, error: `Unknown tool: ${call.tool_name}` };
    }

    const parsed_in = tool.input_schema.safeParse(call.input);
    if (!parsed_in.success) {
      return {
        result: null,
        error: `Input validation failed: ${parsed_in.error.message}`,
      };
    }

    try {
      const result = await tool.execute(parsed_in.data, ctx);
      const parsed_out = tool.output_schema.safeParse(result);
      if (!parsed_out.success) {
        return {
          result,
          error: `Output validation failed: ${parsed_out.error.message}`,
        };
      }
      return { result };
    } catch (err) {
      return {
        result: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
