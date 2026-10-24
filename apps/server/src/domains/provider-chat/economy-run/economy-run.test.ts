import { describe, it, expect } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { CODEX_COMPACT_LIMIT_ENV, withCodexKit } from '../../kit/codex.ts';
import { economyRunEnv } from './economy-run.ts';

/**
 * @covers economy-run.ts, codex.ts
 * @scenario порог сжатия группы Codex переехал из `runtime.ts` в канал рычагов
 *   без изменения поведения: та же переменная, тот же ключ `-c` запуска.
 */

const BASE = { env: {}, appData: '/data' };

describe('economy-run', () => {
  it('codex compact env identical to pre-move', () => {
    // До переноса: `env[CODEX_COMPACT_LIMIT_ENV] = String(compactWindow)` при ненулевом окне.
    // Форма входа — как в сборке (`setChildRun` отдаёт закреплённые рычаги связи):
    // рычаги по умолчанию ключа инструментов не дают (codex.test.ts), и запуск
    // ровно как до переноса.
    const env = economyRunEnv('codex', {
      ...BASE,
      economy: GROUP_ECONOMY_DEFAULTS,
      compactWindow: 160_000,
    });
    expect(env).toEqual({ [CODEX_COMPACT_LIMIT_ENV]: '160000' });
    const run = withCodexKit(['exec', '--json', 'prompt'], { ...env, KEEP: '1' }, 'exec');
    expect(run.args).toEqual([
      'exec',
      '-c',
      'model_auto_compact_token_limit=160000',
      '--json',
      'prompt',
    ]);
    expect(run.env).toEqual({ KEEP: '1' });
  });

  it('codex без окна — менять нечего, запуск как был', () => {
    expect(
      economyRunEnv('codex', {
        ...BASE,
        economy: { ...GROUP_ECONOMY_DEFAULTS, bashOutputChars: 0, readOutputTokens: 0 },
      }),
    ).toBeUndefined();
    expect(economyRunEnv('codex', { ...BASE, compactWindow: 0 })).toBeUndefined();
  });

  it('без канала (Claude) и с пустыми каналами — undefined', () => {
    const input = { ...BASE, economy: GROUP_ECONOMY_DEFAULTS, compactWindow: 160_000 };
    expect(economyRunEnv(undefined, input)).toBeUndefined();
    // Qwen свой канал заполнил — его ожидания в `qwen.test.ts`; Goose и Continue —
    // в `goose.test.ts` и `continue.test.ts`. Gemini пуст намеренно (`gemini.ts`).
    expect(economyRunEnv('gemini', input), 'gemini').toBeUndefined();
  });
});
