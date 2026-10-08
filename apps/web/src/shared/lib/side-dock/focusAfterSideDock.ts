import { isInSideDock } from './isInSideDock';

/**
 * Вернуть фокус, закрыв пристёгнутое окно. Кнопка, откуда в него приходят, лежит
 * в странице; пока рядом открыто окно страницы, страница `inert`, фокус на
 * кнопку не встаёт и падает на body (ревью Z5-12) — тогда ведём его в это окно.
 */
export function focusAfterSideDock(trigger: HTMLElement | null): void {
  if (trigger && !trigger.closest('[inert]')) {
    trigger.focus();
    return;
  }
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
    (dialog) => !isInSideDock(dialog) && !dialog.closest('[inert]'),
  );
  dialogs.at(-1)?.focus();
}
