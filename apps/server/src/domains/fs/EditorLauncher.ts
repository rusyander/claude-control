import { spawn, spawnSync } from 'node:child_process';
import { shellArgs } from '../../lib/cli-args.ts';

/**
 * Открытие проекта во внешнем редакторе кода. Панель умеет и сама вести агента в
 * каталоге, но иногда удобнее открыть проект в редакторе — для этого зовём его
 * CLI (`code`, `cursor`, `webstorm` и т.п.).
 *
 * Команда берётся из настроек или из известного списка, а путь — из проверенного
 * (существующий каталог) и всё равно проходит через экранирование аргументов:
 * на Windows это .cmd-обёртки, и путь с пробелами без кавычек развалился бы.
 */

const isWindows = process.platform === 'win32';

/** Известные редакторы: id, подпись и команда CLI. */
export const KNOWN_EDITORS = [
  { id: 'code', name: 'VS Code', command: 'code' },
  { id: 'code-insiders', name: 'VS Code Insiders', command: 'code-insiders' },
  { id: 'cursor', name: 'Cursor', command: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', command: 'windsurf' },
  { id: 'zed', name: 'Zed', command: 'zed' },
  { id: 'subl', name: 'Sublime Text', command: 'subl' },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm' },
  { id: 'idea', name: 'IntelliJ IDEA', command: 'idea' },
  { id: 'pycharm', name: 'PyCharm', command: 'pycharm' },
  { id: 'phpstorm', name: 'PhpStorm', command: 'phpstorm' },
  { id: 'goland', name: 'GoLand', command: 'goland' },
  { id: 'rider', name: 'Rider', command: 'rider' },
  { id: 'nvim', name: 'Neovim', command: 'nvim' },
] as const;

export interface EditorInfo {
  id: string;
  name: string;
  command: string;
  available: boolean;
}

/** Безопасное имя команды: одно слово, без метасимволов оболочки. */
const SAFE_COMMAND = /^[a-zA-Z0-9._-]+$/;

/** Есть ли команда в PATH. Пустую и небезопасную сразу отвергаем. */
export function commandExists(command: string): boolean {
  if (!SAFE_COMMAND.test(command)) return false;
  // Без shell: имя команды уже проверено регуляркой, а where.exe/which
  // находятся по PATH сами. Так нет и предупреждения DEP0190.
  const probe = isWindows
    ? spawnSync('where', [command], { windowsHide: true })
    : spawnSync('which', [command]);
  return probe.status === 0;
}

/**
 * Какие из известных редакторов реально установлены (есть в PATH). Проверка —
 * это десяток запусков `where`/`which`, поэтому результат кэшируем на процесс:
 * набор редакторов за сессию не меняется, а страница настроек открывается часто.
 */
let editorsCache: EditorInfo[] | undefined;

export function detectEditors(): EditorInfo[] {
  if (!editorsCache) {
    editorsCache = KNOWN_EDITORS.map((editor) => ({
      ...editor,
      available: commandExists(editor.command),
    }));
  }
  return editorsCache;
}

/**
 * Выбрать команду редактора: явно заданную (если валидна и найдена), иначе
 * настроенную, иначе первый найденный из известных. Вернёт undefined, если
 * подходящего редактора нет вовсе.
 */
export function resolveEditorCommand(preferred?: string): string | undefined {
  if (preferred && SAFE_COMMAND.test(preferred) && commandExists(preferred)) return preferred;
  const found = detectEditors().find((editor) => editor.available);
  return found?.command;
}

/** Запустить редактор на каталоге, не блокируя сервер (fire-and-forget). */
export function openInEditor(path: string, command: string): void {
  const editorCommand = isWindows && SAFE_COMMAND.test(command) ? `${command}.cmd` : command;
  const child = spawn(editorCommand, shellArgs([path]), {
    shell: isWindows,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  // Отвязываем: редактор живёт своей жизнью и не должен держать наш процесс.
  child.unref();
}
