/**
 * The positional words of a command line: every token that is not a `--flag`
 * and not the value of one of `valueFlags` (flags that take the next token).
 * Keeps flag values out of free-text arguments such as a search query.
 */
export function positionalWords(args: string[], valueFlags: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.includes(arg)) {
      i++; // skip the flag's value too
      continue;
    }
    if (arg.startsWith("--")) continue;
    words.push(arg);
  }
  return words;
}
