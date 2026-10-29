import { dirname, join, resolve } from 'node:path';
import { markerSweep, type MarkerSweep } from '../../platform/env-marker.ts';
import type { Fact } from '../../platform/os-kind.ts';
import type { ProcessIdentity } from '../../platform/process-table.ts';
import {
  COMPOSE_PROJECT_LABEL,
  containersByLabel,
  listenersOfPids,
  listWorktrees,
  parseDockerPs,
  TASK_LABEL,
  type LabelledContainer,
  type OwnedListener,
} from '../../platform/resource-scan.ts';
import { runTool } from '../../platform/run-tool.ts';
import { pathExists } from '../../platform/safe-io/files.ts';
import type { TaskLabelReader } from './unlabelled.ts';

/**
 * Читатели ресурсов сессии (`resources.ts`): рабочие копии, контейнеры по метке и проекту, поды,
 * слушатели дерева, переродители по метке. Подменяются в тестах целиком (внешняя граница —
 * движок и таблицы ОС); молчащий движок — `unknown`, не «ничего нет» (F25).
 */

export interface ResourceReaders {
  worktrees(repo: string): Promise<Fact<{ path: string }[]>>;
  containers(taskId: string, engine: string): Promise<Fact<LabelledContainer[]>>;
  listeners(roots: ProcessIdentity[], extra: ProcessIdentity[]): Promise<Fact<OwnedListener[]>>;
  sweep: MarkerSweep;
  /** Контейнеры проекта compose, названного самим вызовом (G18); нет читателя — назван непрочитанным. */
  projectContainers?(project: string, engine: string): Promise<Fact<string[]>>;
  /** Поды podman с меткой задачи (`pod create` получает метку, G18). */
  pods?(taskId: string, engine: string): Promise<Fact<string[]>>;
  /** ВСЕ контейнеры движка до сессии: id из журнала вызовов, бывший до неё, — не ресурс задачи. */
  allContainers?(engine: string): Promise<Fact<string[]>>;
  /** ВСЕ поды podman до сессии — то же для подов. */
  allPods?(engine: string): Promise<Fact<string[]>>;
  /** Метка задачи на id из журнала вызовов: чужая — не ресурс этой задачи. */
  taskLabelOf?: TaskLabelReader;
}

/**
 * Каталог внутри рабочей копии git: `.git` (каталог или файл копии) у него или у предка. Без него
 * `git worktree list` падает — и это не «не прочитано», а «рабочих копий нет»: иначе каждая сессия
 * вне репозитория получала бы ложный сигнал `resources-unread`. Текст ошибки git переведён на язык
 * системы, поэтому решает файловая система, а не разбор сообщения.
 */
export function insideGitRepo(dir: string): boolean {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (pathExists(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
}

/** id строками `ps -q`; движок не ответил — `unknown` (молчащий движок — не «ничего нет», F25). */
async function idsByTool(engine: string, args: string[]): Promise<Fact<string[]>> {
  const got = await runTool(engine, args, { timeoutMs: 20_000 });
  if (!got.ok)
    return { unknown: `${engine}: ${(got.stderr ?? got.reason).trim().split(/\r?\n/)[0] ?? ''}` };
  return { value: parseDockerPs(got.stdout).map((row) => row.id) };
}

export const REAL_READERS: ResourceReaders = {
  worktrees: async (repo) => (insideGitRepo(repo) ? listWorktrees(repo) : { value: [] }),
  containers: (taskId, engine) => containersByLabel(taskId, engine),
  listeners: (roots, extra) => listenersOfPids(roots, extra),
  sweep: markerSweep(),
  projectContainers: (project, engine) =>
    idsByTool(engine, ['ps', '-a', '-q', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`]),
  pods: (taskId, engine) =>
    idsByTool(engine, ['pod', 'ps', '-q', '--filter', `label=${TASK_LABEL}=${taskId}`]),
  allContainers: (engine) => idsByTool(engine, ['ps', '-a', '-q']),
  allPods: (engine) => idsByTool(engine, ['pod', 'ps', '-q']),
  taskLabelOf: async (engine, id, pod) => {
    const field = pod ? '.Labels' : '.Config.Labels';
    const args = pod ? ['pod', 'inspect'] : ['inspect', '--type', 'container'];
    const got = await runTool(
      engine,
      [...args, '--format', `{{index ${field} "${TASK_LABEL}"}}`, id],
      {
        timeoutMs: 20_000,
      },
    );
    if (!got.ok) return { unknown: `${engine} inspect: ${got.reason}` };
    const label = got.stdout.trim();
    return { value: label === '' || label === '<no value>' ? null : label };
  },
};
