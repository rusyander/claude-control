import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBridge, STATE_MODE } from './main.ts';

/**
 * Режим `run.ts state` (этап 7): разводка `runBridge` ведёт в тело `agentdeck state`
 * (`mcp/state-cli.ts`), отказа волны 0 «not built» больше нет. Тело команды судит свой разбор:
 * чужая подкоманда — код 2 с подсказкой, а не пустое состояние. Режим `recorder` проверяют тесты
 * записи хуков (`adapters/layer-run`), здесь он не зовётся: читает stdin.
 */

const argv = process.argv;

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe('stage 7 run.ts modes', () => {
  it('state routes to the agentdeck state body: a foreign subcommand is exit 2 with usage, never "not built"', async () => {
    const said: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    process.argv = [argv[0]!, 'run.ts', STATE_MODE, 'bogus'];
    expect(await runBridge(STATE_MODE)).toBe(2);
    const text = said.join('');
    expect(text).toContain('usage: agentdeck state');
    expect(text).not.toContain('not built');
  });
});
