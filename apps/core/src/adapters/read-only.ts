/**
 * Шаг только читает (ревью, P73): запись, правка и оболочка сняты встроенными средствами CLI.
 * Значение времени выполнения живёт здесь, а не в `*.types.ts`: тот исключён из покрытия (F-96).
 * Тип — литералами, без импорта `adapter.types.ts`: тот реэкспортирует это значение, и импорт
 * назад замкнул бы круг (`no-circular`). Расхождение с `CoreToolClass` ловит проверка типов там,
 * где набор передаётся как `CoreToolClass[]` (`claudeDenyRules`, `qwenDenyRules`).
 */
export const READ_ONLY_DENIED: readonly ('write' | 'edit' | 'shell')[] = ['write', 'edit', 'shell'];

/**
 * Набор `none` (вопрос «ask», этап 10 F2): к снятому у чтения — ещё и сеть. Чтение и поиск
 * переходник снимает своими средствами (Claude — `--tools`, Qwen — `--exclude-tools`).
 */
export const NONE_DENIED: readonly ('write' | 'edit' | 'shell' | 'web')[] = [
  ...READ_ONLY_DENIED,
  'web',
];

/** Классы, снятые набором инструментов шага; `all` — ничего. */
export function deniedClassesOf(
  tools: 'all' | 'read-only' | 'none',
): readonly ('write' | 'edit' | 'shell' | 'web')[] {
  if (tools === 'none') return NONE_DENIED;
  return tools === 'read-only' ? READ_ONLY_DENIED : [];
}
