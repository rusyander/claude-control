import type { ChatMessage } from '@claude-control/contracts';
import { plainTextOf } from './plainTextOf';

/**
 * Какие оптимистичные пузыри ещё нужно показывать.
 *
 * Своя реплика появляется в ленте сразу, до всякого ответа сервера, и живёт до
 * тех пор, пока не приедет транскрипт, в котором она уже есть. Снимать её нужно
 * ровно один раз и наверняка: пузырь, который не сняли, остаётся в ленте
 * навсегда, а следующая отправка добавляет ещё один — именно так лента
 * «переписывала реплики человека вниз» по нескольку раз, хотя в транскрипте
 * никакого дублирования не было.
 *
 * Проверок поэтому две, и вторая существует именно как страховка:
 *
 * 1. По тексту — точная. Работает, пока текст в транскрипте совпадает с тем,
 *    что панель отправила.
 * 2. По времени — грубая. Между пузырём и транскриптом стоит целый CLI со
 *    своими хуками, вложениями и нормализацией, и совпадение текста НЕ
 *    гарантировано. Но если в транскрипте есть запись свежее пузыря, отправка
 *    заведомо дошла: свою реплику CLI пишет в файл раньше всего, что за ней
 *    следует. Значит держать пузырь больше не за чем.
 *
 * Отказ сервера сюда не попадает: там пузырь снимается сразу и по своему id.
 */
export function keepPending(pending: ChatMessage[], history: ChatMessage[]): ChatMessage[] {
  if (pending.length === 0) return pending;

  const texts = new Set(
    history.filter((message) => message.role === 'user').map((message) => plainTextOf(message)),
  );
  const newest = history.reduce(
    (latest, message) => (message.timestamp > latest ? message.timestamp : latest),
    '',
  );

  const kept = pending.filter(
    (message) => !texts.has(plainTextOf(message)) && !(newest !== '' && message.timestamp < newest),
  );

  // Тот же массив, когда снимать нечего: иначе setPending дёргал бы рендер на
  // каждом обновлении транскрипта, а лента при этом прокручивается к низу.
  return kept.length === pending.length ? pending : kept;
}
