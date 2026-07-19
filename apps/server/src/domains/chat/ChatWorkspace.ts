import { existsSync, mkdirSync } from 'node:fs';
import { findSessionCwd } from './ChatHistory.ts';
import { chatDirectory, isSandboxPath } from './ChatArtifacts.ts';

/**
 * Рабочая папка разговора.
 *
 * Claude Code привязывает сессию к каталогу, из которого её начали: `--resume`
 * ищет её только среди сессий текущей папки. Поэтому у чата не может быть
 * «своей» папки на выбор — она определяется тем, где разговор начинался.
 * Для чатов, заведённых в панели, это папка песочницы; для разговоров из
 * терминала или редактора — настоящий каталог проекта.
 */

export interface Workspace {
  cwd: string;
  /** Папка песочницы — в ней Claude волен создавать файлы. */
  isSandbox: boolean;
  /** Каталог проекта исчез: продолжать разговор негде. */
  isMissing: boolean;
}

/**
 * Где запускать Claude для этого чата.
 *
 * Известную сессию ведём в её родной каталог — иначе продолжение разговора
 * невозможно. Новый чат по умолчанию получает папку в песочнице; но если задан
 * `targetCwd` (пользователь открыл проект), новый разговор начинается прямо в
 * каталоге проекта. После первого ответа сессия привяжется к нему сама, и
 * `targetCwd` больше не нужен — путь вернёт `findSessionCwd`.
 */
export function resolveWorkspace(
  projectsDir: string,
  chatId: string,
  sessionId?: string,
  create = true,
  targetCwd?: string,
): Workspace {
  const known = findSessionCwd(projectsDir, sessionId ?? chatId);

  if (!known) {
    // Новый чат в выбранном проекте: ведём разговор в его каталоге. Каталог
    // мог исчезнуть — тогда честно помечаем, что работать негде.
    if (targetCwd) {
      return {
        cwd: targetCwd,
        isSandbox: isSandboxPath(targetCwd),
        isMissing: !existsSync(targetCwd),
      };
    }
    return { cwd: chatDirectory(chatId, create), isSandbox: true, isMissing: false };
  }

  const isSandbox = isSandboxPath(known);

  // Свою папку восстанавливаем молча, чужой проект — не выдумываем: если
  // каталог переехал или удалён, честнее сказать об этом, чем начать разговор
  // в пустоте на его месте.
  if (!existsSync(known)) {
    if (!isSandbox) return { cwd: known, isSandbox, isMissing: true };
    if (create) mkdirSync(known, { recursive: true });
  }

  return { cwd: known, isSandbox, isMissing: false };
}

/**
 * Режим прав для запуска.
 *
 * В песочнице Claude пишет свободно — там его файлы и есть результат работы.
 * В настоящем проекте по умолчанию только чтение: панель не должна молча
 * править рабочий код. Разрешение выдаётся осознанно, тумблером в шапке чата.
 */
export function permissionModeFor(workspace: Workspace, allowEdits?: boolean): string {
  if (workspace.isSandbox || allowEdits) return 'acceptEdits';
  return 'default';
}
