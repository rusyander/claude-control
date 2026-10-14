import { describe, expect, it } from 'vitest';
import type { Health } from './llama-client.ts';
import type { ServerRecord } from './server.ts';
import {
  HUNG_AFTER_MISSES,
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  createServerSupervisor,
  type SupervisorDeps,
} from './supervisor.ts';

/**
 * Присмотр за сервером моделей (L4b): умерший сервер поднимается сам, не больше трёх раз
 * за десять минут, а остановленный человеком не воскресает. Часы, процесс и подъём
 * подставлены; логика решений — настоящая.
 */

const RECORD = { tag: 'qwen', pid: 4242, startedAt: 1, context: 65_536 } as unknown as ServerRecord;

interface World {
  record: ServerRecord | undefined;
  health: Health | undefined;
  alive: boolean;
  busy: boolean;
  clock: number;
  restarts: number;
  kills: number;
  failWith?: string;
  healthHook?: () => void;
}

function make(world: Partial<World> = {}) {
  const state: World = {
    record: RECORD,
    health: undefined,
    alive: false,
    busy: false,
    clock: 1_000_000,
    restarts: 0,
    kills: 0,
    ...world,
  };
  const deps: SupervisorDeps = {
    record: () => state.record,
    health: () => {
      state.healthHook?.();
      return Promise.resolve(state.health);
    },
    pidAlive: () => state.alive,
    kill: () => {
      state.kills += 1;
    },
    restart: () => {
      state.restarts += 1;
      if (state.failWith) return Promise.reject(new Error(state.failWith));
      state.health = 'ok';
      state.alive = true;
      return Promise.resolve();
    },
    busy: () => state.busy,
    now: () => state.clock,
  };
  return { state, supervisor: createServerSupervisor(deps) };
}

/** Сервер при нас был жив, потом упал; `world` — что видно после падения. */
async function watched(world: Partial<World> = {}) {
  const made = make({ health: 'ok', alive: true });
  await made.supervisor.tick();
  Object.assign(made.state, { health: undefined, alive: false, ...world });
  return made;
}

describe('присмотр за сервером моделей', () => {
  it('мёртвый процесс при записи и молчащем /health — сервер поднимается по записи', async () => {
    const { state, supervisor } = await watched();
    expect(await supervisor.tick()).toBe('restarted');
    expect(state.restarts).toBe(1);
    expect(supervisor.notice()).toMatchObject({ kind: 'restarted', restarts: 1 });
  });

  it('живой и отвечающий сервер не трогается', async () => {
    const { state, supervisor } = make({ health: 'ok', alive: true });
    expect(await supervisor.tick()).toBe('alive');
    expect(state.restarts).toBe(0);
    expect(supervisor.notice()).toBeUndefined();
  });

  it('модель в загрузке (loading) — жива: ждём, а не поднимаем второй раз', async () => {
    const { state, supervisor } = make({ health: 'loading', alive: true });
    expect(await supervisor.tick()).toBe('alive');
    expect(state.restarts).toBe(0);
  });

  it('записи нет (человек остановил сервер) — не воскрешаем', async () => {
    const { state, supervisor } = make({ record: undefined });
    expect(await supervisor.tick()).toBe('none');
    expect(state.restarts).toBe(0);
  });

  it('панель сама запускает или останавливает сервер (busy) — присмотр молчит', async () => {
    const { state, supervisor } = make({ busy: true });
    expect(await supervisor.tick()).toBe('busy');
    expect(state.restarts).toBe(0);
  });

  it('панель взялась за сервер, пока шла проверка, — подъём отменяется', async () => {
    const { state, supervisor } = await watched();
    // Между «спросили /health» и «решили» панель начала свой запуск.
    state.healthHook = () => {
      state.busy = true;
    };
    expect(await supervisor.tick()).toBe('busy');
    expect(state.restarts).toBe(0);
  });

  it('процесс жив, а /health молчит HUNG_AFTER_MISSES проверок подряд — завис: снимается и поднимается', async () => {
    const { state, supervisor } = await watched({ alive: true });
    for (let i = 0; i < HUNG_AFTER_MISSES - 1; i += 1) {
      expect(await supervisor.tick()).toBe('alive');
    }
    expect(state.restarts).toBe(0);
    expect(await supervisor.tick()).toBe('restarted');
    expect(state.kills).toBe(1);
    expect(state.restarts).toBe(1);
  });

  it('ответ /health обнуляет счёт молчаний: один пропуск не копится в «завис»', async () => {
    const { state, supervisor } = await watched({ alive: true });
    for (let i = 0; i < HUNG_AFTER_MISSES - 1; i += 1) await supervisor.tick();
    state.health = 'ok';
    await supervisor.tick();
    state.health = undefined;
    for (let i = 0; i < HUNG_AFTER_MISSES - 1; i += 1) {
      expect(await supervisor.tick()).toBe('alive');
    }
    expect(state.restarts).toBe(0);
  });

  it('потолок: после MAX_RESTARTS подъёмов за окно — больше не пытается и называет это', async () => {
    const { state, supervisor } = await watched();
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      state.health = undefined;
      state.alive = false;
      expect(await supervisor.tick()).toBe('restarted');
      state.clock += 60_000;
    }
    state.health = undefined;
    state.alive = false;
    expect(await supervisor.tick()).toBe('capped');
    expect(state.restarts).toBe(MAX_RESTARTS);
    expect(supervisor.notice()).toMatchObject({ kind: 'gave-up', restarts: MAX_RESTARTS });
  });

  it('окно истекло — потолок снова открыт', async () => {
    const { state, supervisor } = await watched();
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      state.health = undefined;
      state.alive = false;
      await supervisor.tick();
    }
    state.health = undefined;
    state.alive = false;
    expect(await supervisor.tick()).toBe('capped');
    state.clock += RESTART_WINDOW_MS + 1;
    expect(await supervisor.tick()).toBe('restarted');
  });

  it('подъём не удался — причина в сообщении, попытка засчитана; на третьей — «сдался»', async () => {
    const { state, supervisor } = await watched({ failWith: 'CUDA out of memory' });
    expect(await supervisor.tick()).toBe('failed');
    expect(supervisor.notice()).toMatchObject({
      kind: 'failed',
      reason: 'CUDA out of memory',
      restarts: 1,
    });
    await supervisor.tick();
    await supervisor.tick();
    expect(state.restarts).toBe(MAX_RESTARTS);
    expect(supervisor.notice()).toMatchObject({ kind: 'gave-up', reason: 'CUDA out of memory' });
  });

  it('человек запустил сервер сам (reset) — потолок и сообщение сброшены', async () => {
    const { state, supervisor } = await watched({ failWith: 'boom' });
    for (let i = 0; i < MAX_RESTARTS; i += 1) await supervisor.tick();
    expect(await supervisor.tick()).toBe('capped');
    supervisor.reset();
    expect(supervisor.notice()).toBeUndefined();
    state.failWith = undefined;
    expect(await supervisor.tick()).toBe('restarted');
  });

  it('тик и шлюз одновременно — один подъём, а не два процесса на один порт', async () => {
    const { state, supervisor } = await watched();
    const [first, second] = await Promise.all([supervisor.tick(), supervisor.revive()]);
    expect(first).toBe('restarted');
    // Запрос шлюза ждёт идущий подъём и проверяет заново: сервер уже жив.
    expect(second).toBe('alive');
    expect(state.restarts).toBe(1);
  });

  it('таймер не будит модель, которая при нас не жила (после перезагрузки), а запрос шлюза — будит', async () => {
    const { state, supervisor } = make();
    expect(await supervisor.tick()).toBe('none');
    expect(state.restarts).toBe(0);
    expect(await supervisor.revive()).toBe('restarted');
    expect(state.restarts).toBe(1);
  });

  it('запись стёрта неудачным подъёмом — поднимает по запомненной', async () => {
    const { state, supervisor } = await watched({ failWith: 'boom' });
    expect(await supervisor.tick()).toBe('failed');
    state.record = undefined;
    state.failWith = undefined;
    expect(supervisor.target()).toBe(RECORD);
    expect(await supervisor.tick()).toBe('restarted');
    expect(state.restarts).toBe(2);
  });

  it('человек остановил сервер (forget) — ни таймер, ни шлюз не воскрешают', async () => {
    const { state, supervisor } = await watched();
    state.record = undefined;
    supervisor.forget();
    expect(supervisor.target()).toBeUndefined();
    expect(await supervisor.tick()).toBe('none');
    expect(await supervisor.revive()).toBe('none');
    expect(state.restarts).toBe(0);
  });

  it('сервер запущен при нас (observe) — упав, поднимается таймером', async () => {
    const { state, supervisor } = make();
    supervisor.observe(RECORD);
    expect(await supervisor.tick()).toBe('restarted');
    expect(state.restarts).toBe(1);
  });

  it('шлюз просит подъём, когда сервер жив, — «alive», без подъёма', async () => {
    const { state, supervisor } = make({ health: 'ok', alive: true });
    expect(await supervisor.revive()).toBe('alive');
    expect(state.restarts).toBe(0);
  });
});

describe('после потолка — редкие попытки, а не отказ навсегда и не серия раз в окно (L4c, F2)', () => {
  const TICK = 15_000;

  /** Пятьдесят минут тиков с сервером, который не поднимается. */
  async function failingNight(minutes: number) {
    const made = await watched({ failWith: 'CUDA out of memory' });
    const results: string[] = [];
    for (let elapsed = 0; elapsed < minutes * 60_000; elapsed += TICK) {
      results.push(await made.supervisor.tick());
      made.state.clock += TICK;
    }
    return { ...made, results };
  }

  it('сервер не встаёт всю ночь: после трёх подряд — одна попытка за окно, а не три', async () => {
    const { state } = await failingNight(50);
    // 3 сразу + по одной в каждое следующее окно (50 мин / 10 мин = 5), а не 15 подряд сериями.
    expect(state.restarts).toBeLessThanOrEqual(MAX_RESTARTS + 5);
    expect(state.restarts).toBeGreaterThanOrEqual(MAX_RESTARTS + 4);
  });

  it('между редкими попытками — «потолок», а сообщение остаётся: число попыток и последняя ошибка', async () => {
    const { supervisor, state } = await failingNight(25);
    expect(supervisor.notice()).toMatchObject({
      kind: 'gave-up',
      reason: 'CUDA out of memory',
    });
    expect(supervisor.notice()?.restarts).toBe(state.restarts);
    // Следующая попытка названа временем — карточка скажет, когда панель попробует снова.
    expect(supervisor.notice()?.nextTryAt).toBeGreaterThan(state.clock - TICK);
  });

  it('удачный подъём после паузы сбрасывает потолок: следующий сбой снова получает быстрые попытки', async () => {
    const { supervisor, state } = await failingNight(12);
    state.failWith = undefined;
    state.clock += RESTART_WINDOW_MS;
    expect(await supervisor.tick()).toBe('restarted');
    expect(supervisor.notice()).toMatchObject({ kind: 'restarted' });
    const base = state.restarts;
    // Упал снова: не десять минут ожидания, а обычная быстрая попытка.
    Object.assign(state, { health: undefined, alive: false });
    state.clock += TICK;
    expect(await supervisor.tick()).toBe('restarted');
    // И полный запас быстрых попыток: удачный подъём не оставляет себя в счёте окна.
    Object.assign(state, { health: undefined, alive: false, failWith: 'снова не встаёт' });
    for (let round = 0; round < 8; round += 1) {
      state.clock += TICK;
      await supervisor.tick();
    }
    expect(state.restarts - base).toBe(MAX_RESTARTS);
  });

  it('шлюз в паузе после потолка не поднимает сервер, пока не прошло окно', async () => {
    const { supervisor, state } = await failingNight(2);
    const before = state.restarts;
    expect(await supervisor.revive()).toBe('capped');
    expect(state.restarts).toBe(before);
    state.clock += RESTART_WINDOW_MS;
    expect(await supervisor.revive()).toBe('failed');
    expect(state.restarts).toBe(before + 1);
  });
});

describe('Стоп человека посреди подъёма (L4c, F4)', () => {
  /** Подъём, который стоит, пока тест не отпустит его. */
  function slow(options: { failWith?: string } = {}) {
    let release: () => void = () => undefined;
    const seen: { cancelledAtStart?: boolean; control?: { cancelled: () => boolean } } = {};
    const state = {
      health: 'ok' as Health | undefined,
      alive: true,
      restarts: 0,
    };
    const supervisor = createServerSupervisor({
      record: () => RECORD,
      health: () => Promise.resolve(state.health),
      pidAlive: () => state.alive,
      kill: () => undefined,
      restart: (_record, control) => {
        state.restarts += 1;
        seen.control = control;
        return new Promise<void>((resolve, reject) => {
          release = () => (options.failWith ? reject(new Error(options.failWith)) : resolve());
        });
      },
      busy: () => false,
      now: () => 1_000_000,
    });
    return { supervisor, state, seen, release: () => release() };
  }

  async function goneDown(made: ReturnType<typeof slow>): Promise<Promise<string>> {
    await made.supervisor.tick();
    made.state.health = undefined;
    made.state.alive = false;
    return made.supervisor.tick();
  }

  it('Стоп до конца подъёма: подъём узнаёт об отмене, исход не записывается и сервер не «наблюдается»', async () => {
    const made = slow();
    const outcome = goneDown(made);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(made.seen.control?.cancelled()).toBe(false);
    made.supervisor.forget();
    expect(made.seen.control?.cancelled()).toBe(true);
    made.release();
    expect(await outcome).toBe('none');
    // Сообщение «поднят заново» не появляется: человек остановил сервер, подъём был лишним.
    expect(made.supervisor.notice()).toBeUndefined();
    // Присмотр не считает сервер своим: таймер больше ничего не поднимает.
    expect(await made.supervisor.tick()).toBe('none');
  });

  it('Стоп во время подъёма, который падает: «подъём не удался» не показывается — это не сбой', async () => {
    const made = slow({ failWith: 'local-exited' });
    const outcome = goneDown(made);
    await new Promise((resolve) => setTimeout(resolve, 0));
    made.supervisor.forget();
    made.release();
    expect(await outcome).toBe('none');
    expect(made.supervisor.notice()).toBeUndefined();
  });
});
