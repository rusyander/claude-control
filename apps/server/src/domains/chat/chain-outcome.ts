import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { ChainOutcome } from './split-conveyor.ts';

/**
 * Что конец хода значит для группы разделения (Д3, инцидент 23.09.2026).
 *
 * До этого любой завершённый ход закрывал группу: `done` получали и ход,
 * кончившийся вопросом, и ход, после которого фоновая установка шла дальше, и
 * ревью, по которому человек ещё не решил. Хаб писал «готово», группы с `after`
 * стартовали от недоделанной ветки, и в родителе это выглядело как «всё
 * выполнено». Здесь — одно правило на Claude и на чужие CLI: «готово» только
 * явный итог.
 */

/** Сколько знаков хвоста ответа уезжает в строку группы хаба. */
const TAIL_MAX = 280;

/** Текст без блоков кода: вопрос в них — не вопрос человеку. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, '').trim();
}

/**
 * Ход кончился вопросом человеку, заданным ТЕКСТОМ (Д16: хаб такие не видел).
 *
 * Смотрим последний абзац: вопросительный знак в конце одной из его строк
 * (с кавычкой или скобкой после него) — это вопрос, которого агент ждёт.
 * Вопрос в середине ответа, на который он сам и ответил, сюда не попадает.
 */
export function endsWithQuestion(text: string): boolean {
  const body = prose(text);
  if (!body) return false;
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? '';
  return last
    .split('\n')
    .map((line) => line.trim())
    .some((line) => /\?[\s»"')\]*_]*$/.test(line));
}

/** Хвост последнего абзаца ответа — одной строкой. */
export function replyTail(text: string): string | undefined {
  const body = prose(text);
  if (!body) return undefined;
  const last = (body.split(/\n\s*\n/).at(-1) ?? '').replace(/\s+/g, ' ').trim();
  if (!last) return undefined;
  return last.length > TAIL_MAX ? `…${last.slice(last.length - TAIL_MAX + 1)}` : last;
}

/**
 * Ссылка на MR/PR, последняя в ответе: GitLab `/-/merge_requests/N`, GitHub
 * `/pull/N`. Группа с доставкой кончает ответ ссылкой на свой MR — по ней хаб
 * ведёт прямо в него, а не в чат группы.
 */
export function lastMergeRequestUrl(text: string): string | undefined {
  const found = text.match(/https?:\/\/[^\s<>()[\]'"`]+?\/(?:-\/merge_requests|pull)\/\d+/g);
  return found?.at(-1);
}

export interface ChainOutcomeInput {
  /** Связь закончившегося звена — ПОСЛЕ того, как ревью по ссылке записало итог. */
  link: ChatLink;
  ok: boolean;
  text: string;
  /** Фоновая команда агента ещё идёт (`LiveSession.hasBackgroundWork`). */
  background?: boolean;
  /** Ход звал `AskUserQuestion` — вопрос висит карточкой (`RunFinished.asked`). */
  asked?: boolean;
  /** Правки в копии есть — по git, не по словам агента (Д5). */
  hasWork?: () => boolean;
  /** Текст ошибки упавшего хода — в строку группы. */
  error?: string;
  /** Решение надзора повторов (Д10): повтор назначен или попытки кончились. */
  retry?: { attempt: number; at: number } | { exhausted: number };
}

/**
 * Итог хода для группы. Порядок проверок — от самого надёжного факта: сбой,
 * фон, ревью (его итог в связи), вопрос текстом, и только потом «готово».
 */
export function chainOutcomeOf(input: ChainOutcomeInput): ChainOutcome {
  const { link, ok, text } = input;
  const tail = replyTail(text);
  const mr = lastMergeRequestUrl(text);
  const withTail = { ...(tail ? { tail } : {}), ...(mr ? { mr } : {}) };
  if (!ok) {
    // Повтор назначен — группа не сдалась, она ждёт (Д10): ждавшие её не
    // стартуют от недоделанной ветки.
    if (input.retry && 'attempt' in input.retry) {
      return { status: 'awaiting', waitingFor: 'retry', retries: input.retry.attempt, ...withTail };
    }
    // Число повторов едет отдельным полем, а не хвостом текста ошибки: хаб
    // пишет его на языке интерфейса, и в тексте оно стояло бы дважды.
    const tried = input.retry && 'exhausted' in input.retry ? input.retry.exhausted : 0;
    return {
      status: 'failed',
      ...(input.error ? { error: input.error } : {}),
      ...(tried ? { retries: tried } : {}),
      ...withTail,
    };
  }
  if (input.background) return { status: 'background', waitingFor: 'background', ...withTail };

  const review = link.review;
  if (review) {
    if (review.missing) return { status: 'awaiting', waitingFor: 'review-missing', ...withTail };
    // Замечания есть, решения нет — ждёт человека, а не «готово».
    if ((review.findings ?? []).length > 0 && !review.decidedAt) {
      return { status: 'awaiting', waitingFor: 'decision', ...withTail };
    }
    // Правки сделаны, push предложен и не отдан — снова решение человека.
    if (review.pushOffer && !review.pushedAt) {
      return {
        status: 'awaiting',
        waitingFor: 'decision',
        result: { kind: 'changed' },
        ...withTail,
      };
    }
  }

  // Вопрос инструментом — главный путь (Д16), вопрос текстом — запасной.
  if (input.asked || endsWithQuestion(text)) {
    return { status: 'awaiting', waitingFor: 'question', ...withTail };
  }

  // Итог словами фактов: ревью без правок — «проверено», а не «сделано».
  if (review?.pushedAt) return { status: 'done', result: { kind: 'pushed' }, ...withTail };
  if (review && link.stage === 'review') {
    return { status: 'done', result: { kind: 'reviewed' }, ...withTail };
  }
  // Ревью конвейера (своя работа) без блока группу НЕ держит: работа уже
  // сделана, а проверка — усиление, и ждавшие группы из-за неё стоять не должны.
  // Итог по фактам копии: что изменилось, то и сделано.
  const changed = input.hasWork?.();
  return {
    status: 'done',
    ...(changed === undefined ? {} : { result: { kind: changed ? 'changed' : 'unchanged' } }),
    ...withTail,
  };
}
