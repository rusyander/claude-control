import { createHash } from 'node:crypto';

/**
 * Хеши, которыми сверка outbox узнаёт свою запись в форже (G10, P86): тело MR —
 * `sha256(title + "\n" + body)` (заголовок без пометки черновика), заметка — `sha256(body)`.
 * Публикатор пишет тот же хеш в подсказку действия до записи; читатель сравнивает с форжем.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function mrBodyHash(title: string, body: string): string {
  return sha256Hex(`${title}\n${body}`);
}

export function noteHash(body: string): string {
  return sha256Hex(body);
}

/** Пометка черновика GitLab в заголовке: её ставит переходник, а не текст MR. */
export const DRAFT_PREFIX = /^(?:draft:|\[draft\]|\(draft\))\s*/i;

export function stripDraft(title: string): string {
  return title.replace(DRAFT_PREFIX, '');
}
