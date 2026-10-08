import { describe, expect, it } from 'vitest';
import { generationSpeed } from './generation-speed';

const usage = { input: 10, output: 112, cacheRead: 0, cacheCreation: 0 };

describe('generationSpeed', () => {
  it('локальная модель: выход за время генерации', () => {
    expect(generationSpeed({ ...usage, model: 'qwen3.6:27b-coding', genMs: 1000 })).toBe(112);
    expect(generationSpeed({ ...usage, model: 'qwen3.6:27b-coding', genMs: 4000 })).toBe(28);
  });

  it('облачный Claude — без скорости', () => {
    expect(generationSpeed({ ...usage, model: 'claude-opus-5-5', genMs: 1000 })).toBeUndefined();
  });

  it('нет времени, нет модели или пара токенов — без скорости, а не ноль', () => {
    expect(generationSpeed({ ...usage, model: 'qwen3.6:27b-coding' })).toBeUndefined();
    expect(generationSpeed({ ...usage, genMs: 1000 })).toBeUndefined();
    expect(
      generationSpeed({ ...usage, output: 3, model: 'qwen3.6:27b-coding', genMs: 10 }),
    ).toBeUndefined();
  });
});
