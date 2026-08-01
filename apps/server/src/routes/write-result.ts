/**
 * Ответ на любое изменение конфигурации.
 *
 * Всегда содержит `needsRestart`: почти всё, что правит панель, Claude Code
 * перечитывает только при старте, и интерфейс должен честно об этом
 * предупреждать. `backupPath` появляется, когда копия перед записью делалась.
 */
export type WriteResult = { ok: true; backupPath?: string; needsRestart: true };

/** Успешный ответ на запись: путь копии (если была) плюс требование перезапуска. */
export const done = (backupPath?: string): WriteResult => ({
  ok: true,
  backupPath,
  needsRestart: true,
});
