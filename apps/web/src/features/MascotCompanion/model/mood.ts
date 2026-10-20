import type { MascotMood } from '@shared/ui/mascot';
import type { MoodInput, StatusLine } from './mood.types';

/**
 * Настроение Деки в боковой панели. Порядок — по тому, что человеку важнее
 * увидеть краем глаза:
 *
 *   1. кто-то ждёт ответа — работа стоит, пока не ответишь;
 *   2. короткая вспышка (радость от готового хода, головокружение) — пару секунд;
 *   3. ошибка у агента;
 *   4. мимика реплики (совет — раздумье, приветствие — взмах);
 *   5. агенты работают;
 *   6. человек давно не трогал панель — дремлет;
 *   7. покой.
 */
export function resolveMood(input: MoodInput): MascotMood {
  if (input.waiting > 0) return 'waiting';
  if (input.flash && input.flash.until > input.now) return input.flash.mood;
  if (input.errors > 0) return 'error';
  if (input.speechMood) return input.speechMood;
  if (input.running > 0) return 'working';
  if (input.asleep) return 'sleeping';
  return 'idle';
}

/**
 * Строка состояния под именем и в подписи кнопки: самое важное одно — как
 * у настроения, без вспышек и реплик.
 */
export function statusLine(
  input: Pick<MoodInput, 'waiting' | 'errors' | 'running' | 'asleep'>,
): StatusLine {
  if (input.waiting > 0) return { key: 'waiting', count: input.waiting };
  if (input.errors > 0) return { key: 'error', count: input.errors };
  if (input.running > 0) return { key: 'working', count: input.running };
  return { key: input.asleep ? 'sleeping' : 'idle' };
}
