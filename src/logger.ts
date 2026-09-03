type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";
export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const line = { t: new Date().toISOString(), level, msg, ...meta };
  const out = JSON.stringify(line, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  if (level === "error" || level === "warn") process.stderr.write(out + "\n");
  else process.stdout.write(out + "\n");
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
