import { describe, expect, it } from 'vitest';
import type { ChatProgress } from '@agentdeck/contracts';

import { groupProgress } from './groupProgress';

const task = (text: string, status: 'pending' | 'in_progress' | 'completed') => ({ text, status });
const plan = (done: number, total: number): ChatProgress => ({
  tasks: [
    ...Array.from({ length: done }, (_, i) => task(`d${i}`, 'completed')),
    task('Ревью', 'in_progress'),
    ...Array.from({ length: total - done - 1 }, (_, i) => task(`p${i}`, 'pending')),
  ],
  agents: [],
});
const STARTED = '2026-10-19T10:00:00.000Z';
const LAST = '2026-10-19T11:30:00.000Z';
const running = { isRunning: true, startedAt: STARTED, lastAt: LAST };
const bash = { name: 'Bash', summary: 'pnpm test', startedAt: '2026-10-19T11:28:00.000Z' };

describe('groupProgress', () => {
  it('идёт по плану: сделано 7 из 14 — 50 %, работает с заведения, вызов виден', () => {
    const view = groupProgress({
      progress: { ...plan(7, 14), activeTool: bash },
      group: running,
      permission: false,
    });
    expect(view).toMatchObject({
      state: 'working',
      since: STARTED,
      done: 7,
      total: 14,
      percent: 50,
      tool: bash,
      step: { current: 8, total: 14, name: 'Ревью' },
    });
  });

  it('файл шагов: идущий шаг ещё не сделан, у закончившей — сделан', () => {
    const steps = { current: 8, total: 14, title: 'Прогон тестов' };
    const live = groupProgress({
      progress: { tasks: [], agents: [], steps },
      group: running,
      permission: false,
    });
    expect(live).toMatchObject({ done: 7, total: 14, percent: 50 });
    const done = groupProgress({
      progress: { tasks: [], agents: [], steps: { current: 14, total: 14 } },
      group: { isRunning: false, status: 'done', lastAt: LAST },
      permission: false,
    });
    expect(done).toMatchObject({ state: 'finished', since: LAST, done: 14, percent: 100 });
  });

  it('запрос прав сильнее очереди и работы — с момента вызова, что его ждёт', () => {
    const view = groupProgress({
      progress: {
        ...plan(2, 5),
        activeTool: bash,
        heavyQueue: { since: '2026-10-19T11:29:00.000Z', ahead: 1 },
      },
      group: running,
      permission: true,
    });
    expect(view.state).toBe('permission');
    expect(view.since).toBe(bash.startedAt);
    expect(view.queueAhead).toBeUndefined();
  });

  it('билет очереди тяжёлых шагов: «ждёт очередь» с билета и сколько впереди', () => {
    const view = groupProgress({
      progress: {
        ...plan(2, 5),
        activeTool: bash,
        heavyQueue: { since: '2026-10-19T11:29:00.000Z', ahead: 2, command: 'pnpm test' },
      },
      group: running,
      permission: false,
    });
    expect(view).toMatchObject({
      state: 'queued',
      since: '2026-10-19T11:29:00.000Z',
      queueAhead: 2,
      tool: bash,
    });
  });

  it('не идёт и не доставлена — стоит с последней записи, незакрытый вызов не показан', () => {
    const view = groupProgress({
      progress: { ...plan(3, 6), activeTool: bash },
      group: { isRunning: false, status: 'awaiting', startedAt: STARTED, lastAt: LAST },
      permission: false,
    });
    expect(view).toMatchObject({ state: 'stalled', since: LAST, done: 3, total: 6, percent: 50 });
    expect(view.tool).toBeUndefined();
  });

  it('влитый MR — закончила, даже если запись конвейера не «готово»', () => {
    const view = groupProgress({
      progress: undefined,
      group: { isRunning: false, mrClosed: 'merged', lastAt: LAST },
      permission: false,
    });
    expect(view).toEqual({ state: 'finished', since: LAST });
  });

  it('ни плана, ни файла шагов — полосы нет, процентов не выдумывает', () => {
    const view = groupProgress({
      progress: { tasks: [], agents: [], activeTool: bash },
      group: running,
      permission: false,
    });
    expect(view.percent).toBeUndefined();
    expect(view.total).toBeUndefined();
    expect(view.state).toBe('working');
  });
});
