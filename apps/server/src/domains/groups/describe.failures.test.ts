import { describe, it, expect, afterEach } from 'vitest';
import {
  describeFailureCount,
  describeIdle,
  describeOrQueue,
  resetDescribeFailures,
  type Describer,
} from './describe.ts';
import type { DescribeSource } from './describe.ts';

/**
 * Ревью 28.09 (F-220): память неудач описания (`failedAt`) ключуется хэшем
 * текста и не чистилась — каждая правка текста, чьё описание упало, оставляла
 * запись навсегда.
 */

afterEach(() => resetDescribeFailures());

const source = (hash: string): DescribeSource => ({
  key: 'global|skill:a',
  kind: 'skill',
  id: 'a',
  text: `text ${hash}`,
  hash,
  steps: [],
});

describe('describeOrQueue: память неудач', () => {
  it('просроченная неудача уходит, а не копится по хэшам', async () => {
    let clock = 0;
    const describer: Describer = {
      appData: 'X:/no-such-appdata',
      ask: async () => {
        throw new Error('model down');
      },
      prompt: 'p',
      now: () => clock,
    };
    describeOrQueue(describer, {}, source('h1'));
    await describeIdle();
    expect(describeFailureCount()).toBe(1);
    clock = 11 * 60_000;
    describeOrQueue(describer, {}, source('h2'));
    await describeIdle();
    expect(describeFailureCount()).toBe(1);
  });
});
