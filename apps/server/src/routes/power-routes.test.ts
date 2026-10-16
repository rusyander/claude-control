import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CommandResult, PowerProbe } from '../lib/power/power.ts';
import { executePower } from '../lib/power/power.ts';
import {
  POWER_COOLDOWN_MS,
  POWER_DELAY_MS,
  pickExecutor,
  registerPowerRoutes,
} from './power-routes.ts';

/**
 * Маршрут питания без настоящей системы: пробник отвечает заготовками, а
 * исполнитель только записывает команду — ни одна проверка машину не усыпит.
 */
const REG_ON = '    HibernateEnabled    REG_DWORD    0x1';
const REG_OFF = '    HibernateEnabled    REG_DWORD    0x0';

function windowsProbe(reg: string): PowerProbe {
  return {
    platform: 'win32',
    systemDrive: 'C:',
    systemRoot: 'C:\\Windows',
    exists: () => false,
    run: async () => ({ code: 0, stdout: reg }),
  };
}

describe('/api/power', () => {
  let app: FastifyInstance;
  let executed: string[];
  let scheduled: { run: () => void; ms: number }[];
  let released: number;
  let held: boolean;
  let result: CommandResult;
  let clock: number;

  const build = async (probe: PowerProbe): Promise<void> => {
    app = Fastify();
    registerPowerRoutes(app, {
      probe,
      execute: async (command, args) => {
        executed.push([command, ...args].join(' '));
        return result;
      },
      awake: { held: () => held, release: () => (released += 1) },
      schedule: (run, ms) => scheduled.push({ run, ms }),
      log: () => {},
      now: () => clock,
    });
    await app.ready();
  };

  beforeEach(() => {
    executed = [];
    scheduled = [];
    released = 0;
    held = false;
    result = { code: 0, stdout: '' };
    clock = 1_000_000;
  });
  afterEach(() => app.close());

  it('GET: что умеет машина и держит ли её локальный прогон', async () => {
    held = true;
    await build(windowsProbe(REG_ON));
    const response = await app.inject({ method: 'GET', url: '/api/power' });
    expect(response.json()).toEqual({
      platform: 'win32',
      options: [{ action: 'hibernate', available: true }],
      awakeHeld: true,
    });
  });

  it('POST без confirm: true — 400, ничего не запланировано', async () => {
    await build(windowsProbe(REG_ON));
    for (const payload of [{ action: 'hibernate' }, { action: 'hibernate', confirm: 'yes' }, {}]) {
      const response = await app.inject({ method: 'POST', url: '/api/power', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().messageCode).toBe('power-request-invalid');
    }
    expect(scheduled).toEqual([]);
  });

  it('POST режима, которого на машине нет, — 409 и тишина', async () => {
    await build(windowsProbe(REG_OFF));
    const off = await app.inject({
      method: 'POST',
      url: '/api/power',
      payload: { action: 'hibernate', confirm: true },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().messageCode).toBe('power-unavailable');
    // Сна на Windows не предлагаем вовсе — и не выполняем.
    const sleep = await app.inject({
      method: 'POST',
      url: '/api/power',
      payload: { action: 'sleep', confirm: true },
    });
    expect(sleep.statusCode).toBe(409);
    expect(scheduled).toEqual([]);
  });

  it('POST: 202 сразу, команда — только после паузы и после снятия запрета на сон', async () => {
    await build(windowsProbe(REG_ON));
    const response = await app.inject({
      method: 'POST',
      url: '/api/power',
      payload: { action: 'hibernate', confirm: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: 'hibernate', inMs: POWER_DELAY_MS });
    expect(executed).toEqual([]);
    expect(scheduled.map((item) => item.ms)).toEqual([POWER_DELAY_MS]);

    scheduled[0]?.run();
    expect(released).toBe(1);
    expect(executed).toEqual(['C:\\Windows\\System32\\shutdown.exe /h']);
  });

  const hibernate = () =>
    app.inject({
      method: 'POST',
      url: '/api/power',
      payload: { action: 'hibernate', confirm: true },
    });

  it('двойное нажатие — одна команда: повтор получает тот же ответ и ничего не ставит', async () => {
    await build(windowsProbe(REG_ON));
    await hibernate();
    clock += 500;
    const again = await hibernate();
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ action: 'hibernate', inMs: POWER_DELAY_MS - 500 });
    // Команда ушла, машина ещё засыпает — повтор всё равно не ставит вторую.
    scheduled[0]?.run();
    clock += POWER_DELAY_MS + POWER_COOLDOWN_MS - 1_000;
    expect((await hibernate()).json().inMs).toBe(0);
    expect(scheduled).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  it('после пробуждения (часы ушли за окно) просьба снова проходит', async () => {
    await build(windowsProbe(REG_ON));
    await hibernate();
    scheduled[0]?.run();
    clock += POWER_DELAY_MS + POWER_COOLDOWN_MS;
    await hibernate();
    expect(scheduled).toHaveLength(2);
  });

  it('система отказала — повтор разрешён сразу, окна не ждёт', async () => {
    result = { code: 1, stdout: 'Гибернация не включена.' };
    await build(windowsProbe(REG_ON));
    await hibernate();
    scheduled[0]?.run();
    await new Promise((resolve) => setImmediate(resolve));
    await hibernate();
    expect(scheduled).toHaveLength(2);
  });

  it('система отказала после ответа — отказ виден следующему GET', async () => {
    result = { code: 1, stdout: 'Гибернация не включена.' };
    await build(windowsProbe(REG_ON));
    await app.inject({
      method: 'POST',
      url: '/api/power',
      payload: { action: 'hibernate', confirm: true },
    });
    scheduled[0]?.run();
    await new Promise((resolve) => setImmediate(resolve));
    const status = (await app.inject({ method: 'GET', url: '/api/power' })).json();
    expect(status.lastFailure).toMatchObject({
      action: 'hibernate',
      message: 'Гибернация не включена.',
    });
  });

  // Проверяется только выбор исполнителя — ни один вызов здесь не выполняется: ошибка
  // в выборе отправила бы машину, на которой идут тесты, в гибернацию.
  it('холостой режим не выбирает системный вызов; без него и без подстановки — системный', () => {
    expect(pickExecutor({ dryRun: true })).not.toBe(executePower);
    expect(pickExecutor({ dryRun: false })).toBe(executePower);
    const injected = async () => ({ code: 0, stdout: '' });
    expect(pickExecutor({ execute: injected, dryRun: false })).toBe(injected);
  });
});
