import { describe, it, expect } from 'vitest';
import { AUTO_START_ATTEMPTS, AUTO_START_COOLDOWN_MS, GatewayAutoStart } from './auto-start.ts';

/**
 * Подъём своего шлюза, когда тумблер уже включён, а слушателя нет (A-1).
 *
 * Здесь заперта ровно та опасность, которой чинится замок «Картинки»: расчёт
 * плана идёт на каждое открытие меню чата, и подъём без защёлки превратил бы
 * занятый порт в бесконечную череду попыток `listen`. Поэтому проверяется не
 * «поднялся», а СКОЛЬКО РАЗ пробовали — и что тумблер при этом не тронут.
 */

interface Harness {
  auto: GatewayAutoStart;
  starts: () => number;
  running: (value: boolean) => void;
  enabled: (value: boolean) => void;
  tick: (ms: number) => void;
}

function harness(options: { fail?: boolean } = {}): Harness {
  let starts = 0;
  let running = false;
  let enabled = true;
  let now = 1_000_000;
  const auto = new GatewayAutoStart({
    enabled: () => enabled,
    running: () => running,
    now: () => now,
    start: () => {
      starts += 1;
      if (options.fail) return Promise.reject(new Error('EADDRINUSE 5179'));
      running = true;
      return Promise.resolve();
    },
  });
  return {
    auto,
    starts: () => starts,
    running: (value) => {
      running = value;
    },
    enabled: (value) => {
      enabled = value;
    },
    tick: (ms) => {
      now += ms;
    },
  };
}

describe('GatewayAutoStart', () => {
  it('тумблер выключен — панель не вмешивается ни одной попыткой', async () => {
    const stand = harness();
    stand.enabled(false);
    await stand.auto.ensure();
    expect(stand.starts()).toBe(0);
    // И сказать ей нечего: это выбор человека, а не отказ слушателя.
    expect(stand.auto.state()).toEqual({ failures: 0, exhausted: false });
  });

  it('тумблер включён, слушателя нет — поднимаем сами, ровно один раз', async () => {
    const stand = harness();
    await stand.auto.ensure();
    expect(stand.starts()).toBe(1);

    // Шлюз жив — следующие расчёты плана его не трогают.
    await stand.auto.ensure();
    await stand.auto.ensure();
    expect(stand.starts()).toBe(1);
  });

  it('отказ слушателя назван словами, а не проглочен', async () => {
    const stand = harness({ fail: true });
    await expect(stand.auto.ensure()).resolves.toBeUndefined();
    expect(stand.auto.state()).toEqual({
      failures: 1,
      exhausted: false,
      error: 'EADDRINUSE 5179',
    });
  });

  it('пауза между попытками: два расчёта плана подряд — одна попытка', async () => {
    const stand = harness({ fail: true });
    await stand.auto.ensure();
    await stand.auto.ensure();
    await stand.auto.ensure();
    expect(stand.starts()).toBe(1);

    stand.tick(AUTO_START_COOLDOWN_MS);
    await stand.auto.ensure();
    expect(stand.starts()).toBe(2);
  });

  it('потолок попыток: дальше панель молчит, а не долбится в занятый порт', async () => {
    const stand = harness({ fail: true });
    for (let attempt = 0; attempt < AUTO_START_ATTEMPTS + 5; attempt += 1) {
      await stand.auto.ensure();
      stand.tick(AUTO_START_COOLDOWN_MS);
    }
    expect(stand.starts()).toBe(AUTO_START_ATTEMPTS);
    expect(stand.auto.state().exhausted).toBe(true);
    expect(stand.auto.state().error).toBe('EADDRINUSE 5179');
  });

  it('слушатель увиден живым — потолок забыт: следующее падение получит свои попытки', async () => {
    const stand = harness({ fail: true });
    for (let attempt = 0; attempt < AUTO_START_ATTEMPTS; attempt += 1) {
      await stand.auto.ensure();
      stand.tick(AUTO_START_COOLDOWN_MS);
    }
    expect(stand.auto.state().exhausted).toBe(true);

    // Человек освободил порт и нажал «Поднять шлюз».
    stand.running(true);
    await stand.auto.ensure();
    expect(stand.auto.state()).toEqual({ failures: 0, exhausted: false });

    stand.running(false);
    await stand.auto.ensure();
    expect(stand.starts()).toBe(AUTO_START_ATTEMPTS + 1);
  });

  it('два расчёта разом (вкладка и телефон) — одна попытка на двоих', async () => {
    const stand = harness();
    await Promise.all([stand.auto.ensure(), stand.auto.ensure(), stand.auto.ensure()]);
    expect(stand.starts()).toBe(1);
  });
});
