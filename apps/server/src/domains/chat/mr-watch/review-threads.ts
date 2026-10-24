import type { SplitMrWatch } from '../../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';

/**
 * Ветки ревьюера MR группы: какие ждут её ответа, как их назвать в задании и
 * что о переданном помнит запись наблюдения. Общие для наблюдателя после
 * «готово» (`mr-watch.ts`) и сверки доставки: группа 24.10 простояла в
 * доставке больше суток с четырьмя нерешёнными ветками (три блокера), потому
 * что наблюдатель смотрит только MR групп в `done`, а сверка тредов не читала.
 */

/** Сколько переданных реплик помним: больше — у MR другие беды. */
const MAX_RELAYED = 500;

/** Ключ реплики, на которую группа должна ответить. */
function relayKey(thread: MrReviewThread): string {
  return `${thread.id}:${thread.notes[thread.notes.length - 1]?.id ?? ''}`;
}

/**
 * Ветки, которые ждут группу: нерешённые, последняя реплика — не автора MR и
 * не бота, и её ещё не передавали.
 */
export function pendingThreads(review: MrReview, relayed: readonly string[]): MrReviewThread[] {
  return review.threads.filter((thread) => {
    if (!thread.resolvable || thread.resolved) return false;
    const last = thread.notes[thread.notes.length - 1];
    if (!last || last.bot) return false;
    if (review.author && last.author === review.author) return false;
    return !relayed.includes(relayKey(thread));
  });
}

/**
 * Ссылка на тред — от форджа, если он её дал (GitHub), иначе якорь GitLab.
 * Та же строка уходит в задание группе и в `relayedLinks`: по ней панель
 * сверяет выученное сито с настоящим тредом.
 */
export function threadLink(thread: MrReviewThread, mr: string): string | undefined {
  const last = thread.notes[thread.notes.length - 1];
  if (!last) return undefined;
  return last.url ?? `${mr}#note_${last.id}`;
}

/** Реплика в одну строку: промпт — не место для простыней ревьюера. */
function excerpt(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Ветки ревьюера строками задания: кто, где, ссылка, первая и последняя реплика. */
export function threadLines(threads: readonly MrReviewThread[], mr: string): string[] {
  const lines: string[] = [];
  for (const thread of threads) {
    const first = thread.notes[0];
    const last = thread.notes[thread.notes.length - 1];
    if (!first || !last) continue;
    const where = thread.path ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ''}` : '';
    const reply =
      last !== first ? ` — last reply by ${last.author}: "${excerpt(last.body, 200)}"` : '';
    lines.push(
      `- ${first.author}${where} · ${threadLink(thread, mr)}: "${excerpt(first.body)}"${reply}`,
    );
  }
  return lines;
}

/**
 * Переданные группе ветки — в запись наблюдения: второй раз их не передают, а
 * по ссылкам и файлам панель сверяет выученное из них сито.
 */
export function noteRelayed(
  watch: SplitMrWatch,
  threads: readonly MrReviewThread[],
  mr: string,
): void {
  // Перепроверка шлёт и уже переданное — повтором в памяти оно не встаёт.
  const known = new Set(watch.relayed ?? []);
  const fresh = threads.map(relayKey).filter((key) => !known.has(key));
  watch.relayed = [...(watch.relayed ?? []), ...fresh].slice(-MAX_RELAYED);
  const links = threads.map((thread) => threadLink(thread, mr)).filter(Boolean) as string[];
  if (links.length === 0) return;
  const seen = new Set(watch.relayedLinks ?? []);
  const added = links.filter((link) => !seen.has(link));
  watch.relayedLinks = [...(watch.relayedLinks ?? []), ...added].slice(-MAX_RELAYED);
  // Файл треда — область выученного из него сита: держим только пересланное.
  const paths = { ...watch.relayedPaths };
  for (const thread of threads) {
    const link = threadLink(thread, mr);
    if (link && thread.path) paths[link] = thread.path;
  }
  const kept = new Set(watch.relayedLinks);
  const entries = Object.entries(paths).filter(([link]) => kept.has(link));
  if (entries.length > 0) watch.relayedPaths = Object.fromEntries(entries);
}

/**
 * Что делать с ветками ревьюера — одним текстом для наблюдателя и напоминания
 * доставки: перечитать ВСЕ обсуждения до работы и ещё раз перед новым «готово»
 * (журнал 104b), на каждое — правка или ответ в той же ветке.
 */
export const REVIEW_REPLY_LINES: readonly string[] = [
  'First re-read ALL MR discussions in full, not only the ones listed: new ones may have ' +
    'arrived while you were not working.',
  'For each comment — fix it in the branch and reply in the same discussion thread with what ' +
    'was done, or reply why you do not change it. The reviewer resolves the thread, not you. ' +
    'Write the replies in the language of the discussion.',
];

/**
 * Пробел доставки «ветки ревьюера ждут ответа» — все нерешённые, где последнее
 * слово не за автором MR и не за ботом; переданные раньше тоже: передать — не
 * ответить. `undefined` — ждущих нет.
 */
export function reviewThreadsGap(
  review: MrReview,
  mr: string,
): { line: string; threads: MrReviewThread[] } | undefined {
  const threads = pendingThreads(review, []);
  if (threads.length === 0) return undefined;
  const line = serverText('delivery-gap-review-threads', {
    mr,
    count: String(threads.length),
    threads: threadLines(threads, mr)
      .map((item) => item.slice(2))
      .join(' | '),
  });
  return { line, threads };
}
