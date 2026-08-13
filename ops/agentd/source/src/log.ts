// Structured JSON-line logger to stdout. journald picks this up via the unit.
export type LogFields = Record<string, unknown>;

export function log(level: "info" | "warn" | "error" | "debug", event: string, fields: LogFields = {}) {
  const rec = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  // single JSON line per log
  console.log(JSON.stringify(rec));
}

export const info = (event: string, fields?: LogFields) => log("info", event, fields);
export const warn = (event: string, fields?: LogFields) => log("warn", event, fields);
export const error = (event: string, fields?: LogFields) => log("error", event, fields);
export const debug = (event: string, fields?: LogFields) => {
  if (process.env.AGENTD_DEBUG === "1") log("debug", event, fields);
};
