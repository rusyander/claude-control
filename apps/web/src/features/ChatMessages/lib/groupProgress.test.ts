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
const RUN = '2026-10-19T11:20:00.000Z';
const running = { isRunning: true, startedAt: STARTED, lastAt: LAST, runStartedAt: RUN };
const bash = { name: 'Bash', summary: 'pnpm test', startedAt: '2026-10-19T11:28:00.000Z' };

describe('groupProgress', () => {
  it('идёт по плану: сделано 7 из 14 — 50 %, работает со старта хода, вызов виден', () => {
    const view = groupProgress({
      progress: { ...plan(7, 14), activeTool: bash },
      group: running,
      permission: false,
    });
    expect(view).toMatchObject({
      state: 'working',
      since: RUN,
      done: 7,
      total: 14,
      percent: 50,
      tool: bash,
      step: { current: 8, total: 14, name: 'Ревью' },
    });
  });

  it('файл шагов: идущий шаг ещё не сделан — сделано на один меньше', () => {
    const steps = { current: 8, total: 14, title: 'Прогон тестов' };
    const live = groupProgress({
      progress: { tasks: [], agents: [], steps },
      group: running,
      permission: false,
    });
    expect(live).toMatchObject({ done: 7, total: 14, percent: 50 });
    const last = groupProgress({
      progress: { tasks: [], agents: [], steps: { current: 14, total: 14 } },
      group: { isRunning: false, lastAt: LAST },
      permission: false,
    });
    expect(last).toMatchObject({ state: 'stalled', since: LAST, done: 13, total: 14 });
  });

  it('запрос прав сильнее работы — с момента вызова, что его ждёт', () => {
    const view = groupProgress({
      progress: { ...plan(2, 5), activeTool: bash },
      group: running,
      permission: true,
    });
    expect(view.state).toBe('permission');
    expect(view.since).toBe(bash.startedAt);
  });

  it('не идёт — стоит с последней записи, незакрытый вызов не показан', () => {
    const view = groupProgress({
      progress: { ...plan(3, 6), activeTool: bash },
      group: { isRunning: false, startedAt: STARTED, lastAt: LAST },
      permission: false,
    });
    expect(view).toMatchObject({ state: 'stalled', since: LAST, done: 3, total: 6, percent: 50 });
    expect(view.tool).toBeUndefined();
  });

  /** Живой прогон 20.10: продолженная через сутки группа «работала 21ч 09м» при часе работы. */
  it('старт хода неизвестен — «работает» без времени, а не с заведения цепочки', () => {
    const view = groupProgress({
      progress: { tasks: [], agents: [] },
      group: { isRunning: true, startedAt: STARTED, lastAt: LAST },
      permission: false,
    });
    expect(view.state).toBe('working');
    expect(view.since).toBeUndefined();
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
