import { DISMISS_KEY } from '../ui/LocalModelHint.constants';

export function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}
