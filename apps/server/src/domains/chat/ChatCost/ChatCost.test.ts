import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { createStepCost } from './ChatCost.ts';

/**
 * Цена шага у ответа из транскрипта — то, что лента показывает после конца хода.
 * Живой прогон 08.10: у ответа локальной Qwen стояло «$0.0814» — ставка Sonnet,
 * подставленная модели, которая не стоит ничего.
 */
const answer = (model: string): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  blocks: [{ type: 'text', text: '391' }] as ChatMessage['blocks'],
  timestamp: '2026-10-08T10:00:00.000Z',
  usage: { input: 27_000, output: 23, cacheRead: 0, cacheCreation: 0, model },
});

describe('createStepCost', () => {
  const withCost = createStepCost(() => ({}));

  it('локальная модель без цены — ответ без цены', () => {
    expect(withCost(answer('qwen3.6:27b-coding')).usage).not.toHaveProperty('costUsd');
  });

  it('модель Claude — цена по её тарифу', () => {
    expect(withCost(answer('claude-opus-4-8')).usage?.costUsd).toBeGreaterThan(0);
  });
});
