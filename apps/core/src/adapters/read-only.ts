/**
 * Шаг только читает (ревью, P73): запись, правка и оболочка сняты встроенными средствами CLI.
 * Значение времени выполнения живёт здесь, а не в `*.types.ts`: тот исключён из покрытия (F-96).
 * Тип — литералами, без импорта `adapter.types.ts`: тот реэкспортирует это значение, и импорт
 * назад замкнул бы круг (`no-circular`). Расхождение с `CoreToolClass` ловит проверка типов там,
 * где набор передаётся как `CoreToolClass[]` (`claudeDenyRules`, `qwenDenyRules`).
 */
export const READ_ONLY_DENIED: readonly ('write' | 'edit' | 'shell')[] = ['write', 'edit', 'shell'];
