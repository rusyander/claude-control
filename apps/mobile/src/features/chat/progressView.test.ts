import { describe, expect, it } from 'vitest';
import type { ChatProgress } from '@agentdeck/contracts';
import { progressHead } from './progressView';

/** Шапка прогресса: работает ли кто-то из субагентов — ради этого смотрят с телефона. */
const progress = {
  tasks: [
    { text: 'a', status: 'completed' },
    { text: 'b', status: 'in_progress' },
  ],
  agents: [
    { id: '1', kind: 'Explore', description: 'Scan', status: 'running' },
    { id: '2', kind: 'Plan', description: 'Plan', status: 'done' },
    { id: '3', kind: 'Plan', description: 'Fail', status: 'failed' },
  ],
  activeTool: { name: 'Bash', summary: 'ls' },
} as ChatProgress;

describe('progressHead', () => {
  it('идущий прогон: работающие и закончившие субагенты, текущий вызов', () => {
    expect(progressHead(progress, true)).toEqual({
      done: 1,
      total: 2,
      current: 'b',
      running: 1,
      finished: 2,
      activeTool: { name: 'Bash', summary: 'ls' },
    });
  });

  it('законченный прогон: никто не «работает», вызова нет', () => {
    const head = progressHead(progress, false);
    expect(head.running).toBe(0);
    expect(head.finished).toBe(3);
    expect(head.activeTool).toBeUndefined();
  });
});
