import { describe, expect, it } from 'vitest';
import { platformDenySet } from './deny-overlay.ts';

/**
 * Очередь машины (этап 11, P141) входит в пути платформы рядом с домом ядра: сеанс не читает и не
 * правит аренды мест всех ядер машины. Нет очереди в фактах — набор прежний.
 */

describe('platform deny set: the machine queue', () => {
  it('is denied after the core home and before the token files; absent — not added', () => {
    const facts = { coreHome: '/core-home', tokenFiles: ['/t/forge-token'] };
    expect(platformDenySet({ ...facts, machineQueue: '/machine/queue' }).paths).toEqual([
      '/core-home',
      '/machine/queue',
      '/t/forge-token',
    ]);
    expect(platformDenySet(facts).paths).toEqual(['/core-home', '/t/forge-token']);
  });
});
