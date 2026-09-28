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

/**
 * Ответ на запись, которую CLI подхватывает сам, без перезапуска (скиллы:
 * Claude Code перечитывает skills/ на лету). Сказать «нужен перезапуск» здесь —
 * соврать человеку, и агент панели повторял бы эту неправду.
 */
export type LiveWriteResult = { ok: true; backupPath?: string; needsRestart: false };

export const live = (backupPath?: string): LiveWriteResult => ({
  ok: true,
  backupPath,
  needsRestart: false,
});
