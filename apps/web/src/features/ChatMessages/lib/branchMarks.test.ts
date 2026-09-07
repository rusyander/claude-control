import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { branchMarks } from './branchMarks';

const message = (id: string, gitBranch?: string): ChatMessage => ({
  id,
  role: 'assistant',
  blocks: [],
  timestamp: '2026-09-07T10:00:00.000Z',
  ...(gitBranch ? { gitBranch } : {}),
});

describe('branchMarks: где в ленте агент сменил ветку', () => {
  it('отметка стоит на сообщении, с которого ветка стала другой', () => {
    const marks = branchMarks([
      message('1', 'main'),
      message('2', 'main'),
      message('3', 'feat/x'),
      message('4', 'feat/x'),
    ]);
    expect([...marks]).toEqual([['3', 'feat/x']]);
  });

  it('первое сообщение окна отметки не получает: это точка отсчёта, а не смена', () => {
    expect(branchMarks([message('1', 'feat/x'), message('2', 'feat/x')]).size).toBe(0);
  });

  it('реплики без ветки счёт не сбивают', () => {
    const marks = branchMarks([
      message('1', 'main'),
      message('2'),
      message('3', 'main'),
      message('4', 'feat/x'),
    ]);
    expect([...marks]).toEqual([['4', 'feat/x']]);
  });

  it('возврат в прежнюю ветку — тоже смена, её видно', () => {
    const marks = branchMarks([message('1', 'main'), message('2', 'feat/x'), message('3', 'main')]);
    expect([...marks.keys()]).toEqual(['2', '3']);
  });

  it('транскрипт без веток вовсе — ни одной отметки', () => {
    expect(branchMarks([message('1'), message('2')]).size).toBe(0);
  });
});
