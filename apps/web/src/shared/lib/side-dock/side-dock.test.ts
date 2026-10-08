import { describe, expect, it } from 'vitest';
import { holdPageInert, isBesideDock } from './side-dock';
import { yieldEscapeToSideDock } from './yieldEscapeToSideDock';
import { isEscapeYieldedToSideDock } from './isEscapeYieldedToSideDock';

describe('модальное окно рядом с пристёгнутым', () => {
  it('[C1] рядом — только когда окно сдвигает страницу; поверх страницы (узкий экран) — нет', () => {
    expect(isBesideDock('440px')).toBe(true);
    expect(isBesideDock(' 440px')).toBe(true);
    expect(isBesideDock('0px')).toBe(false);
    expect(isBesideDock('')).toBe(false);
  });

  it('[C1] Escape, уступленный окну, помечен и отменён для модального', () => {
    const event = new Event('keydown', { cancelable: true });
    expect(isEscapeYieldedToSideDock(event)).toBe(false);
    yieldEscapeToSideDock(event);
    expect(event.defaultPrevented).toBe(true);
    expect(isEscapeYieldedToSideDock(event)).toBe(true);
    // Обычная отмена (модальное окно распорядилось Escape само) — не уступка.
    const own = new Event('keydown', { cancelable: true });
    own.preventDefault();
    expect(isEscapeYieldedToSideDock(own)).toBe(false);
  });

  it('[C1] вложенные окна держат страницу недоступной вместе, снимает последнее', () => {
    const page = { inert: false } as HTMLElement;
    const outer = holdPageInert(page);
    const inner = holdPageInert(page);
    expect(page.inert).toBe(true);
    inner();
    expect(page.inert).toBe(true);
    inner();
    expect(page.inert).toBe(true);
    outer();
    expect(page.inert).toBe(false);
  });
});
