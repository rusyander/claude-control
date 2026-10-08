import type { TelegramEvent } from '@agentdeck/contracts';

/** Переключение одного события подписки с сохранением известного порядка. */
export function toggleEvent(
  events: readonly TelegramEvent[],
  all: readonly TelegramEvent[],
  event: TelegramEvent,
): TelegramEvent[] {
  const next = events.includes(event)
    ? events.filter((item) => item !== event)
    : [...events, event];
  return all.filter((item) => next.includes(item));
}
