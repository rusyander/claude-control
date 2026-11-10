import type {
  EstimateBody,
  EstimateFields,
  EstimateReply,
} from '@agentdeck/contracts/core/estimate';
import type { IntakeSource } from '@agentdeck/contracts/core/intake';
import { estimateTask } from '../estimate/index.ts';
import type { CreateSeed, EstimateOutcome, SplitEnv } from '../estimate/estimate.types.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { LeadEstimate } from './estimate-seed.ts';
import { itemCmdId } from './item-id.ts';

/**
 * Группа = тот же алгоритм (этап 11, D18, W3-18): `sources` из пунктов группы панели
 * (`kind: 'group-item'`) — N задач, по задаче на пункт, у каждой один источник и общий `groupId`.
 * Каждая идёт тем же путём оценки, что одиночная (приём, предпроверка, класс, деление); места
 * сеансов между ними делит распределитель, а не группа. Список трекера или текста — одна задача
 * (несколько тикетов одной цели, класс считает пункты): группой его делает только вид пункта.
 */

/** Префикс `groupId` группы оценки: id выводится из `cmdId`, повтор оценки называет ту же группу. */
export const GROUP_ID_PREFIX = 'group-';

export const GROUP_MIXED_PROBLEM =
  'sources: group items and other sources in one estimate — send the group items alone, or the other sources as one task';

/** Пункты группы, если оценка — группа: `sources`, где каждый пункт `group-item`; иначе `null`. */
export function groupItemsOf(fields: Pick<EstimateFields, 'sources'>): IntakeSource[] | null {
  const items = fields.sources ?? [];
  if (!items.some((s) => s.kind === 'group-item')) return null;
  return items.every((s) => s.kind === 'group-item') ? [...items] : null;
}

/** Смесь пунктов группы с другими источниками — отказ с причиной (задач нет). */
export function groupMixProblem(fields: Pick<EstimateFields, 'sources'>): string | null {
  const items = fields.sources ?? [];
  const some = items.some((s) => s.kind === 'group-item');
  return some && !items.every((s) => s.kind === 'group-item') ? GROUP_MIXED_PROBLEM : null;
}

export function groupIdOf(cmdId: string): string {
  return `${GROUP_ID_PREFIX}${cmdId}`;
}

export { itemCmdId };

/** Тело оценки пункта: один источник, запрос — тело пункта, заголовок — его заголовок. */
export function itemBody(body: EstimateBody, item: IntakeSource, index: number): EstimateBody {
  const { sources: _sources, source: _source, ...rest } = body.fields;
  const label = item.title ?? item.key ?? `#${index + 1}`;
  const request = item.body.trim().length > 0 ? item.body : (item.title ?? body.fields.request);
  return {
    ...body,
    cmdId: itemCmdId(body.cmdId, index),
    fields: {
      ...rest,
      title: item.title ?? `${body.fields.title} · ${label}`.slice(0, 300),
      request,
      source: item,
    },
  };
}

/** Посев задачи группы: `groupId` в `task.created` поверх посева приёма. */
export function seedWithGroup(seed: CreateSeed, groupId: string): CreateSeed {
  return { ...seed, created: (pinned) => ({ ...seed.created?.(pinned), groupId }) };
}

/**
 * Пункт группы: задача с её `groupId`, сама не дочерняя. Дети XL наследуют группу родителя
 * (`childGroupOf`), но пунктами не являются — посчитай их, и группа, оборванная после XL-задачи 0
 * с запущенными детьми, сошла бы за полную (ревью F-06), а панель запускала бы детей как пункты.
 */
export function isGroupItem(
  task: { groupId?: string; parentTaskId?: string },
  groupId: string,
): boolean {
  return task.groupId === groupId && !task.parentTaskId;
}

/** Задачи-пункты группы по порядку создания (UUIDv7 растёт со временем). */
export function tasksOfGroup(registry: TaskRegistry, groupId: string): string[] {
  return registry
    .list()
    .filter((s) => isGroupItem(s, groupId))
    .map((s) => s.taskId)
    .sort();
}

/** Блок `group` ответа оценки по задаче: нет `groupId` в `task.created` — нет блока. */
export function groupReplyOf(
  registry: TaskRegistry,
  taskId: string,
): EstimateReply['group'] | undefined {
  const groupId = registry.view(taskId)?.created?.groupId;
  return groupId ? { groupId, taskIds: tasksOfGroup(registry, groupId) } : undefined;
}

/**
 * Группа оборвана между задачами (крах после задачи 0): пунктов в теле повтора больше, чем задач
 * группы. Такой повтор не отвечает готовым — он идёт путём оценки группы и досоздаёт недостающие
 * (у пункта свой `cmdId`: созданные отвечают повтором, второй задачи не будет). Не группа или
 * группа полна — `false`, повтор отвечает как был.
 */
export function groupIncomplete(
  registry: TaskRegistry,
  fields: Pick<EstimateFields, 'sources'>,
  cmdId: string,
  taskId: string,
): boolean {
  const items = groupItemsOf(fields);
  if (!items) return false;
  const groupId = registry.view(taskId)?.created?.groupId;
  if (groupId !== groupIdOf(cmdId)) return false;
  return tasksOfGroup(registry, groupId).length < items.length;
}

export type GroupOutcome = EstimateOutcome;

/**
 * Оценка группы: приём каждого пункта ДО первой задачи (отказ любого — 422, задач нет), затем
 * пункты по порядку тем же `estimateTask`. Задача 0 не создалась — 422 с её причинами; позже —
 * ответ задачи 0 с причинами пропавших пунктов (задачи созданы, их не откатить). `decorate` —
 * посев поверх приёма каждого пункта (запись доски, этап 12): у не-ведущего пункта посева приёма нет,
 * и без него старт с доски терял бы `boardEntry` задач группы.
 */
export async function estimateGroup(
  body: EstimateBody,
  registry: TaskRegistry,
  env: SplitEnv,
  leadOf: (fields: EstimateFields) => LeadEstimate,
  decorate: (seed: CreateSeed) => CreateSeed = (seed) => seed,
): Promise<GroupOutcome> {
  const items = groupItemsOf(body.fields) ?? [];
  const groupId = groupIdOf(body.cmdId);
  const bodies = items.map((item, i) => itemBody(body, item, i));
  const leads: LeadEstimate[] = bodies.map((b) => leadOf(b.fields));
  const refused = leads.flatMap((l, i) =>
    l.kind === 'refused' ? [`item ${items[i]?.key ?? i + 1}: ${l.problem}`] : [],
  );
  if (refused.length > 0) return { status: 422, problems: refused };
  const outcomes: EstimateOutcome[] = [];
  for (const [i, b] of bodies.entries()) {
    const lead = leads[i] as LeadEstimate;
    const seed = seedWithGroup(decorate(lead.kind === 'lead' ? lead.seed : {}), groupId);
    const out = await estimateTask(b, registry, env, seed);
    if (i === 0 && out.status === 422) return out;
    outcomes.push(out);
  }
  const first = outcomes[0] as Exclude<EstimateOutcome, { status: 422 }>;
  const lost = outcomes.flatMap((o, i) =>
    o.status === 422 ? o.problems.map((p) => `item ${items[i]?.key ?? i + 1}: ${p}`) : [],
  );
  return {
    status: first.status,
    reply: {
      ...first.reply,
      problems: [...first.reply.problems, ...lost],
      group: { groupId, taskIds: tasksOfGroup(registry, groupId) },
    },
  };
}
