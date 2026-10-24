import { LAST_PROJECT_KEY } from './SplitTicketResolve.constants';

/** Последний выбранный проект Jira; хранилище недоступно — пусто. */
export function readLastProject(): string {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeLastProject(key: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, key);
  } catch {
    // Приватный режим или квота: выбор просто не запомнится.
  }
}
