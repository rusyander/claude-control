import { existsSync } from 'node:fs';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';

/**
 * Доступ копии = запись КАТАЛОГА в `.claude.json`, а не файлы в репозитории.
 *
 * Зеркало переносит `.mcp.json`, `.claude/**` и остальной локальный слой, и всё
 * равно агент в новой копии начинал с двух вопросов: «доверяете ли вы файлам в
 * этой папке» и «включить серверы из .mcp.json». Причина в том, что ответы на
 * них Claude Code хранит НЕ в проекте, а у себя — в `.claude.json`, под ключом
 * рабочего каталога. У свежей копии каталог новый, записи нет, и человека
 * спрашивают заново: файлами это не лечится в принципе.
 *
 * Поэтому запись копии заводится из записи оригинала — с доверием, списками
 * включённых и выключенных серверов `.mcp.json`, своими MCP-серверами и
 * разрешёнными инструментами. Не переносится статистика прошлых прогонов
 * (`last*`) и история: это следы работы оригинала, копии они лгут.
 *
 * Ключ — путь с прямыми слэшами, ровно в том написании, с каким панель
 * запускает CLI в этой копии: сам CLI ключует записи строкой рабочего каталога
 * и на Windows держит `c:/…` и `C:/…` как разные (в файле владельца лежат обе).
 */

/** Ключ записи проекта: путь с прямыми слэшами, без хвостового слэша. */
export function projectKey(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Следы работы оригинала — в копию не идут. */
function isTrace(key: string): boolean {
  return key.startsWith('last') || key === 'history' || key === 'hasUnseenTeamArtifacts';
}

export interface CopyAccessResult {
  /** Запись заведена (или обновлена). */
  copied: boolean;
  /** Ключ, под которым заведена запись копии. */
  key: string;
  /** Почему не заведена: файла нет, записи оригинала нет, ошибка записи. */
  reason?: string;
  /**
   * Та же причина кодом — с ней клиент покажет её на своём языке. Ошибка
   * файловой системы кода не несёт: её текст пишет система, и переводить его
   * нечем, поэтому поле необязательное.
   */
  reasonCode?: ServerMessageCode;
  /** Сколько полей перенесено — для отчёта и проверки. */
  fields?: number;
}

interface ClaudeJson {
  projects?: Record<string, Record<string, unknown>>;
}

/**
 * Найти запись оригинала. Сравнение по нормализованному пути: на Windows
 * регистр ключа зависит от того, из какой оболочки CLI запускали, и запись
 * `c:/work/x` должна найтись по пути `C:\work\x`.
 */
function findEntry(
  projects: Record<string, Record<string, unknown>>,
  dir: string,
): Record<string, unknown> | undefined {
  const wanted = projectKey(dir).toLowerCase();
  const exact = projects[projectKey(dir)];
  if (exact) return exact;
  for (const [key, value] of Object.entries(projects)) {
    if (key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Завести копии запись доступа по образцу оригинала.
 *
 * Существующая запись копии не затирается целиком: человек мог уже что-то в ней
 * ответить, и его ответ старше нашего. Дописываем только то, чего в ней нет.
 */
export function copyProjectAccess(
  claudeJsonPath: string,
  mainDir: string,
  copyDir: string,
): CopyAccessResult {
  const key = projectKey(copyDir);
  if (!existsSync(claudeJsonPath)) {
    return {
      copied: false,
      key,
      reason: 'файла .claude.json нет',
      reasonCode: 'worktree-access-no-claude-json',
    };
  }
  let data: ClaudeJson;
  try {
    data = readJsonFile<ClaudeJson>(claudeJsonPath, {});
  } catch (error) {
    return { copied: false, key, reason: error instanceof Error ? error.message : String(error) };
  }
  const projects = data.projects ?? {};
  const source = findEntry(projects, mainDir);
  if (!source) {
    return {
      copied: false,
      key,
      reason: 'у оригинала нет записи в .claude.json',
      reasonCode: 'worktree-access-no-origin-entry',
    };
  }

  const carried: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(source)) {
    if (!isTrace(field)) carried[field] = value;
  }
  const existing = projects[key] ?? {};
  const next = { ...carried, ...existing };
  // Доверие и списки серверов — ради них всё и затевалось: если человек их в
  // копии ещё не отвечал, они приходят из оригинала (выше), а если отвечал —
  // остаются его.
  projects[key] = next;
  data.projects = projects;

  try {
    writeJsonFile(claudeJsonPath, data, { preserveForm: true });
  } catch (error) {
    return { copied: false, key, reason: error instanceof Error ? error.message : String(error) };
  }
  return { copied: true, key, fields: Object.keys(carried).length };
}

/**
 * Убрать запись копии — вместе с самой копией.
 *
 * Иначе `.claude.json` растёт списком мёртвых каталогов, а доверие к пути,
 * которого больше нет, когда-нибудь достанется другой ветке с тем же именем.
 */
export function dropProjectAccess(claudeJsonPath: string, copyDir: string): boolean {
  if (!existsSync(claudeJsonPath)) return false;
  let data: ClaudeJson;
  try {
    data = readJsonFile<ClaudeJson>(claudeJsonPath, {});
  } catch {
    return false;
  }
  const projects = data.projects;
  if (!projects) return false;
  const wanted = projectKey(copyDir).toLowerCase();
  const keys = Object.keys(projects).filter(
    (key) => key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === wanted,
  );
  if (keys.length === 0) return false;
  for (const key of keys) delete projects[key];
  try {
    writeJsonFile(claudeJsonPath, data, { preserveForm: true });
  } catch {
    return false;
  }
  return true;
}
