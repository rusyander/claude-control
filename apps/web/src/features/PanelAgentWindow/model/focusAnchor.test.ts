import { describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_TIMEOUT_MS,
  TYPING_GRACE_MS,
  canTakeFocus,
  isEditable,
  noteKeystroke,
  resetTyping,
  typedRecently,
  watchForAnchor,
} from './focusAnchor';

/** Разметка-подделка: якорь появляется, когда тест «дорисовал» страницу. */
function fakePage() {
  let anchor: string | null = null;
  const listeners = new Set<() => void>();
  return {
    find: () => anchor,
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    render: (value: string) => {
      anchor = value;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe('watchForAnchor', () => {
  it('якорь уже на странице — находит сразу и не подписывается', () => {
    const page = fakePage();
    page.render('field');
    const onFound = vi.fn();
    watchForAnchor({ ...page, onFound });
    expect(onFound).toHaveBeenCalledWith('field');
    expect(page.listeners.size).toBe(0);
  });

  it('дожидается якоря, появившегося позже прежних двух секунд', () => {
    vi.useFakeTimers();
    const page = fakePage();
    const onFound = vi.fn();
    watchForAnchor({ ...page, onFound });
    vi.advanceTimersByTime(8_000);
    page.render('late');
    expect(onFound).toHaveBeenCalledOnce();
    expect(page.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('после потолка ожидание снято: поздний якорь фокус не получает', () => {
    vi.useFakeTimers();
    const page = fakePage();
    const onFound = vi.fn();
    watchForAnchor({ ...page, onFound });
    vi.advanceTimersByTime(ANCHOR_TIMEOUT_MS + 1);
    page.render('too-late');
    expect(onFound).not.toHaveBeenCalled();
    expect(page.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('отмена (следующий переход) снимает ожидание и таймер', () => {
    vi.useFakeTimers();
    const page = fakePage();
    const onFound = vi.fn();
    const cancel = watchForAnchor({ ...page, onFound });
    cancel();
    page.render('after-navigation');
    expect(onFound).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

/** Узел-подделка: тесты идут без DOM, политике нужны только тег, тип и роль. */
const fakeElement = (tagName: string, extra: Record<string, unknown> = {}) =>
  ({
    tagName,
    isContentEditable: false,
    getAttribute: () => null,
    ...extra,
  }) as unknown as Element;

describe('политика фокуса: человек печатает', () => {
  it('поля ввода — в том числе поле самого агента — не отдают фокус', () => {
    resetTyping();
    expect(isEditable(fakeElement('TEXTAREA'))).toBe(true);
    expect(isEditable(fakeElement('INPUT', { type: 'password' }))).toBe(true);
    expect(isEditable(fakeElement('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditable(fakeElement('BUTTON'))).toBe(false);
    expect(canTakeFocus(fakeElement('TEXTAREA'), 10_000)).toBe(false);
  });

  it('клавиша нажата меньше 2 с назад — фокус не забирается, Tab и Escape не в счёт', () => {
    resetTyping();
    noteKeystroke('a', 1_000);
    expect(canTakeFocus(fakeElement('INPUT', { type: 'text' }), 1_000 + TYPING_GRACE_MS - 1)).toBe(
      false,
    );
    resetTyping();
    noteKeystroke('Tab', 1_000);
    noteKeystroke('Escape', 1_000);
    expect(typedRecently(1_001)).toBe(false);
    noteKeystroke(' ', 1_000);
    expect(typedRecently(1_001)).toBe(true);
    expect(typedRecently(1_000 + TYPING_GRACE_MS)).toBe(false);
    resetTyping();
  });
});
