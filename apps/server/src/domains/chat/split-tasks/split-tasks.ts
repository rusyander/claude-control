import type { JiraTransition } from '@agentdeck/contracts';
import type {
  SplitTaskOptions,
  SplitTaskOutcome,
  SplitTasksMoved,
} from '@agentdeck/contracts/chat-handoff';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { trackerKeys } from '../tracker-keys.ts';

/**
 * «Перевести задачи» в хабе (G4, владелец 05.10.2026): задачи трекера групп —
 * в выбранный человеком статус. С 06.10 MR не нужен (владелец: кнопку не было
 * видно до MR), а перевод можно сузить «из статуса» — только задачи, что стоят
 * в нём сейчас. Переводит сама панель
 * своим клиентом Jira: нажатие и есть согласие, второго вопроса нет, и чат
 * группы для этого не нужен (он может быть занят или убран).
 *
 * Задачи группы — ключи из её заданий, ветки и названия. Дефекты, которые
 * группа предложила завести (`tickets`), сюда не входят: их не чинили.
 * Кнопка группы — её задачи; кнопка шапки хаба — задачи всех групп плана и
 * планов, которые эти группы разделили сами.
 */

/** Чем панель говорит с трекером задач; в работе — Jira из интеграций. */
export interface SplitTaskTracker {
  /** Интеграция подключена — иначе кнопки нет. */
  connected: () => boolean;
  status: (key: string) => Promise<string>;
  transitions: (key: string) => Promise<JiraTransition[]>;
  apply: (key: string, transitionId: string) => Promise<void>;
}

/** Сколько уровней вложенных разделений собирает кнопка шапки. */
const NESTED_MAX = 3;

/** Задачи одной группы — ключи трекера из её заданий, ветки и названия. */
export function groupTaskKeys(record: SplitPlanRecord, group: SplitPlanGroupRecord): string[] {
  const tasks = record.proposal.groups[group.index]?.tasks ?? [];
  return trackerKeys([...tasks, group.branch, group.title].join('\n'));
}

/**
 * Задачи кнопки: `index` — одной группы; без него — всех групп плана и
 * вложенных планов (группа, чей чат сам разделил работу). Ключ, встреченный
 * дважды, — один раз, с первой группой.
 */
export function splitTaskKeys(
  record: SplitPlanRecord,
  index: number | undefined,
  planOf: (parentChatId: string) => SplitPlanRecord | undefined,
): { key: string; group: string }[] {
  const out: { key: string; group: string }[] = [];
  const add = (plan: SplitPlanRecord, group: SplitPlanGroupRecord): void => {
    for (const key of groupTaskKeys(plan, group)) {
      if (!out.some((item) => item.key === key)) out.push({ key, group: group.title });
    }
  };
  if (index !== undefined) {
    const group = record.groups.find((item) => item.index === index);
    if (group) add(record, group);
    return out;
  }
  const walk = (plan: SplitPlanRecord, depth: number, seen: Set<string>): void => {
    seen.add(plan.parentChatId);
    for (const group of plan.groups) {
      add(plan, group);
      const nested = group.chatId ? planOf(group.chatId) : undefined;
      if (nested && depth < NESTED_MAX && !seen.has(nested.parentChatId)) {
        walk(nested, depth + 1, seen);
      }
    }
  };
  walk(record, 1, new Set());
  return out;
}

const same = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Статус, в который ведёт переход: целевой, а без него — имя самого перехода. */
const target = (transition: JiraTransition): string => transition.to ?? transition.name;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Статусы, в которые можно перевести КАЖДУЮ прочитанную задачу (или она уже в
 * нём). Статус, в котором уже все, не предлагается — переводить нечего.
 */
export async function splitTaskOptions(
  tracker: SplitTaskTracker,
  keys: readonly { key: string; group: string }[],
): Promise<SplitTaskOptions> {
  const read = await Promise.all(
    keys.map(async (item) => {
      try {
        const [status, transitions] = await Promise.all([
          tracker.status(item.key),
          tracker.transitions(item.key),
        ]);
        return { ...item, status, reach: transitions.map(target) };
      } catch (error) {
        return { ...item, reason: reasonOf(error) };
      }
    }),
  );
  const ok = read.filter(
    (item): item is (typeof read)[number] & { status: string; reach: string[] } =>
      'status' in item && item.status !== undefined,
  );
  const candidates: string[] = [];
  for (const item of ok) {
    for (const name of item.reach) {
      if (!candidates.some((known) => same(known, name))) candidates.push(name);
    }
  }
  const statuses = candidates.filter(
    (name) =>
      ok.length > 0 &&
      ok.every((item) => same(item.status, name) || item.reach.some((r) => same(r, name))) &&
      !ok.every((item) => same(item.status, name)),
  );
  // «Из статуса»: по каждому текущему статусу — куда можно перевести КАЖДУЮ
  // задачу, что в нём стоит. Сам статус не предлагается.
  const from: SplitTaskOptions['from'] = [];
  for (const item of ok) {
    if (from.some((entry) => same(entry.status, item.status))) continue;
    const peers = ok.filter((other) => same(other.status, item.status));
    const targets: string[] = [];
    for (const name of item.reach) {
      if (same(name, item.status) || targets.some((known) => same(known, name))) continue;
      if (peers.every((peer) => peer.reach.some((r) => same(r, name)))) targets.push(name);
    }
    from.push({ status: item.status, count: peers.length, targets });
  }
  return {
    from,
    keys: read.map((item) => ({
      key: item.key,
      group: item.group,
      ...('status' in item && item.status ? { status: item.status } : {}),
    })),
    statuses,
    unread: read.flatMap((item) =>
      'reason' in item && item.reason ? [{ key: item.key, reason: item.reason }] : [],
    ),
  };
}

/**
 * Перевести задачи в статус — по одной; провал одной не останавливает остальные.
 * `from` — только задачи, что стоят в нём сейчас; прочие не трогаются
 * (`skipped`, причина — их текущий статус), даже если окно читало их раньше.
 */
export async function moveSplitTasks(
  tracker: SplitTaskTracker,
  keys: readonly string[],
  status: string,
  from?: string,
): Promise<SplitTasksMoved> {
  const items: SplitTasksMoved['items'] = [];
  for (const key of keys) {
    let outcome: SplitTaskOutcome;
    let reason: string | undefined;
    try {
      const current = await tracker.status(key);
      if (from && !same(current, from)) {
        outcome = 'skipped';
        reason = current;
      } else if (same(current, status)) {
        outcome = 'already';
      } else {
        const transition = (await tracker.transitions(key)).find((item) =>
          same(target(item), status),
        );
        if (transition) {
          await tracker.apply(key, transition.id);
          outcome = 'moved';
        } else {
          outcome = 'unavailable';
        }
      }
    } catch (error) {
      outcome = 'failed';
      reason = reasonOf(error);
    }
    items.push({ key, outcome, ...(reason ? { reason } : {}) });
  }
  return { status, ...(from ? { from } : {}), items };
}
