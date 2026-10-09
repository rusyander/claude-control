import type { OpencodePermissionInfo, OpencodePermissionEntry } from '@agentdeck/contracts';
import type { OpencodeFormState } from './opencodePermissionForm.types';

/** Собрать черновик для сервера: только ЗАДАННЫЕ ограничения. */
export function toOpencodeEntries(
  data: OpencodePermissionInfo,
  state: OpencodeFormState,
): OpencodePermissionEntry[] {
  const entries: OpencodePermissionEntry[] = [];
  for (const tool of data.tools) {
    // Запись, которую панель не ведёт, в черновик не попадает никогда.
    if (data.preserved.some((item) => item.key === tool)) continue;

    const choice = state.choices[tool] ?? 'unset';
    if (choice === 'unset') continue;

    if (choice === 'patterns') {
      const rules = (state.patterns[tool] ?? [])
        .map((row) => ({ pattern: row.pattern.trim(), level: row.level }))
        .filter((row) => row.pattern.length > 0);
      if (rules.length > 0) entries.push({ tool, mode: 'patterns', patterns: rules });
      continue;
    }

    entries.push({ tool, mode: 'level', level: choice });
  }
  return entries;
}
