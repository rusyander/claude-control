import { spawn, spawnSync } from 'node:child_process';
import { shellArgs } from '../../lib/cli-args.ts';

/**
 * Открытие проекта в VS Code. Панель умеет и сама вести агента в каталоге, но
 * иногда удобнее открыть проект в редакторе — для этого зовём его CLI `code`.
 *
 * Путь берётся из проверенного списка (существующий каталог), но всё равно
 * проходит через экранирование аргументов оболочки: на Windows `code` — это
 * .cmd, и без кавычек путь с пробелами развалился бы на части.
 */

const isWindows = process.platform === 'win32';
const EDITOR_COMMAND = isWindows ? 'code.cmd' : 'code';

/** Есть ли `code` в PATH: иначе честнее сказать, что редактор не найден. */
export function isEditorAvailable(): boolean {
  const probe = isWindows
    ? spawnSync('where', ['code'], { shell: true, windowsHide: true })
    : spawnSync('which', ['code']);
  return probe.status === 0;
}

/** Запустить редактор на каталоге, не блокируя сервер (fire-and-forget). */
export function openInEditor(path: string): void {
  const child = spawn(EDITOR_COMMAND, shellArgs([path]), {
    shell: isWindows,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  // Отвязываем: редактор живёт своей жизнью и не должен держать наш процесс.
  child.unref();
}
