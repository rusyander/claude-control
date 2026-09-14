import { describe, expect, it } from 'vitest';
import type { PlatformStatus } from '@agentdeck/contracts';
import { activeFirst } from './platformOrder';

const status = (id: string, enabled: boolean): PlatformStatus =>
  ({ platform: { id, enabled } }) as unknown as PlatformStatus;

describe('activeFirst', () => {
  it('поднимает активный контур наверх, не перемешивая остальные', () => {
    const order = activeFirst([status('a', false), status('b', true), status('c', false)]);
    expect(order?.map((item) => item.platform.id)).toEqual(['b', 'a', 'c']);
  });

  it('без активного оставляет порядок сервера', () => {
    const order = activeFirst([status('a', false), status('b', false)]);
    expect(order?.map((item) => item.platform.id)).toEqual(['a', 'b']);
  });

  it('пока список не пришёл, отвечает тем же «нет данных»', () => {
    expect(activeFirst(undefined)).toBeUndefined();
  });
});
