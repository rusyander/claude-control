import type { SendOrigin } from '@agentdeck/contracts/core/user-layer';
import type { LiveTask } from '../../journal/resume.ts';
import { chatOpeningOf } from '../estimate/placement.ts';
import { lastHumanWord } from '../human/deliver.ts';
import { readHumanLedger } from '../human/ledger.ts';

/**
 * Новая сессия шага чата после снятия (этап 12, L3): окно подписки отказало, ядро сняло сессию
 * в конце хода и на сбросе открыло новую. Первое слово чата (`request.md`) модель уже видела —
 * слать его снова значит задать старый вопрос второй раз, а слово, на которое окно не дало
 * ответа, потерять. Правило:
 *  - прошлый ход кончился ошибкой (или исполнитель этого не знает — ядро перезапускалось) —
 *    последнее слово человека ещё раз, ровно один раз: последнее доставленное сообщение, а без
 *    сообщений — первое слово;
 *  - прошлый ход кончился ответом — ничего: сессия стоит в конце хода и ждёт человека.
 * Лишний повтор после перезапуска ядра дешевле потерянного слова человека.
 */

/** Как кончился последний ход шага в этом исполнителе; нет записи — не знаем. */
export type LastTurn = 'answered' | 'failed';

export interface Reopening {
  text: string;
  origin: SendOrigin;
}

/** Была ли у шага сессия до этой: тогда это продолжение чата, а не его начало. */
export function chatReopened(task: LiveTask, stepId: string, sessionId: string): boolean {
  return Object.entries(task.state.sessions).some(
    ([id, rec]) => id !== sessionId && rec.stepId === stepId,
  );
}

/** Слово новой сессии продолжения чата; `null` — слать нечего, сессия ждёт человека. */
export function chatReopening(
  task: LiveTask,
  stepId: string,
  last: LastTurn | undefined,
): Reopening | null {
  if (last === 'answered') return null;
  const word = lastHumanWord(readHumanLedger(task), stepId);
  if (word) return { text: word.text, origin: 'human' };
  const first = chatOpeningOf(task);
  return first ? { text: first, origin: 'platform' } : null;
}
