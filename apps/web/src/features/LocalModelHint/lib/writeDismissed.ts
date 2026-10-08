import { DISMISS_KEY } from '../ui/LocalModelHint.constants';

export function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Хранилище недоступно (приватное окно) — скрыто до перезагрузки, и только.
  }
}
