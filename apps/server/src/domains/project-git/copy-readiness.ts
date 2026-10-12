import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import { readJsonFile } from '../../lib/safe-io/safe-io.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { copyProjectAccess, projectKey } from './copy-access.ts';
import { LINK_DIRS, mirrorLocalLayer } from './mirror-local.ts';
import { layoutForCwd } from './cwd-layout.ts';

// Раскладка читается файлами и живёт отдельно: её зовёт запуск каждого прогона,
// и тянуть туда git-обвязку починки копии незачем.
export { layoutForCwd, type CwdLayout } from './cwd-layout.ts';

/**
 * Готова ли копия к работе агента.
 *
 * Зеркало и запись доступа делаются при создании копии, и оба могут не
 * доделаться: файл занят, диск, оборванный процесс, копия заведена руками через
 * `git worktree add` мимо панели. Дальше агент в такой копии либо спрашивает
 * человека то, на что тот уже отвечал, либо работает без своих переходников и
 * правил — и то и другое выглядит как «панель сломалась», а на самом деле копия
 * просто неполная.
 *
 * Поэтому перед стартом прогона копия сверяется с оригиналом. Проверка
 * НАМЕРЕННО дешёвая — десяток обращений к файловой системе и одно чтение
 * `.claude.json`: она стоит на горячем пути каждого запуска. Полная сверка
 * (всё, что планирует зеркало) живёт на кнопке карточки и при создании копии.
 */

/**
 * Что решает автономность копии. Не весь локальный слой: файл, которого нет и
 * в оригинале, не отсутствует — его просто нет в проекте.
 */
const MCP_CONFIG = '.mcp.json';

const CRITICAL: readonly string[] = [
  MCP_CONFIG,
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CLAUDE.local.md',
  '.env',
];

export type CopyGapKind = 'file' | 'link' | 'access' | 'mcp';

export interface CopyGap {
  kind: CopyGapKind;
  /** Путь относительно корня копии или ключ записи доступа. */
  path: string;
  /** `mcp`: серверы оригинала, которых нет в `.mcp.json` копии. */
  names?: string[];
}

export interface CopyReadiness {
  ready: boolean;
  gaps: CopyGap[];
  /** Состояние записи доступа копии — см. `WorktreeCopyState.access`. */
  access: 'ok' | 'missing' | 'unknown';
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Именно ФАЙЛ, а не «что-нибудь по этому пути».
 *
 * `existsSync` отвечает «есть» и на каталог: копия, где вместо `.mcp.json`
 * оказался каталог (сорванный перенос, чужая программа, ручная правка),
 * проходила проверку как полная, а агент в ней читал переходники ниоткуда.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface ClaudeJson {
  projects?: Record<string, unknown>;
}

/**
 * Имена MCP-серверов из `.mcp.json`; нечитаемый файл — пустой список.
 *
 * Наличия файла мало: отслеживаемый `.mcp.json`, у которого в оригинале
 * локальная правка под `skip-worktree`, в копии после `git checkout --`,
 * `stash`, перебазирования или любой операции с индексом снова становится
 * ЗАКОММИЧЕННЫМ — файл на месте, а серверов, ради которых он правился, нет.
 * Агент узнаёт об этом посреди работы, когда инструмента не оказалось.
 */
export function mcpServerNames(path: string): string[] {
  if (!isFile(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown };
    const servers = data.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers)
      ? Object.keys(servers)
      : [];
  } catch {
    return [];
  }
}

/** Есть ли у каталога запись в `.claude.json` — регистр и слэши не различаем. */
export function hasProjectAccess(claudeJsonPath: string, dir: string): boolean {
  if (!existsSync(claudeJsonPath)) return false;
  let data: ClaudeJson;
  try {
    data = readJsonFile<ClaudeJson>(claudeJsonPath, {});
  } catch {
    return false;
  }
  const wanted = normalizeProjectPath(dir);
  return Object.keys(data.projects ?? {}).some((key) => normalizeProjectPath(key) === wanted);
}

/**
 * Сверить копию с оригиналом перед стартом агента.
 *
 * `claudeJsonPath` пустой — доступ не проверяем (панель работает не с Claude
 * Code, либо путь неизвестен): тогда честнее промолчать, чем держать копию.
 */
export function checkCopyReady(input: {
  mainDir: string;
  copyDir: string;
  claudeJsonPath?: string;
}): CopyReadiness {
  const gaps: CopyGap[] = [];

  for (const rel of CRITICAL) {
    if (!isFile(join(input.mainDir, rel))) continue;
    if (!isFile(join(input.copyDir, rel))) gaps.push({ kind: 'file', path: rel });
  }

  // Файл есть, а серверов оригинала в нём нет — см. `mcpServerNames`. Лишние
  // серверы копии не дыра: их мог добавить сам агент для своей задачи.
  if (isFile(join(input.mainDir, MCP_CONFIG)) && isFile(join(input.copyDir, MCP_CONFIG))) {
    const present = new Set(mcpServerNames(join(input.copyDir, MCP_CONFIG)));
    const names = mcpServerNames(join(input.mainDir, MCP_CONFIG)).filter(
      (name) => !present.has(name),
    );
    if (names.length > 0) gaps.push({ kind: 'mcp', path: MCP_CONFIG, names });
  }

  for (const rel of LINK_DIRS) {
    if (!isDir(join(input.mainDir, rel))) continue;
    // Мёртвая ссылка ведёт себя хуже отсутствия: каталог как бы есть, а читать
    // из него нечего, и агент находит пустой список скиллов.
    if (!isDir(join(input.copyDir, rel))) gaps.push({ kind: 'link', path: rel });
  }

  // Запись доступа спрашивается только там, где на неё можно ответить. Нет
  // самого `.claude.json` (панель ведёт другой CLI, свежая машина) или у
  // ОРИГИНАЛА записи никогда не было — копировать нечего, и держать из-за
  // этого прогоны значило бы запереть работу навсегда: ни зеркало, ни добор
  // такую запись не придумают.
  let access: CopyReadiness['access'] = 'unknown';
  if (input.claudeJsonPath && existsSync(input.claudeJsonPath)) {
    if (hasProjectAccess(input.claudeJsonPath, input.copyDir)) {
      access = 'ok';
    } else if (hasProjectAccess(input.claudeJsonPath, input.mainDir)) {
      access = 'missing';
      gaps.push({ kind: 'access', path: projectKey(input.copyDir) });
    }
  }

  return { ready: gaps.length === 0, gaps, access };
}

/**
 * Копия ли этот каталог, и если да — готова ли она.
 *
 * Стоит на старте прогона, поэтому отвечает «готово» на всё, чего не понимает:
 * не репозиторий, раскладка нечитаема, каталог — основная копия. Держать
 * человека из-за собственной неуверенности проверка не вправе.
 */
export async function readinessForCwd(
  cwd: string,
  claudeJsonPath?: string,
): Promise<CopyReadiness & { mainDir?: string }> {
  const { mainDir, copyDir } = layoutForCwd(cwd);
  if (!mainDir || !copyDir) return { ready: true, gaps: [], access: 'unknown' };
  if (!existsSync(mainDir)) return { ready: true, gaps: [], access: 'unknown' };

  return {
    ...checkCopyReady({
      mainDir,
      copyDir,
      ...(claudeJsonPath ? { claudeJsonPath } : {}),
    }),
    mainDir,
  };
}

/**
 * Добрать недостающее самим и сказать, что вышло.
 *
 * Правило простое: чинить молча, держать громко. Человек не должен нажимать
 * кнопку за панель — он и так уже сказал, чего хочет, запустив агента; а вот
 * если добор не помог, прогон не начинается и причина названа, потому что агент
 * в неполной копии молча делает не ту работу.
 */
export async function repairCopy(input: {
  mainDir: string;
  copyDir: string;
  mirror?: WorktreeMirrorSettings;
  claudeJsonPath?: string;
}): Promise<CopyReadiness> {
  // Повторное зеркало переносит только то, что в оригинале свежее, а
  // откаченный в копии `.mcp.json` по времени как раз свежее рабочего. Его
  // дыру видно только по содержимому — и переписывается он поверх времени.
  const before = checkCopyReady(input);
  const force = before.gaps.filter((gap) => gap.kind === 'mcp').map((gap) => gap.path);
  try {
    await mirrorLocalLayer(input.mainDir, input.copyDir, input.mirror, {
      newerOnly: true,
      ...(force.length > 0 ? { force } : {}),
    });
  } catch {
    // Причину назовёт сверка ниже — дыры важнее текста ошибки переноса.
  }
  if (input.claudeJsonPath) {
    copyProjectAccess(input.claudeJsonPath, input.mainDir, input.copyDir);
  }
  return checkCopyReady({
    mainDir: input.mainDir,
    copyDir: input.copyDir,
    ...(input.claudeJsonPath ? { claudeJsonPath: input.claudeJsonPath } : {}),
  });
}

/** Строка для человека: чего копии не хватает. */
export function describeGaps(gaps: readonly CopyGap[]): string {
  const files = gaps.filter((gap) => gap.kind === 'file').map((gap) => gap.path);
  const links = gaps.filter((gap) => gap.kind === 'link').map((gap) => gap.path);
  const access = gaps.some((gap) => gap.kind === 'access');
  const servers = gaps.flatMap((gap) => (gap.kind === 'mcp' ? (gap.names ?? []) : []));
  const parts: string[] = [];
  if (files.length > 0)
    parts.push(serverText('worktree-copy-gap-files', { files: files.join(', ') }));
  if (links.length > 0)
    parts.push(serverText('worktree-copy-gap-links', { links: links.join(', ') }));
  if (servers.length > 0)
    parts.push(serverText('worktree-copy-gap-mcp', { names: servers.join(', ') }));
  if (access) parts.push(serverText('worktree-copy-gap-access'));
  return parts.join('; ');
}
