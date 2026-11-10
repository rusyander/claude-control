import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { answerKey } from './answers.ts';

/**
 * Вопрос пункта 9 о комментарии назад в тикет (этап 12, P166, W2-D): ключ вопроса и суд «задача
 * не кончается, пока запись решается». Ключ — `tracker-write:<тикет>:<единица>`: по нему подъём не
 * плодит второй открытый вопрос, а отпускание находит MR единицы.
 *
 * Почему конец ждёт: ответ «разрешить» будит и исполнителя, и отпускание записи. Исполнитель без
 * этого суда закончил бы задачу раньше, чем запись легла в журнал, — а после `task.ended` строк нет.
 * Ждёт, пока последний вопрос ключа открыт, и пока «разрешить» без действия `tracker-write` этого
 * тикета: отпускание пишет действие всегда — сделано, отказ или «не записано: причина».
 */

const PREFIX = 'tracker-write:';

export function trackerWriteDedupe(key: string, unitId: string): string {
  return `${PREFIX}${key}:${unitId}`;
}

/** Тикет и единица из ключа; чужой ключ — `null`. Единица — после последнего `:` (в ключе Jira его нет). */
export function parseTrackerWriteDedupe(
  dedupe: string | null,
): { key: string; unitId: string } | null {
  if (!dedupe?.startsWith(PREFIX)) return null;
  const rest = dedupe.slice(PREFIX.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { key: rest.slice(0, cut), unitId: rest.slice(cut + 1) };
}

/** Последний вопрос `tracker-write` на каждый ключ, в порядке журнала. */
export function latestTrackerWriteAsks<A extends { source: string; dedupe: string | null }>(
  asks: Readonly<Record<string, A>>,
): Map<string, A> {
  const latest = new Map<string, A>();
  for (const ask of Object.values(asks)) {
    if (ask.source !== 'tracker-write' || ask.dedupe === null) continue;
    latest.set(ask.dedupe, ask);
  }
  return latest;
}

/** Причина ждать с концом задачи; `null` — записи в трекер ничего не держат. */
export function trackerWriteHold(state: TaskFoldState): string | null {
  for (const [dedupe, ask] of latestTrackerWriteAsks(state.asks)) {
    if (ask.state === 'open') return `tracker write awaits the human (point 9): ${dedupe}`;
    if (ask.state !== 'answered' || answerKey('trackerWrite', ask.answer) !== 'approve') continue;
    const key = parseTrackerWriteDedupe(dedupe)?.key;
    const ran = Object.values(state.actions).some(
      (a) => a.kind === 'tracker-write' && a.target === key,
    );
    if (!ran) return `tracker write approved, not yet run: ${dedupe}`;
  }
  return null;
}
