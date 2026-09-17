const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex]';

/**
 * Потолок ожидания якоря. Ленивая страница рисует разметку после загрузки
 * модуля и ответа API; на медленном диске или большом репозитории это секунды,
 * а не доли секунды. Дольше ждать не стоит: человек за это время уже сам
 * куда-то нажал, и прыжок фокуса стал бы помехой.
 */
export const ANCHOR_TIMEOUT_MS = 10_000;

/** Разметка окна и кнопки агента — по ним политика фокуса отличает «своё» от страницы. */
export const WINDOW_SELECTOR = '[data-panel-agent-window]';
export const TRIGGER_SELECTOR = '[data-panel-agent-trigger]';

/**
 * Фокус никто не держит: он на теле страницы, в самом окне агента или на его
 * кнопке. Во всех прочих случаях человек работает на странице, и окно, стоящее
 * рядом, не имеет права уводить у него фокус.
 */
export function isFocusFree(active: Element | null = document.activeElement): boolean {
  if (!active || active === document.body) return true;
  return Boolean(active.closest(WINDOW_SELECTOR) ?? active.closest(TRIGGER_SELECTOR));
}

/**
 * Сколько после последнего нажатия клавиши человек считается печатающим.
 * Ревью B1: карточка, пришедшая посреди фразы, забирала фокус на «Выполнить», и
 * следующий пробел из текста одобрял правку. Две секунды — пауза между словами
 * и фразами при обычном наборе; дольше человек уже смотрит на экран.
 */
export const TYPING_GRACE_MS = 2_000;

/** Кнопки решения глухи столько после появления карточки: палец уже летел. */
export const DECISION_ARM_MS = 500;

/** Клавиши, которые не набор текста: ими ходят по панели, а не пишут. */
const NAVIGATION_KEYS = new Set(['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

let lastTypedAt = Number.NEGATIVE_INFINITY;

/** Отметить нажатие клавиши (слушатель документа ставит окно агента). */
export function noteKeystroke(key: string, now: number = Date.now()): void {
  if (NAVIGATION_KEYS.has(key)) return;
  lastTypedAt = now;
}

/** Слушать клавиатуру всего документа; возвращает отписку. */
export function watchTyping(target: Document = document): () => void {
  const onKeyDown = (event: KeyboardEvent): void => noteKeystroke(event.key);
  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}

/** Человек нажимал клавишу меньше `TYPING_GRACE_MS` назад. */
export function typedRecently(now: number = Date.now()): boolean {
  return now - lastTypedAt < TYPING_GRACE_MS;
}

/** Для тестов: забыть последнее нажатие. */
export function resetTyping(): void {
  lastTypedAt = Number.NEGATIVE_INFINITY;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** В элемент печатают: поле, многострочное поле, редактируемый узел, textbox. */
export function isEditable(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type);
  if ((element as HTMLElement).isContentEditable) return true;
  const role = element.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

/**
 * Можно ли забрать фокус без спроса — для карточки и для якоря open_page. Нельзя,
 * пока человек печатает: фокус в любом поле ввода (в окне агента тоже — поле
 * агента не «своё» для этого правила) или клавиша нажата меньше
 * `TYPING_GRACE_MS` назад. Сверх того фокус должен быть свободен: не на
 * странице. Вместо фокуса человеку говорят счётчиком и живой областью.
 */
export function canTakeFocus(
  active: Element | null = document.activeElement,
  now: number = Date.now(),
): boolean {
  if (typedRecently(now)) return false;
  if (isEditable(active)) return false;
  return isFocusFree(active);
}

/** Куда ставить фокус в окне: кнопка по умолчанию ждущей карточки, иначе поле ввода. */
export function focusWindow(panel: HTMLElement): void {
  const target =
    panel.querySelector<HTMLElement>('[data-agent-default]') ??
    panel.querySelector<HTMLElement>('[data-agent-input]') ??
    panel;
  target.focus();
}

/**
 * Найти якорь на открытой агентом странице. Сначала `id`, потом
 * `data-agent-anchor`: у полей форм id бывает сгенерированным, и странице
 * проще пометить нужное место явно.
 */
export function findAnchor(root: ParentNode, focus: string): HTMLElement | null {
  const byId = (root as Document).getElementById?.(focus) ?? null;
  if (byId) return byId;
  const escaped = focus.replace(/["\\]/g, '\\$&');
  return root.querySelector<HTMLElement>(`[data-agent-anchor="${escaped}"]`);
}

export interface AnchorWatch<T> {
  /** Найти якорь сейчас; нет — `null`. */
  find: () => T | null;
  /** Подписаться на изменения разметки; возвращает отписку. */
  subscribe: (onChange: () => void) => () => void;
  /** Якорь найден: вызывается ровно один раз и только если ожидание не снято. */
  onFound: (anchor: T) => void;
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Ждать появления якоря: на каждое изменение разметки, а не опросом по
 * таймеру — страница может дорисоваться и через 50 мс, и через 8 с. Возвращает
 * отмену: следующий переход (агента или человека) снимает прежнее ожидание,
 * иначе фокус прыгнул бы в поле страницы, с которой человек уже ушёл.
 */
export function watchForAnchor<T>({
  find,
  subscribe,
  onFound,
  timeoutMs = ANCHOR_TIMEOUT_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: AnchorWatch<T>): () => void {
  let done = false;
  // Отписка и таймер появляются после первой попытки, а отмена нужна раньше.
  const handles: { unsubscribe?: () => void; timer?: unknown } = {};
  const cancel = (): void => {
    if (done) return;
    done = true;
    handles.unsubscribe?.();
    if (handles.timer !== undefined) clearTimer(handles.timer);
  };
  const attempt = (): void => {
    if (done) return;
    const anchor = find();
    if (!anchor) return;
    cancel();
    onFound(anchor);
  };
  attempt();
  if (done) return cancel;
  handles.unsubscribe = subscribe(attempt);
  handles.timer = setTimer(cancel, timeoutMs);
  return cancel;
}

/** Сколько держится подсветка якоря, в который фокус не перенесён. */
export const HIGHLIGHT_MS = 2_500;

/**
 * Показать якорь, не трогая фокус: прокрутка и подсветка. Человек печатает —
 * прыжок фокуса отдал бы его следующий Enter кнопке страницы (ревью M4).
 */
function highlightElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center' });
  element.setAttribute('data-agent-highlight', '');
  setTimeout(() => element.removeAttribute('data-agent-highlight'), HIGHLIGHT_MS);
}

/**
 * Фокус держит модальное окно страницы, в котором лежит сам якорь: это
 * автофокус окна, открытого переходом агента (мастер контура на шаге ключа), а
 * не поле, где печатает человек.
 */
function focusHeldByAnchorDialog(anchor: HTMLElement, active: Element | null): boolean {
  if (!active) return false;
  if (anchor.contains(active)) return true;
  const dialog = active.closest('[role="dialog"]:not([aria-modal="false"])');
  return Boolean(dialog?.contains(anchor));
}

/** Фокус в якорь: у обёртки поля (поле ключа в мастере) — самому полю внутри. */
function focusElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center' });
  const field = element.matches(FOCUSABLE)
    ? element
    : element.querySelector<HTMLElement>(FOCUSABLE);
  if (field) {
    field.focus();
    return;
  }
  element.setAttribute('tabindex', '-1');
  element.focus();
}

/**
 * Довести фокус до якоря открытой агентом страницы. Не нашёлся за потолок —
 * молча остаёмся на странице: открыть её было главным, якорь лишь уточнение.
 *
 * Фокус ставится через два кадра после появления якоря: наблюдатель срабатывает
 * сразу после вставки разметки, раньше эффектов React, и модальное окно
 * страницы (мастер контура) забрало бы фокус своим автофокусом обратно.
 *
 * `onFound` — якорь нашёлся и показан (фокусом или подсветкой): только тогда
 * окну можно сказать «поле открыто». Не нашёлся — не зовётся вовсе.
 */
export function focusAnchor(
  focus: string,
  onFocused?: () => void,
  onFound?: () => void,
): () => void {
  let frame = 0;
  const cancelWatch = watchForAnchor<HTMLElement>({
    find: () => findAnchor(document, focus),
    subscribe: (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id', 'data-agent-anchor'],
      });
      return () => observer.disconnect();
    },
    onFound: (anchor) => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!anchor.isConnected) return;
          onFound?.();
          const active = document.activeElement;
          const typing = typedRecently();
          if (!typing && (canTakeFocus(active) || focusHeldByAnchorDialog(anchor, active))) {
            focusElement(anchor);
            onFocused?.();
            return;
          }
          highlightElement(anchor);
        });
      });
    },
  });
  return () => {
    cancelWatch();
    if (frame) cancelAnimationFrame(frame);
  };
}
