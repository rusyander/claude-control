import { describe, expect, it } from 'vitest';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import { createRightsFeed } from './rights-feed.ts';

/**
 * Отказ, пахнущий правами, из книги контуров ядра (C3d): шлюз в панели звал сторожа с пути
 * запроса, теперь путь запроса у ядра, и сторож узнаёт отказ из опроса учёта. Цепочка с
 * настоящим HTTP-ответом ядра — `contours.test.ts` («события книги контуров…»); что делает
 * сторож со зовом (задержка, пол, только активный контур) — `watch.test.ts`.
 */

const START = Date.parse('2026-11-02T10:00:00.000Z');

function event(second: number, status: number, platformId = 'company-dev'): PlatformGatewayEvent {
  return {
    at: new Date(START + second * 1000).toISOString(),
    platformId,
    path: '/v1/messages',
    dialect: 'anthropic-messages',
    status,
    stages: [],
    summarized: false,
    violations: [],
    masked: false,
    blocked: false,
    interrupted: false,
    unknownFrames: [],
    lost: [],
    shimmed: [],
    toolCalls: 0,
    contourCalls: 0,
    toolFlaws: [],
    claimedWithoutCall: false,
    totalTokens: 0,
  };
}

function feed(): { read: ReturnType<typeof createRightsFeed>; noted: string[] } {
  const noted: string[] = [];
  return { read: createRightsFeed({ note: (id) => noted.push(id), now: () => START }), noted };
}

describe('createRightsFeed: отказ прав из книги контуров ядра', () => {
  it('401 и 403 после завода зовут сторожа — по разу на контур за снимок', () => {
    const { read, noted } = feed();
    // Новые сверху, как отдаёт ядро.
    read([event(3, 403, 'other'), event(2, 401), event(1, 401)]);
    expect(noted.sort()).toEqual(['company-dev', 'other']);
  });

  it('прочие коды — не права: 402 бюджет, 429 частота, 500 сервер, 200 ответ', () => {
    const { read, noted } = feed();
    read([event(1, 402), event(2, 429), event(3, 500), event(4, 200), event(5, 404)]);
    expect(noted).toEqual([]);
  });

  it('события до старта панели пробу не зовут: при старте не ходит никто', () => {
    const { read, noted } = feed();
    read([event(0, 401), event(-60, 403)]);
    expect(noted).toEqual([]);
  });

  it('тот же снимок второй раз сторожа не зовёт; новое событие поверх — зовёт', () => {
    const { read, noted } = feed();
    const first = [event(1, 401)];
    read(first);
    read(first);
    expect(noted).toEqual(['company-dev']);
    read([event(2, 403), ...first]);
    expect(noted).toEqual(['company-dev', 'company-dev']);
  });

  it('удачный ответ сдвигает метку: старый отказ за ним не повторяется', () => {
    const { read, noted } = feed();
    read([event(2, 200)]);
    read([event(2, 200), event(1, 401)]);
    expect(noted).toEqual([]);
  });

  it('звена нет — пусто, ядро без событий — ничего', () => {
    const { read, noted } = feed();
    read(undefined);
    read([]);
    expect(noted).toEqual([]);
  });
});
