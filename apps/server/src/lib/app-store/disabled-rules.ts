import type { AppState, DisabledRuleSnapshot } from './app-store.types.ts';

/**
 * Текст выключенных правил CLAUDE.md.
 *
 * Выключенное правило из CLAUDE.md УБИРАЕТСЯ: Claude Code читает файл целиком,
 * и любой текст в нём, даже в разделе «не действует», стоит токенов на каждом
 * ходе и всё равно доходит до модели (решение владельца 27.09, F1). Значит
 * текст обязан жить здесь, иначе выключение стало бы удалением. Вместе с
 * текстом хранится место правила (соседи и позиция) — включение возвращает его
 * туда, где оно стояло (F2), а не в конец файла.
 */
export function getDisabledRules(state: AppState): DisabledRuleSnapshot[] {
  const stored: unknown = state.disabledRules;
  if (!Array.isArray(stored)) return [];
  // state.json правится и руками, и старыми версиями панели: запись без
  // заголовка или текста не превращаем в правило-призрак.
  return stored.filter(isSnapshot).map((item) => ({ ...item }));
}

export function setDisabledRules(state: AppState, list: readonly DisabledRuleSnapshot[]): void {
  state.disabledRules = list.map((item) => ({ ...item }));
}

function isSnapshot(value: unknown): value is DisabledRuleSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    (item.after === null || typeof item.after === 'string') &&
    (item.before === null || typeof item.before === 'string') &&
    typeof item.index === 'number'
  );
}
