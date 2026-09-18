import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import { readJsonFile } from '../../lib/safe-io.ts';
import { serverText } from '../../lib/server-texts.ts';
import { copyProjectAccess, projectKey } from './copy-access.ts';
import { LINK_DIRS, mirrorLocalLayer } from './mirror-local.ts';

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
const CRITICAL: readonly string[] = [
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CLAUDE.local.md',
  '.env',
];

export type CopyGapKind = 'file' | 'link' | 'access';

export interface CopyGap {
  kind: CopyGapKind;
  /** Путь относительно корня копии или ключ записи доступа. */
  path: string;
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

/** Есть ли у каталога запись в `.claude.json` — регистр и слэши не различаем. */
export function hasProjectAccess(claudeJsonPath: string, dir: string): boolean {
  if (!existsSync(claudeJsonPath)) return false;
  let data: ClaudeJson;
  try {
    data = readJsonFile<ClaudeJson>(claudeJsonPath, {});
  } catch {
    return false;
  }
  const wanted = projectKey(dir).toLowerCase();
  return Object.keys(data.projects ?? {}).some(
    (key) => key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === wanted,
  );
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
 * Раскладка каталога: копия ли он и от какого оригинала.
 *
 * Пустой ответ значит «сверять не с чем» — не репозиторий, основная копия,
 * подмодуль, нечитаемая раскладка.
 */
export interface CwdLayout {
  mainDir?: string;
  copyDir?: string;
}

/**
 * Читается ФАЙЛАМИ, без запуска git, и это главное свойство функции.
 *
 * Раскладку спрашивают на КАЖДОМ сообщении человека, а `git rev-parse` — это
 * порождение процесса: на этой машине измерено 44–62 мс на посылку, одинаково
 * внутри репозитория и вне его. Столько стоило узнать то, что git сам же
 * записал в два маленьких файла: рабочая копия помечена `.git`-ФАЙЛОМ со
 * строкой `gitdir:`, а общий каталог назван в `commondir` рядом. Читаем их —
 * получается тот же ответ за несколько обращений к файловой системе.
 *
 * Отличать копию от подмодуля умеет тот же `commondir`: у подмодуля (его
 * `.git` — тоже файл, но ведёт в `.git/modules/…`) этого файла нет, и каталог
 * честно читается как «не копия».
 */
export function layoutForCwd(cwd: string): CwdLayout {
  let dir = resolve(cwd);
  for (;;) {
    const marker = join(dir, '.git');
    // Каталог `.git` — обычный репозиторий, он сам себе источник.
    if (isDir(marker)) return {};
    if (isFile(marker)) return fromGitFile(dir, marker);

    const up = dirname(dir);
    if (up === dir) return {};
    dir = up;
  }
}

function fromGitFile(copyDir: string, marker: string): CwdLayout {
  let gitDir: string;
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
    if (!pointer?.[1]) return {};
    gitDir = resolve(copyDir, pointer[1].trim());
  } catch {
    return {};
  }

  let commonDir: string;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return {};
  }

  const mainDir = resolve(dirname(commonDir));
  if (mainDir.toLowerCase() === copyDir.toLowerCase()) return {};
  return { mainDir, copyDir };
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
  try {
    await mirrorLocalLayer(input.mainDir, input.copyDir, input.mirror, { newerOnly: true });
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
  const parts: string[] = [];
  if (files.length > 0)
    parts.push(serverText('worktree-copy-gap-files', { files: files.join(', ') }));
  if (links.length > 0)
    parts.push(serverText('worktree-copy-gap-links', { links: links.join(', ') }));
  if (access) parts.push(serverText('worktree-copy-gap-access'));
  return parts.join('; ');
}
