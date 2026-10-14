import { describe, expect, it } from 'vitest';
import { createRunSync } from './run-sync.ts';

/**
 * Запрет сна и отложенный перезапуск следуют за состоянием «идёт локальный прогон»
 * (L4b). Подменены только источники состояния; решения — настоящие.
 */

function world() {
  const state = { active: false, awakeOn: true, pending: false, applying: undefined as unknown };
  const awake: boolean[] = [];
  const applied: string[] = [];
  const logged: string[] = [];
  let release: (() => void) | undefined;
  let failApply = false;
  const sync = createRunSync({
    active: () => state.active,
    keepAwakeOn: () => state.awakeOn,
    awake: { sync: (wanted) => awake.push(wanted) },
    restart: {
      pending: () => state.pending,
      apply: () => {
        applied.push('apply');
        if (failApply) return Promise.reject(new Error('порт занят'));
        return new Promise<boolean>((resolve) => {
          release = () => {
            state.pending = false;
            resolve(true);
          };
        });
      },
    },
    log: (message) => logged.push(message),
  });
  return {
    state,
    sync,
    awake,
    applied,
    logged,
    finishApply: () => release?.(),
    failNext: () => {
      failApply = true;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('запрет сна следует за прогоном', () => {
  it('прогон идёт и выключатель включён — запрет нужен', () => {
    const w = world();
    w.state.active = true;
    w.sync();
    expect(w.awake).toEqual([true]);
  });

  it('прогон кончился — запрет снимается', () => {
    const w = world();
    w.state.active = true;
    w.sync();
    w.state.active = false;
    w.sync();
    expect(w.awake).toEqual([true, false]);
  });

  it('человек выключил запрет, а прогон идёт — запрет не нужен', () => {
    const w = world();
    w.state.active = true;
    w.state.awakeOn = false;
    w.sync();
    expect(w.awake).toEqual([false]);
  });

  it('выключатель выключен посреди прогона — запрет снимается на следующем опросе', () => {
    const w = world();
    w.state.active = true;
    w.sync();
    w.state.awakeOn = false;
    w.sync();
    expect(w.awake).toEqual([true, false]);
  });
});

describe('отложенный перезапуск выполняется, когда прогонов нет', () => {
  it('прогон идёт — не трогаем; кончился — применяем один раз', async () => {
    const w = world();
    w.state.pending = true;
    w.state.active = true;
    w.sync();
    expect(w.applied).toEqual([]);
    w.state.active = false;
    w.sync();
    expect(w.applied).toEqual(['apply']);
    // Подъём идёт долго: следующие опросы второго перезапуска не заводят.
    w.sync();
    w.sync();
    expect(w.applied).toEqual(['apply']);
    w.finishApply();
    await tick();
    w.sync();
    expect(w.applied).toEqual(['apply']);
  });

  it('ждать нечего — применять нечего', () => {
    const w = world();
    w.sync();
    expect(w.applied).toEqual([]);
  });

  it('сбой подъёма уходит в журнал, а не наружу; опрос продолжает работать', async () => {
    const w = world();
    w.failNext();
    w.state.pending = true;
    w.sync();
    await tick();
    expect(w.logged).toEqual(['local models: deferred restart failed']);
    // Запись об ожидании не снялась (apply отказал) — следующий опрос пробует снова.
    w.sync();
    expect(w.applied).toHaveLength(2);
  });
});
