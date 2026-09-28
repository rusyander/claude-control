/**
 * Окно, пристёгнутое к правому краю (агент панели), и модальные окна страницы.
 *
 * Пристёгнутое окно не модально: разговор идёт рядом со страницей. Модальное окно
 * Radix в обычном режиме закрывало его затемнением, прятало от скринридера и
 * глушило указатель и фокус — на узком экране ещё и перекрывало половину окна
 * агента, так что черновики тестирования или настройки набора нельзя было
 * смотреть, спрашивая агента. Поэтому модальное окно, открытое при
 * пристёгнутом окне на широком экране, встаёт СЛЕВА от него: страница за ним
 * недоступна (`inert`), а окно агента — живое.
 *
 * Модуль знает только общий договор: ширину отступа (`--panel-agent-dock-inset`,
 * её же читает раскладка страницы) и метку окна. Кто пристёгнут, он не знает.
 */

/** Метка пристёгнутого окна — клик и фокус в нём модальное окно не закрывают. */
export const SIDE_DOCK_SELECTOR = '[data-side-dock]';

/** Переменная, на которую пристёгнутое окно сдвигает страницу; 0 — поверх страницы. */
export const SIDE_DOCK_INSET_VAR = '--panel-agent-dock-inset';

/** Встать рядом с окном можно, только когда оно сдвигает страницу (широкий экран). */
export function isBesideDock(insetValue: string): boolean {
  const inset = Number.parseFloat(insetValue);
  return Number.isFinite(inset) && inset > 0;
}

/** Открыто ли пристёгнутое окно так, что модальному окну есть место слева. */
export function sideDockTakesRoom(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return isBesideDock(getComputedStyle(root).getPropertyValue(SIDE_DOCK_INSET_VAR));
}

/** Узел внутри пристёгнутого окна. */
export function isInSideDock(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SIDE_DOCK_SELECTOR) !== null;
}

/**
 * Escape, нажатый в пристёгнутом окне, пока открыто модальное. Radix слушает
 * Escape на документе в фазе захвата — раньше окна — и закрыл бы модальное окно;
 * модальное уступает событие, помечая его здесь, а окно, увидев метку,
 * закрывается само, хотя событие уже `defaultPrevented`.
 */
const yieldedEscapes = new WeakSet<Event>();

export function yieldEscapeToSideDock(event: Event): void {
  yieldedEscapes.add(event);
  event.preventDefault();
}

export function isEscapeYieldedToSideDock(event: Event): boolean {
  return yieldedEscapes.has(event);
}

/**
 * Сделать страницу недоступной, пока открыто модальное окно рядом с
 * пристёгнутым: вложенные окна держат её вместе, снимает последнее.
 */
let inertHolders = 0;

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

export function holdPageInert(page: HTMLElement | null): () => void {
  if (!page) return () => undefined;
  inertHolders += 1;
  page.inert = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inertHolders -= 1;
    if (inertHolders === 0) page.inert = false;
  };
}
