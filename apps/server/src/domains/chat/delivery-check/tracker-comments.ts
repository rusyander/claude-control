import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { run } from '../../project-git/sieve-facts/sieve-facts.ts';
import { trackerKeys } from '../tracker-keys.ts';

/**
 * Задачи трекера в доставке группы (split d9869abf, аудит g3 R7 и g8 F4):
 *
 * - СДЕЛАННЫЕ — те ключи группы, что названы в коммитах ветки. Задачу, которой нет
 *   ни в одном коммите, группа пропустила («1394 skipped»): переводить её в Review и
 *   писать в неё «сделано» нельзя — g8 перевела чужую закрытую задачу по списку всех
 *   ключей группы. Коммиты не называют ни одного ключа — различить нечем, сделанными
 *   считаются все;
 * - КОММЕНТАРИЙ — в каждой сделанной задаче комментарий со ссылкой на MR: что
 *   сделано и как проверить. g3 перевела четыре задачи и не оставила ни одного
 *   комментария, а пункт владельца о нём сдала «pass» по статусу задач.
 */

/** Чем проверка читает трекер: тексты комментариев задачи. */
export interface DeliveryTracker {
  /** Ключи задач группы — из её заданий, ветки и названия. */
  keys: readonly string[];
  /** Тексты комментариев задачи; бросает — трекер не ответил. */
  comments: (key: string) => Promise<readonly string[]>;
}

/** Ключи группы, названные в сообщениях коммитов `base..HEAD`; не назван ни один — все. */
async function deliveredTickets(
  cwd: string,
  base: string | undefined,
  keys: readonly string[],
): Promise<{ delivered: string[]; skipped: string[] }> {
  const all = { delivered: [...keys], skipped: [] as string[] };
  if (!base || keys.length === 0) return all;
  const log = await run(cwd, ['log', '--format=%B', `${base}..HEAD`]);
  if (log.code !== 0) return all;
  const named = new Set(trackerKeys(log.stdout));
  const delivered = keys.filter((key) => named.has(key));
  if (delivered.length === 0) return all;
  return { delivered, skipped: keys.filter((key) => !named.has(key)) };
}

/**
 * Комментарий ссылается на MR: адресом (без схемы и хвостового «/») или номером
 * формы форджа — «!1050» у GitLab, «#1050» у GitHub, «MR 1050». Вики-разметка
 * Jira Server экранирует знаки адреса («merge\_requests») — экранирование снимается.
 */
export function mentionsMr(text: string, mr: string): boolean {
  const body = text.replace(/\\(?=[^\p{L}\p{N}\s])/gu, '');
  const bare = mr.replace(/^https?:\/\//u, '').replace(/\/+$/u, '');
  // Адрес — целиком: «…/merge_requests/11010» — не ссылка на MR 1101.
  const address = bare.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (new RegExp(`${address}(?!\\d)`, 'u').test(body)) return true;
  const number = /(?:merge_requests|pull)\/(\d+)$/u.exec(bare)?.[1];
  if (!number) return false;
  const mark = bare.includes('/pull/') ? '#' : '!';
  return new RegExp(`(?:${mark}|\\bMR\\s*!?|\\bPR\\s*#?)${number}(?!\\d)`, 'u').test(body);
}

/** Пробелы и заметки задач трекера у найденного MR. */
export async function trackerDeliveryGaps(input: {
  cwd: string;
  base: string | undefined;
  mr: string;
  tracker: DeliveryTracker;
}): Promise<{ missing: string[]; notes: string[] }> {
  const { delivered, skipped } = await deliveredTickets(input.cwd, input.base, input.tracker.keys);
  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(serverText('delivery-note-tickets-skipped', { keys: skipped.join(', ') }));
  }
  const uncommented: string[] = [];
  const unread: string[] = [];
  for (const key of delivered) {
    try {
      const bodies = await input.tracker.comments(key);
      if (!bodies.some((body) => mentionsMr(body, input.mr))) uncommented.push(key);
    } catch {
      unread.push(key);
    }
  }
  if (unread.length > 0) {
    notes.push(serverText('delivery-note-tracker-unread', { keys: unread.join(', ') }));
  }
  const missing =
    uncommented.length > 0
      ? [serverText('delivery-gap-tracker-comment', { keys: uncommented.join(', '), mr: input.mr })]
      : [];
  return { missing, notes };
}
