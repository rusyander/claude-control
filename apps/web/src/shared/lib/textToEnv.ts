export function textToEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key) result[key] = trimmed.slice(separator + 1).trim();
  }

  return result;
}
