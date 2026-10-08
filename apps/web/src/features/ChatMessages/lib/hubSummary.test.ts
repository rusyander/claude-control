import { describe, expect, it } from 'vitest';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { hubBucket } from './hubBucket';
import { summarizeHub } from './summarizeHub';

function row(extra: Partial<ChildStageGroup>): ChildStageGroup {
  return { chatId: '', title: 'группа', stages: [], isRunning: false, ...extra };
}

describe('hubBucket: строки без чата — в свои корзины', () => {
  it('подготовка копии — «идёт»: место занято, прогон вот-вот пойдёт', () => {
    expect(hubBucket(row({ pending: 'setup' }))).toBe('running');
  });

  it('оборвана до своего чата — «ждёт вас»: сама не продолжится', () => {
    expect(hubBucket(row({ pending: 'interrupted' }))).toBe('ask');
  });

  it('пауза без чата — не очередь, а остановленная', () => {
    expect(hubBucket(row({ pending: 'paused' }))).toBe('idle');
  });

  it('обычная очередь осталась очередью', () => {
    expect(hubBucket(row({ pending: 'queued' }))).toBe('queued');
  });

  it('счётчики сводки — по тем же корзинам', () => {
    const { counts } = summarizeHub(
      [row({ pending: 'setup' }), row({ pending: 'interrupted' }), row({ pending: 'paused' })],
      0,
    );
    expect(counts).toMatchObject({ running: 1, ask: 1, idle: 1, queued: 0 });
  });
});
