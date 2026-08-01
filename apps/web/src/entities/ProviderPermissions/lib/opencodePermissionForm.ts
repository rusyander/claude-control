import type {
  OpencodePermissionEntry,
  OpencodePermissionInfo,
  OpencodePermissionLevel,
} from '@claude-control/contracts';

/** Значение селекта инструмента: «не задано», уровень или список шаблонов. */
export type OpencodeToolChoice = 'unset' | OpencodePermissionLevel | 'patterns';

/** Строка списка шаблонов в форме (`id` нужен, чтобы строки не «прыгали» при вводе). */
export interface OpencodePatternRow {
  id: number;
  pattern: string;
  level: OpencodePermissionLevel;
}

export interface OpencodeFormState {
  choices: Record<string, OpencodeToolChoice>;
  patterns: OpencodePatternRow[];
}

/** Разложить ответ сервера в состояние формы. */
export function toOpencodeFormState(data: OpencodePermissionInfo): OpencodeFormState {
  const choices: Record<string, OpencodeToolChoice> = {};
  for (const tool of data.tools) choices[tool] = 'unset';

  let patterns: OpencodePatternRow[] = [];
  let nextId = 0;
  for (const entry of data.entries) {
    if (entry.mode === 'patterns') {
      choices[entry.tool] = 'patterns';
      patterns = (entry.patterns ?? []).map((rule) => ({
        id: nextId++,
        pattern: rule.pattern,
        level: rule.level,
      }));
    } else if (entry.level) {
      choices[entry.tool] = entry.level;
    }
  }
  return { choices, patterns };
}

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
      const rules = state.patterns
        .map((row) => ({ pattern: row.pattern.trim(), level: row.level }))
        .filter((row) => row.pattern.length > 0);
      if (rules.length > 0) entries.push({ tool, mode: 'patterns', patterns: rules });
      continue;
    }

    entries.push({ tool, mode: 'level', level: choice });
  }
  return entries;
}

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
