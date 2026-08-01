import type { ActiveRunView } from '@shared/lib/agent-runs';

/**
 * Что показывать в заголовке вкладки и на значке сайта: агент где-то ждёт ответа
 * или упал, а человек, возможно, смотрит в другую вкладку. Отдельного «списка
 * уведомлений» тут нет намеренно — источник тот же, что и у точек на табах:
 * статус прогона. Пока агент ждёт, он ждёт; выдумывать этому вторую жизнь в
 * параллельном хранилище значило бы завести два расходящихся источника правды.
 *
 * Гасится не временем, а действием: человек открыл этот чат при активном окне —
 * значит, увидел. Отметка снимается сама, если статус прогона потом изменится
 * (агент снова заработал и снова спросил) — то есть каждый новый повод зовёт
 * заново.
 */

export type AttentionTone = 'warning' | 'danger';

export interface AttentionView {
  /** Сколько прогонов зовут человека прямо сейчас. */
  count: number;
  /** Худший повод: упавший агент важнее ждущего. */
  tone?: AttentionTone;
}

/** Прогон зовёт человека, если ждёт ответа или упал; работающий — нет. */
export function callsForAttention(status: ActiveRunView['status']): boolean {
  return status === 'waiting' || status === 'error';
}

/**
 * Свести активные прогоны к одному сигналу. `dismissed` — карта «прогон → статус,
 * в котором его уже видели»: совпал статус, значит человек этот повод закрыл.
 *
 * `awaiting` — разговоры, где вопрос агента висит без ответа по данным самого
 * транскрипта. Такой повод не гасится показом: пока не ответишь, ждут по
 * -настоящему, а прогона за ним может и не быть — агента могли запустить в
 * терминале, и в память вкладки он не попал.
 */
export function selectAttention(
  runs: ActiveRunView[],
  dismissed: ReadonlyMap<string, string>,
  awaiting: readonly string[] = [],
): AttentionView {
  const calling = runs.filter(
    (run) => callsForAttention(run.status) && dismissed.get(run.id) !== run.status,
  );
  const counted = new Set(calling.flatMap((run) => [run.id, run.sessionId ?? run.id]));
  const extra = awaiting.filter((id) => !counted.has(id));

  const count = calling.length + extra.length;
  if (count === 0) return { count: 0 };
  return {
    count,
    tone: calling.some((run) => run.status === 'error') ? 'danger' : 'warning',
  };
}

/** Заголовок вкладки с меткой: сколько агентов зовут — видно, не переключаясь. */
export function attentionTitle(base: string, count: number): string {
  if (count <= 0) return base;
  return count > 1 ? `● ${count} · ${base}` : `● ${base}`;
}
