/**
 * Родитель XL ждёт своих детей (этап 11, Q-2 s11, P135): чистый суд без ввода-вывода. Части
 * деления с зависимостями запускаются только после того, как сданы части, от которых они зависят
 * (порядок — рёбра деления); родитель не кончается на запуске, а когда кончились все дети. Хоть
 * один ребёнок отказан на создании или кончился не сданным — родитель кончается НЕ зелёным, и
 * причина называет ребёнка и почему. Живой сессии ожидание не держит: исполнитель будит суд по
 * стене раз в `pollMs` (дешевле подписки на журналы детей, которых в этом ядре может и не быть).
 */

/** Исход ребёнка: `task.ended` его журнала; `null` — ещё идёт. */
export type XlChildEnd = 'done' | 'failed' | 'cancelled';

export interface XlChild {
  /** Имя части деления — им же названы зависимости. */
  name: string;
  deps: readonly string[];
  /** Задача ребёнка; `null` — ещё не создана (ждёт зависимости) или отказана. */
  taskId: string | null;
  /** Отказ создания (422 оценки) — текст проблем; `null` — не отказан. */
  refused: string | null;
  ended: XlChildEnd | null;
  /** Почему ребёнок кончился не сданным (причина его конца); `null` — не знаем или сдан. */
  why: string | null;
}

export interface XlChildren {
  children: readonly XlChild[];
  /** Через сколько стены суд смотрит на детей снова. */
  pollMs: number;
}

export type XlParentAction =
  | { kind: 'launch-children'; names: string[] }
  | { kind: 'wait'; reason: string; untilWallMs?: number }
  | { kind: 'finish-task' }
  | { kind: 'fail-task'; reason: string };

/** Неудача ребёнка словами для причины родителя; `null` — ребёнок сдан или ещё может сдаться. */
function failureOf(child: XlChild, byName: ReadonlyMap<string, XlChild>): string | null {
  if (child.refused !== null) return `child ${child.name} refused at creation: ${child.refused}`;
  if (child.ended && child.ended !== 'done') {
    const id = child.taskId ? ` (${child.taskId})` : '';
    return `child ${child.name}${id} ${child.ended}${child.why ? `: ${child.why}` : ''}`;
  }
  if (child.taskId === null) {
    const blocked = child.deps.filter((d) => byName.get(d)?.ended !== 'done');
    return `child ${child.name} never started: its dependencies ${blocked.join(', ')} did not finish done`;
  }
  return null;
}

export function xlParentNext(xl: XlChildren, nowMs: number): XlParentAction {
  const byName = new Map(xl.children.map((c) => [c.name, c]));
  const doneDeps = (c: XlChild): boolean => c.deps.every((d) => byName.get(d)?.ended === 'done');
  const ready = xl.children.filter((c) => c.taskId === null && c.refused === null && doneDeps(c));
  if (ready.length > 0) return { kind: 'launch-children', names: ready.map((c) => c.name) };
  const open = xl.children.filter((c) => c.taskId !== null && c.ended === null);
  if (open.length > 0) {
    return {
      kind: 'wait',
      reason: `XL parent waits for its children: ${open.map((c) => c.name).join(', ')}`,
      untilWallMs: nowMs + xl.pollMs,
    };
  }
  const failed = xl.children.flatMap((c) => failureOf(c, byName) ?? []);
  return failed.length > 0
    ? { kind: 'fail-task', reason: failed.join('; ') }
    : { kind: 'finish-task' };
}
