import { describe, it, expect } from 'vitest';
import type { ProgressAgent } from '@agentdeck/contracts';
import { agentView, backgroundAgentRunning } from './agentView';
import { summarizeProgress } from './summarizeProgress';
import { clockTicks } from './clockTicks';

/**
 * Фоновый субагент между ходами (живой прогон 14.10): процесс разговора умер, а
 * транскрипт по-прежнему звал субагента «работает» — полоса молчала часами.
 */
const bg: ProgressAgent = {
  id: 'a',
  kind: 'lane-high',
  description: 'Fetch MR !990',
  status: 'running',
  background: true,
};

describe('agentView', () => {
  it('процесс умер между ходами — «оборван»', () => {
    expect(agentView(bg, false, false)).toBe('lost');
  });

  it('процесс жив, ход идёт или признака нет — как в транскрипте', () => {
    expect(agentView(bg, false, true)).toBe('running');
    expect(agentView(bg, true, false)).toBe('running');
    expect(agentView(bg, false)).toBe('running');
    expect(agentView({ ...bg, status: 'done' }, false, false)).toBe('done');
  });

  it('опрос между ходами нужен, пока жив процесс и идёт субагент', () => {
    expect(backgroundAgentRunning([bg], true)).toBe(true);
    expect(backgroundAgentRunning([bg], false)).toBe(false);
    expect(backgroundAgentRunning([{ ...bg, status: 'done' }], true)).toBe(false);
  });
});

describe('сводка с фоновым субагентом', () => {
  it('оборванный считается отдельно и не числится работающим', () => {
    const summary = summarizeProgress({ tasks: [], agents: [bg], processAlive: false });
    expect(summary).toMatchObject({ agentsRunning: 0, agentsLost: 1, agentsTotal: 1 });
    expect(clockTicks(summary, false)).toBe(false);
  });

  it('живой между ходами — работает, часы тикают («писал N назад» растёт)', () => {
    const summary = summarizeProgress({ tasks: [], agents: [bg], processAlive: true });
    expect(summary).toMatchObject({ agentsRunning: 1, agentsLost: 0 });
    expect(clockTicks(summary, false)).toBe(true);
  });
});
