import type { EconomyRunInput } from './economy-run.types.ts';

/**
 * Канал Gemini CLI — пуст НАМЕРЕННО, и каталог (`catalog/gemini.ts`) канала не
 * объявляет: диспетчер сюда не приходит.
 *
 * Оба родных ключа (`model.compressionThreshold`, `tools.truncateToolOutputThreshold`)
 * живут только в файлах настроек. Путь на прогон — файл системных настроек
 * (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) — переменную CLI читает, но сам файл
 * проверяет: он и все каталоги над ним должны принадлежать администратору
 * (Windows: Administrators/SYSTEM без прав записи у пользователей; POSIX: root,
 * без записи группой и прочими — `isFileAndDirectorySecureSync`). Живая проба
 * 22.10.2026 (gemini 0.65.0 из npm, временный дом, заглушка API): файл панели
 * пропущен строкой «Security Warning: Skipping system settings file … is not
 * owned by a trusted administrator or SYSTEM account». Другой путь —
 * `GEMINI_CLI_HOME` — переносит весь каталог CLI (вход, история, настройки
 * человека), а это дороже обоих рычагов. Отсюда в каталоге — «несоразмерно».
 *
 * Заметка на будущее: та же переменная сдвигает и `system-defaults.json` (каталог
 * берётся от файла системных настроек), — если CLI когда-нибудь снимет проверку,
 * канал обязан задать и `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` на прежнее место.
 */
export function geminiEconomyEnv(_input: EconomyRunInput): Record<string, string> | undefined {
  return undefined;
}
