import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudePaths } from '@agentdeck/contracts';
import { providerSource } from '@agentdeck/contracts/group-sources';
import { projectKey } from '../../lib/app-store/group-sources.ts';
import type { ConfigProvider } from '../../providers/types/types.ts';
import { projectClaudeDir } from '../groups/members/members.ts';
import { gitSync } from '../project-git/exec/exec.ts';
import { WORKTREES_DIR_SUFFIX } from '../project-git/worktrees.ts';
import { projectLayout, type InventoryLayout } from './inventory.ts';

/**
 * Откуда обнаружение берёт наборы: проекты человека (реестр панели и история
 * чатов) и общие каталоги каждого провайдера. Копия ветки
 * (`<репозиторий>-worktrees/<ветка>`) сворачивается к основному проекту: её
 * `.claude` — те же файлы на другой ветке, и находка из копии была бы дублем.
 */

export interface DiscoverySpec {
  /** Строка источника: путь проекта или `provider:<id>`. */
  source: string;
  kind: 'project' | 'provider';
  /** Корень проекта; у провайдера — его id. */
  root: string;
  providerId: string;
  layout: InventoryLayout;
}

/**
 * Одно написание пути на проект: прямые слэши, без хвостового, буква диска
 * заглавная. Остальной регистр — как пришёл первым: ключ сравнения всё равно
 * `projectKey` (без регистра на Windows), а показывается путь как есть.
 */
export function canonicalPath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:(\/|$)/.test(unified) ? unified[0]!.toUpperCase() + unified.slice(1) : unified;
}

/** Копии, которые заводит сам Claude Code: `<проект>/.claude/worktrees/<имя>`. */
const CLAUDE_WORKTREES = '/.claude/worktrees/';

/**
 * Копия ветки по имени каталога → основной проект: панельная
 * `<репозиторий>-worktrees/<ветка>` и Claude'овская `<проект>/.claude/worktrees/<имя>`.
 * Нужна и когда git не ответил: удалённую копию git уже не узнает, а в
 * истории чатов её путь остался.
 */
export function foldWorktree(path: string): string {
  const unified = canonicalPath(path);
  const lower = unified.toLowerCase();
  const panel = lower.lastIndexOf(`${WORKTREES_DIR_SUFFIX}/`.toLowerCase());
  if (panel >= 0) return unified.slice(0, panel);
  const claude = lower.indexOf(CLAUDE_WORKTREES);
  if (claude >= 0) return unified.slice(0, claude);
  return unified;
}

/**
 * Корень основной копии по git: общий каталог репозитория (`--git-common-dir`)
 * у копии ветки указывает на `.git` основной, у подкаталога — на `.git` своего
 * корня. Так одним вызовом сворачиваются и копии, заведённые где угодно, и
 * рабочие каталоги чатов внутри проекта. Не репозиторий — `undefined`.
 */
export function gitOriginOf(path: string): string | undefined {
  const common = gitSync(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) {
    const unified = canonicalPath(common.trim());
    if (unified.toLowerCase().endsWith('/.git')) return unified.slice(0, -'/.git'.length);
  }
  const top = gitSync(path, ['rev-parse', '--show-toplevel']);
  return top ? canonicalPath(top.trim()) : undefined;
}

/**
 * Опрос страницы обнаружения идёт раз в секунды, а у владельца десятки
 * каталогов чатов: git на каждый — секунды на каждый GET. Чем каталог
 * является (копией, подкаталогом), за время жизни сервера не меняется.
 */
const originMemo = new Map<string, string | undefined>();

function memoGitOrigin(path: string): string | undefined {
  const key = projectKey(path);
  if (!originMemo.has(key)) originMemo.set(key, gitOriginOf(path));
  return originMemo.get(key);
}

/** Сбросить память git-корней — только для тестов. */
export function resetGitOriginMemo(): void {
  originMemo.clear();
}

export interface ProjectSourceOptions {
  /** Каталог конфигурации CLI (`~/.claude`): его родитель — слой провайдера, не проект. */
  configRoot: string;
  /** Домашний каталог человека — тоже не проект (там живёт `~/.claude`). */
  home?: string;
  /**
   * Проекты реестра панели: подкаталог сворачивается к ближайшему из них, сами
   * они в соседей не сворачиваются — их человек назвал проектами сам.
   */
  registered?: readonly string[];
  /** Корень основной копии по git; тесты подменяют. */
  gitOrigin?: (path: string) => string | undefined;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(`${parent}/`);
}

/**
 * Проекты без повторов. Копия ветки — её основной проект; подкаталог
 * известного проекта — этот проект; домашний каталог и каталог, чей `.claude`
 * и есть конфигурация CLI, — не проекты вовсе (их опись — слой провайдера,
 * он приходит источником `provider:claude`). Ключ — `projectKey`: регистр и
 * слэши на Windows не различаются.
 */
export function projectSources(
  paths: readonly string[],
  options: ProjectSourceOptions,
): DiscoverySpec[] {
  const gitOrigin = options.gitOrigin ?? memoGitOrigin;
  const configKey = projectKey(options.configRoot);
  const homeKey = options.home ? projectKey(options.home) : undefined;
  const isProviderLayer = (path: string): boolean =>
    projectKey(path) === homeKey || projectKey(projectClaudeDir(path)) === configKey;
  const registered = new Set((options.registered ?? []).map((path) => projectKey(path)));

  // 1. Каждый путь — к корню основной копии (git, иначе по имени каталога).
  const roots = new Map<string, string>();
  for (const raw of paths) {
    if (!raw) continue;
    const folded = foldWorktree(raw);
    const root = (existsSync(folded) ? gitOrigin(folded) : undefined) ?? folded;
    const key = projectKey(root);
    if (isProviderLayer(root) || isProviderLayer(folded)) continue;
    if (!roots.has(key)) roots.set(key, canonicalPath(root));
  }

  // 2. Подкаталог известного проекта — к ближайшему проекту реестра, иначе к
  // самому внешнему из найденных корней.
  const keys = [...roots.keys()];
  const specs: DiscoverySpec[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const ancestors = keys.filter((other) => isInside(key, other));
    const own = registered.has(key) ? key : undefined;
    const nearestRegistered = ancestors
      .filter((other) => registered.has(other))
      .sort((a, b) => b.length - a.length)[0];
    const outermost = [...ancestors].sort((a, b) => a.length - b.length)[0];
    const target = own ?? nearestRegistered ?? outermost ?? key;
    const root = roots.get(target)!;
    if (seen.has(target) || !existsSync(root)) continue;
    seen.add(target);
    specs.push({
      source: root,
      kind: 'project',
      root,
      providerId: 'claude',
      layout: projectLayout(root),
    });
  }
  return specs;
}

/**
 * Общие каталоги провайдера — из его объявлений в реестре (скиллы, команды,
 * файл инструкций), у Claude — из путей панели (там и хуки, и правила
 * CLAUDE.md, и MCP). Раздел, которого провайдер не объявил, не читается.
 */
export function providerSources(
  providers: readonly ConfigProvider[],
  paths: ClaudePaths,
  override?: string,
): DiscoverySpec[] {
  return providers.map((provider) => {
    const layout: InventoryLayout =
      provider.id === 'claude'
        ? {
            skillsDir: paths.skills,
            agentsDir: join(paths.root, 'agents'),
            commandsDir: join(paths.root, 'commands'),
            hookFiles: { settings: paths.settings },
            mcpFile: paths.mcpConfig,
            instructionFiles: [paths.claudeMd],
          }
        : {
            skillsDir: provider.skillsConfig?.dir(override),
            commandsDir:
              provider.commandsConfig?.format === 'md-frontmatter'
                ? provider.commandsConfig.dir(override)
                : undefined,
            instructionFiles: provider.instructionsFile
              ? [provider.instructionsFile(override)]
              : undefined,
          };
    return {
      source: providerSource(provider.id),
      kind: 'provider' as const,
      root: provider.id,
      providerId: provider.id,
      layout,
    };
  });
}
