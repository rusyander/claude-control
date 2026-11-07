import { join } from 'node:path';
import { readTextFact } from '../../platform/safe-io/files.ts';
import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import type { LiveTask } from '../../journal/resume.ts';
import { estimateTask, REQUEST_ARTIFACT } from '../estimate/index.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import { itemCmdId } from '../intake/item-id.ts';
import type { TaskRegistry } from '../tasks.ts';
import { dependentBaseOf, parentBaseFacts } from './child-base.ts';
import type { ProposedUnit } from './split.types.ts';

/**
 * Дочерние задачи XL (этап 11, D18, W3-18, P135): одна цель класса XL делится не единицами одной
 * задачи, а задачами — тем же утверждением/правкой деления (точка 10), на уровне задачи. Каждая
 * часть деления — своя задача тем же путём оценки (приём, разведка, план, работа, ревью,
 * публикация) с `parentTaskId` родителя и общей группой; места сеансов делит распределитель.
 * Родитель единиц не создаёт: его итог — деление и дети, дальше он кончается сам (`next`).
 */

/** Строка журнала родителя: какие дочерние задачи созданы запуском (detail — JSON id). */
export const XL_CHILDREN_SIGNAL = 'xl-children';

/** Группа детей XL: группа родителя, если он сам из группы, иначе своя. */
export function childGroupOf(parent: LiveTask): string {
  return parent.state.created?.groupId ?? `xl-${parent.taskId}`;
}

/**
 * Делить ли задачами: задача ведущего класса XL, сама не дочерняя (глубина одна), деление на ≥ 2
 * части. Ребёнок XL делится единицами, как L, — иначе цель дробилась бы без конца.
 */
export function splitsIntoTasks(task: LiveTask, unitCount: number): boolean {
  const created = task.state.created;
  if (!created?.lead || created.parentTaskId) return false;
  return task.state.lead?.taskClass?.class === 'XL' && unitCount >= 2;
}

/** Запрос родителя (уже под маской DLP); не прочитан — ребёнок идёт по названию своей части. */
async function parentRequest(task: LiveTask): Promise<string> {
  const read = await readTextFact(join(task.dir, REQUEST_ARTIFACT));
  return 'value' in read ? read.value : '';
}

/**
 * Тело оценки ребёнка: часть деления, база — приколотая база родителя (или `baseSha` — голова
 * зависимости, `child-base.ts`), сценарий — его.
 */
export function childBody(
  parent: LiveTask,
  unit: ProposedUnit,
  cmdId: string,
  parentText = '',
  baseSha?: string,
): EstimateBody {
  const created = parent.state.created;
  if (!created) throw new Error(`task ${parent.taskId} has no task.created`);
  const scenario = parent.state.scenario?.ref ?? created.scenario;
  const owned = unit.ownedPaths.length > 0 ? unit.ownedPaths.join(', ') : '(not named)';
  const deps = unit.deps.length > 0 ? `; after: ${unit.deps.join(', ')}` : '';
  const request =
    `Part "${unit.name}" of the task "${created.title}" (owned paths: ${owned}${deps}).\n\n` +
    parentText;
  return {
    cmdId,
    proof: {},
    fields: {
      title: `${created.title} · ${unit.name}`.slice(0, 300),
      request,
      repos: created.repos
        .filter((r) => r.repoKey === unit.repoKey)
        .map((r) => ({ path: r.path, baseRef: baseSha ?? r.baseRef })),
      scenario: { id: scenario.id, version: scenario.version },
      launchPolicy: 'auto',
      ciWait: created.ciWait,
      ...(created.lang ? { lang: created.lang } : {}),
    },
  };
}

/** Итог создания детей: id, проблемы словами и по имени части — кто создан, кто отказан. */
export interface ChildTasksMade {
  taskIds: string[];
  problems: string[];
  /** Имя части → id её задачи. */
  byName: Record<string, string>;
  /** Имя части → почему оценка её отказала (422). */
  refused: Record<string, string>;
}

/**
 * Создать дочерние задачи по частям деления. `cmdId` ребёнка выводится из `splitId` и места части
 * в ПОЛНОМ упорядоченном списке (повтор запуска после краха находит уже созданного по
 * `origin.cmdId`, второго не создаёт). `only` — имена этой волны (Q-2 s11: часть с зависимостями
 * создаётся, когда её зависимости сданы); нет — все части.
 */
export async function createChildTasks(
  registry: TaskRegistry,
  env: SplitEnv,
  parent: LiveTask,
  splitId: string,
  units: readonly ProposedUnit[],
  only?: readonly string[],
): Promise<ChildTasksMade> {
  const groupId = childGroupOf(parent);
  const lead = parent.state.created?.lead;
  const made: ChildTasksMade = { taskIds: [], problems: [], byName: {}, refused: {} };
  const text = await parentRequest(parent);
  // Ссылка базы ребёнка — ссылка родителя (`origin/main`), не sha: MR ребёнка смотрит в основную
  // ветку; дети прежних волн — чьи головы берут зависимые части (Q-2 s11, `child-base.ts`).
  const facts = parentBaseFacts(parent, XL_CHILDREN_SIGNAL);
  const repos = parent.state.created?.repos ?? [];
  for (const [i, unit] of units.entries()) {
    if (only && !only.includes(unit.name)) continue;
    const repoPath = repos.find((r) => r.repoKey === unit.repoKey)?.path;
    const base = repoPath ? await dependentBaseOf(registry, repoPath, unit, facts.byName) : null;
    if (base && 'refused' in base) {
      made.problems.push(`${unit.name}: ${base.refused}`);
      made.refused[unit.name] = base.refused;
      continue;
    }
    const body = childBody(parent, unit, itemCmdId(splitId, i + 1), text, base?.sha);
    const out = await estimateTask(body, registry, env, {
      pinRef: (repoKey) => facts.pins.get(repoKey),
      created: () => ({
        parentTaskId: parent.taskId,
        groupId,
        ...(lead ? { lead: { profile: lead.profile } } : {}),
      }),
    });
    if (out.status === 422) {
      made.problems.push(`${unit.name}: ${out.problems.join('; ')}`);
      made.refused[unit.name] = out.problems.join('; ');
    } else {
      made.taskIds.push(out.reply.taskId);
      made.byName[unit.name] = out.reply.taskId;
    }
  }
  return made;
}

/** Части первой волны XL: без зависимостей (остальные ждут сданных зависимостей, Q-2 s11). */
export function firstWave(units: readonly ProposedUnit[]): string[] {
  return units.filter((u) => u.deps.length === 0).map((u) => u.name);
}
