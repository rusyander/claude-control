import { describe, expect, it } from 'vitest';
import type { PlatformStatus } from '@agentdeck/contracts';
import {
  DEFAULT_PLATFORM_TAB,
  PER_CONTOUR_TABS,
  PLATFORM_TABS,
  findPlatformTab,
  pickContour,
  platformPanelDomId,
  platformTabDomId,
} from './tabs';

const status = (id: string): PlatformStatus => ({ platform: { id } }) as unknown as PlatformStatus;

describe('вкладки раздела «Контур»', () => {
  it('идентификаторы уникальны: адрес ведёт ровно в одно место', () => {
    const ids = PLATFORM_TABS.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('знакомая вкладка находится; незнакомая, пустая и `key` открывают список контуров', () => {
    expect(findPlatformTab('rules')).toBe('rules');
    expect(findPlatformTab('access')).toBe('access');
    expect(findPlatformTab('нет-такой')).toBe(DEFAULT_PLATFORM_TAB);
    expect(findPlatformTab(undefined)).toBe(DEFAULT_PLATFORM_TAB);
    expect(findPlatformTab('key')).toBe('contours');
  });

  it('вкладка и панель ссылаются друг на друга разными именами', () => {
    expect(platformTabDomId('rules')).toBe('platform-tab-rules');
    expect(platformPanelDomId('rules')).toBe('platform-panel-rules');
  });

  it('список контуров — не вкладка одного контура', () => {
    expect(PER_CONTOUR_TABS).not.toContain('contours');
    expect(PER_CONTOUR_TABS).toContain('rules');
  });

  it('контур вкладки: из адреса, иначе первый; устаревший id не даёт пустоты', () => {
    const list = [status('a'), status('b')];
    expect(pickContour(list, 'b')?.platform.id).toBe('b');
    expect(pickContour(list, undefined)?.platform.id).toBe('a');
    expect(pickContour(list, 'удалён')?.platform.id).toBe('a');
    expect(pickContour([], 'a')).toBeUndefined();
  });
});
