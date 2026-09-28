import type { ActiveRunView } from '@shared/lib/agent-runs';

/**
 * Что показывать в заголовке вкладки и на значке сайта: человека ждёт что-то
 * НОВОЕ — агент спросил, просит права или упал, — а человек, возможно, смотрит
 * в другую программу. Отдельного «списка уведомлений» тут нет намеренно —
 * источник тот же, что и у точек на табах: статус прогона и вопрос в
 * транскрипте.
 *
 * Правило (владелец 28.09 — точка горела ВСЕГДА: четыре брошенных вопроса
 * трёхдневной давности звали при каждом открытии панели):
 * - повод — прогон ждёт ответа или упал, либо разговор стоит на вопросе;
 * - у повода есть ключ, меняющийся вместе с поводом: статус прогона, время
 *   последней записи разговора — новый вопрос того же чата зовёт заново;
 * - повод УВИДЕН, если окно панели было на виду и в фокусе, пока он был (или
 *   его чат открыли); увиденное помнится между перезагрузками;
 * - метка = число неувиденных поводов; нет их — нет ни точки, ни счёта.
 *
 * Сам повод при этом не исчезает: точки в списке чатов и на табах проектов
 * держатся, пока на вопрос не ответят. Гаснет только зов «посмотри сюда».
 */

export type AttentionTone = 'warning' | 'danger';

export interface AttentionView {
  /** Сколько неувиденных поводов зовут человека прямо сейчас. */
  count: number;
  /** Худший повод: упавший агент важнее ждущего. */
  tone?: AttentionTone;
}

/** Один повод позвать человека. */
export interface AttentionReason {
  /** Ключ повода: тот же повод — тот же ключ; новый повод — новый ключ. */
  key: string;
  tone: AttentionTone;
}

/** Разговор на вопросе без живого прогона: id и время последней записи. */
export interface AwaitingMark {
  id: string;
  since: string;
}

/** Прогон зовёт человека, если ждёт ответа или упал; работающий — нет. */
export function callsForAttention(status: ActiveRunView['status']): boolean {
  return status === 'waiting' || status === 'error';
}

/** Префикс ключей одного прогона — по нему забывается его прошлый повод. */
export const runKeyPrefix = (runId: string): string => `run:${runId}:`;

/**
 * Поводы из прогонов вкладки и разговоров, стоящих на вопросе. Разговор, за
 * которым уже числится зовущий прогон, второй раз не считается.
 */
export function attentionReasons(
  runs: readonly ActiveRunView[],
  awaiting: readonly AwaitingMark[] = [],
): AttentionReason[] {
  const calling = runs.filter((run) => callsForAttention(run.status));
  const counted = new Set(calling.flatMap((run) => [run.id, run.sessionId ?? run.id]));
  return [
    ...calling.map((run) => ({
      key: `${runKeyPrefix(run.id)}${run.status}`,
      tone: run.status === 'error' ? ('danger' as const) : ('warning' as const),
    })),
    ...awaiting
      .filter((chat) => !counted.has(chat.id))
      .map((chat) => ({ key: `chat:${chat.id}:${chat.since}`, tone: 'warning' as const })),
  ];
}

/**
 * Прогоны, чей прошлый повод пора забыть: прогон жив и больше не зовёт. Тогда
 * следующее «ждёт» у него — уже новый повод (ключ по статусу совпал бы со
 * старым, увиденным). Отсутствующий прогон не трогаем: до его подхвата после
 * перезагрузки список пуст, и забытое снова звало бы.
 */
export function quietRunIds(runs: readonly ActiveRunView[]): string[] {
  return runs.filter((run) => !callsForAttention(run.status)).map((run) => run.id);
}

/** Свести поводы к метке: считаются только неувиденные. */
export function selectAttention(
  reasons: readonly AttentionReason[],
  seen: ReadonlySet<string>,
): AttentionView {
  const unseen = reasons.filter((reason) => !seen.has(reason.key));
  if (unseen.length === 0) return { count: 0 };
  return {
    count: unseen.length,
    tone: unseen.some((reason) => reason.tone === 'danger') ? 'danger' : 'warning',
  };
}

/** Смотрит ли человек на панель: окно на виду и в фокусе. */
export function isLookingAt(doc: Pick<Document, 'visibilityState' | 'hasFocus'>): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus();
}

/** Заголовок вкладки с меткой: сколько поводов зовут — видно, не переключаясь. */
export function attentionTitle(base: string, count: number): string {
  if (count <= 0) return base;
  return count > 1 ? `● ${count} · ${base}` : `● ${base}`;
}
