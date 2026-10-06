let jsonMode = false;

export function setJsonMode(enabled: boolean) {
  jsonMode = enabled;
}

export function isJsonMode() {
  return jsonMode;
}

// -- ANSI colors (only when stdout is a TTY and not in JSON mode) --

const isTTY = process.stdout.isTTY === true;

export const colors = {
  bold: (s: string) => (isTTY && !jsonMode ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY && !jsonMode ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY && !jsonMode ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY && !jsonMode ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY && !jsonMode ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY && !jsonMode ? `\x1b[36m${s}\x1b[0m` : s),
};

export function json(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function log(msg: string) {
  if (!jsonMode) console.log(msg);
}

export function error(msg: string) {
  if (jsonMode) json({ error: msg });
  else console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
}

export function success(msg: string) {
  if (jsonMode) return;
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

export function warn(msg: string) {
  if (jsonMode) return;
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}

/** Diagnostics for failures the CLI tolerates, printed only with ACP_DEBUG=1.
 *  Goes to stderr only, so --json output stays parseable. */
export function debug(msg: string, err?: unknown): void {
  if (process.env.ACP_DEBUG !== "1") return;
  // Some errors (e.g. spl-token's TokenAccountNotFoundError) have no message.
  console.error(`[debug] ${msg}`, err instanceof Error ? err.message || err.name : err ?? "");
}

export function heading(title: string) {
  if (jsonMode) return;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

export function field(label: string, value: unknown) {
  if (jsonMode) return;
  console.log(`  \x1b[2m${label}:\x1b[0m ${value}`);
}

export function output(data: unknown, humanFn: (d: any) => void) {
  if (jsonMode) json(data);
  else humanFn(data);
}

export function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}
