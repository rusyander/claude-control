import { z } from 'zod';
import { FROM_HUMAN_LINE, PLATFORM_MARKER } from './user-layer.ts';

/**
 * Вид сеанса для показа (этап 10): `GET /v1/tasks/:id/sessions/:sid/stream?from=<смещение>` —
 * повтор журнала stdout хоста сеанса через нормализатор САМОГО переходника. Текст разговора в
 * журнал задачи не попадает (01): вид читается с диска сеанса, один рисовальщик на любой CLI.
 *
 * `offset` — байтовое смещение строки в `stdout.log` (курсор продолжения); строка хода человека
 * (`user-text`) стоит на смещении, с которого ядро ждало её хода (`core-io.jsonl`).
 */

export const SESSION_STREAM_KINDS = [
  'user-text',
  'assistant-text',
  'thinking',
  'tool-call',
  'tool-result',
  'permission',
  'usage',
  'window',
  'turn-end',
  'error',
] as const;
export type SessionStreamKind = (typeof SESSION_STREAM_KINDS)[number];

/**
 * Статус окна в словаре Claude Code (`rate_limit_info.status`): на эти строки смотрят исход
 * цепочки, карточка лимита чата и лента панели — другое имя они бы не узнали. Повтор после лимита
 * ведёт ядро (этап 12, P171), не панель.
 */
export const SESSION_WINDOW_STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const;

/**
 * Данные вида `window` — окно подписки, как его назвал CLI (переходник `readWindow`): доля самого
 * тесного окна 0..100, сброс (мс эпохи; `null` — источник не назвал), статус, имя окна и замер
 * каждого окна с долей. Панель строит из него событие `limit` ленты и замер доли лимита.
 */
export const sessionWindowDataSchema = z.strictObject({
  limitKind: z.enum(['window', 'rate', 'budget', 'slot']),
  usedPct: z.number().min(0).nullable(),
  resetAt: z.number().nonnegative().nullable(),
  status: z.enum(SESSION_WINDOW_STATUSES),
  window: z.string().min(1).nullable(),
  windows: z
    .record(
      z.string().min(1),
      z.strictObject({
        usedPct: z.number().min(0),
        resetAt: z.number().nonnegative().nullable(),
      }),
    )
    .optional(),
});
export type SessionWindowData = z.infer<typeof sessionWindowDataSchema>;

/**
 * Стена отправки хода человека (`user-text`): `data.sentAt`, мс эпохи, из записи ввода ядра
 * (`core-io.jsonl` `wall`, этап 11, волна 3). Вид времени строк не несёт; по этой стене история
 * чата не-Claude CLI ставит время хода и его ответа. Запись без стены (прежняя) — `undefined`.
 */
export function sentAtOf(event: Pick<SessionStreamEvent, 'kind' | 'data'>): number | undefined {
  if (event.kind !== 'user-text') return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const at = (data as { sentAt?: unknown }).sentAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

export const sessionStreamEventSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  kind: z.enum(SESSION_STREAM_KINDS),
  /** Данные для показа по виду; текст команды — только показ (03 `mapPermission`), не решение. */
  data: z.json(),
});
export type SessionStreamEvent = z.infer<typeof sessionStreamEventSchema>;

export const sessionStreamPageSchema = z.strictObject({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Переходник, чей нормализатор читал поток (`session.started.adapter`). */
  adapter: z.string().min(1),
  events: z.array(sessionStreamEventSchema),
  /** Смещение для следующего запроса `?from=`: конец последней целой строки. */
  next: z.number().int().nonnegative(),
  /** Сеанс кончился (строка конца в журнале задачи) и журнал прочитан до конца. */
  done: z.boolean(),
});
export type SessionStreamPage = z.infer<typeof sessionStreamPageSchema>;

/** Причины отказа ручки вида: имя каждой — в ответе `apiError`. */
export const SESSION_STREAM_REFUSALS = [
  'unknown-session',
  'no-normaliser',
  'stream-unreadable',
] as const;
export type SessionStreamRefusal = (typeof SESSION_STREAM_REFUSALS)[number];

/**
 * Ключ события вида для отсева повторов: `смещение:вид:порядковый` среди событий с тем же
 * смещением и видом. Ход человека, ушедший после последней целой строки, стоит на смещении
 * курсора `next` — следующая страница с `?from=next` отдаёт его ещё раз; ключ у повтора тот же,
 * и показ (панель, ядро в потоке) его отсеивает. Одна строка вывода даёт события в одном порядке
 * при любом повторе — порядковый номер устойчив.
 */
export function sessionEventKeys(events: readonly SessionStreamEvent[]): string[] {
  const seen = new Map<string, number>();
  return events.map((e) => {
    const base = `${e.offset}:${e.kind}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}:${n}`;
  });
}

/** Поток вида (`Accept: text/event-stream`): кадр `page` на каждую новую порцию, `id` — курсор `next`. */
export const SESSION_STREAM_SSE_EVENT = 'page';

/**
 * Метка слова человека: ядро ставит её первой строкой доставки (`message-to-step`, ответ на
 * вопрос), модель отличает по ней человека от вывода инструмента. Показ чата снимает строку
 * метки — человек видит своё сообщение, а не служебный заголовок. Одна строка на обе стороны.
 */
export const HUMAN_ORIGIN_MARK = '[agentdeck · human-origin]';

/**
 * Текст хода человека без служебной шапки. Переходник метит КАЖДУЮ отправку в сеанс (`markText`):
 * метка платформы, у слов человека ещё строка `agentdeck-from: human`, а доставка сверху кладёт
 * строку метки человека. Снимаются только эти строки, по одной и в этом порядке: слова человека,
 * начинающиеся с чего-то похожего на метку, остаются как есть.
 */
export function humanTextOf(text: string): string {
  let rest = text;
  const take = (isHead: (line: string) => boolean): void => {
    const nl = rest.indexOf('\n');
    const head = nl < 0 ? rest : rest.slice(0, nl);
    if (isHead(head)) rest = nl < 0 ? '' : rest.slice(nl + 1);
  };
  take((line) => line === PLATFORM_MARKER);
  take((line) => line === FROM_HUMAN_LINE);
  take((line) => line.startsWith(HUMAN_ORIGIN_MARK));
  return rest;
}
