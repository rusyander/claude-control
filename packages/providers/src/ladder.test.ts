import { describe, expect, it } from 'vitest';
import { tierLadderOf } from './ladder.ts';
import { CLI_RUN_FACTS, cliRunFacts } from './registry.ts';
import type { CliRunFacts } from './types.ts';

const facts = (id: string): CliRunFacts => {
  const got = cliRunFacts(id);
  if (!got) throw new Error(`no facts for ${id}`);
  return got;
};

describe('лестница уровня ядра из фактов CLI', () => {
  it('Claude: алиасы --model от haiku до fable с приставками полных имён, усилие low..max', () => {
    expect(tierLadderOf(facts('claude'))).toEqual({
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      aliases: [['claude-haiku'], ['claude-sonnet'], ['claude-opus'], ['claude-fable']],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('Codex: только усилие — семейства каталога (`modelLadder`) не имена для --model', () => {
    expect(tierLadderOf(facts('codex'))).toEqual({
      models: [],
      aliases: [],
      efforts: ['low', 'medium', 'high'],
    });
  });

  it('CLI без ступеней и без глубины лестницы не имеет (Qwen назван отдельно)', () => {
    expect(tierLadderOf(facts('qwen'))).toBeUndefined();
    const without = CLI_RUN_FACTS.filter((f) => tierLadderOf(f) === undefined).map((f) => f.id);
    expect(without).toEqual([
      'gemini',
      'qwen',
      'continue',
      'goose',
      'kimi',
      'cursor',
      'opencode',
      'aider',
    ]);
  });

  it('ступени модели объявляет только Claude', () => {
    expect(CLI_RUN_FACTS.filter((f) => f.modelRungs).map((f) => f.id)).toEqual(['claude']);
  });
});
