import type { OpencodePermissionEntry } from '@agentdeck/contracts';

/** Нормализованный слепок записей — по нему считается «есть правки». */
export const stableOpencodeEntries = (entries: OpencodePermissionEntry[]): string =>
  JSON.stringify(
    [...entries]
      .sort((a, b) => a.tool.localeCompare(b.tool))
      .map((entry) => [
        entry.tool,
        entry.mode,
        entry.level ?? '',
        (entry.patterns ?? []).map((rule) => [rule.pattern, rule.level]),
      ]),
  );
