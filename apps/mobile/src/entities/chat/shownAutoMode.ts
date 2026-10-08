import type { ChatAutoModeView } from '@agentdeck/contracts';

/**
 * Что показывает переключатель: выбор, сделанный здесь и ещё не отправленный,
 * иначе то, что решит сервер. Сервер ещё не ответил — «вкл», как у панели из
 * коробки.
 */
export function shownAutoMode(
  chosen: boolean | undefined,
  view: ChatAutoModeView | undefined,
): boolean {
  return chosen ?? view?.enabled ?? true;
}
