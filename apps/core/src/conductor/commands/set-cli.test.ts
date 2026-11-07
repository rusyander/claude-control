import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import {
  API_KEY,
  envelope,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
  QWEN,
} from '../scenario/__fixtures__/scenario-harness.ts';

/**
 * W3-17a: `set-cli` судит переходник судом совместимости РАНЬШЕ набора. Без контура набор задачи —
 * маршруты входа CLI, и у aider/continue (`gateless.ts`, `cliLogin: false`) их нет: прежде команда
 * отказывала «вне набора», и человек не видел, что CLI без судьи ядра. Реестр переходников — тот
 * же, что даёт загрузка (`boot-api.ts` → `adapterOf`), возможности — настоящие.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const registry = createAdapterRegistry();
const env = () => ({ ...commandEnv(), adapterOf: (id: string) => registry.get(id) });

async function task() {
  const got = await homeTask({ allowedRoutes: [API_KEY, LOGIN, QWEN], modelCeiling: null });
  open.push(got.task);
  return got.task;
}

const setCli = (t: LiveTask, adapter: string) =>
  processCommand(
    t,
    envelope(t, 'set-cli', { scope: 'task', scopeId: t.taskId, adapter, timing: 'now' }),
    HUMAN_PROOF,
    env(),
  );

describe('set-cli: compat court before the allowed set (W3-17a)', () => {
  it.each(['aider', 'continue'])(
    '%s outside the set → refused no_core_hook (court code), no override line',
    async (cli) => {
      const t = await task();
      const got = await setCli(t, cli);
      expect(got).toMatchObject({ status: 'rejected', code: 'no_core_hook' });
      if (got.status === 'rejected')
        expect(got.reason).toBe(
          `compat refused: no_core_hook — ${cli} has neither a pre-tool hook nor a deny overlay`,
        );
      expect(t.state.overrides).toEqual([]);
      const lines = readJournalLines(t.dir, t.taskId).lines;
      expect(lines.filter((l) => l.kind === 'command.rejected').map((l) => l.data)).toEqual([
        expect.objectContaining({ code: 'no_core_hook' }),
      ]);
    },
  );

  it('codex passes the court (pre-tool hook) but sits outside the set → still outside-allowed-set', async () => {
    const t = await task();
    expect(registry.get('codex')?.caps.preToolHooks).toBe(true);
    const got = await setCli(t, 'codex');
    expect(got).toMatchObject({ status: 'rejected', code: 'outside-allowed-set' });
    expect(t.state.overrides).toEqual([]);
  });

  it('qwen passes the court and is in the set → applied', async () => {
    const t = await task();
    const got = await setCli(t, 'qwen');
    expect(got).toMatchObject({ status: 'applied', outcome: { adapter: 'qwen' } });
  });

  it('no adapter port (tests, older wiring) → only the set judges, as before', async () => {
    const t = await task();
    const got = await processCommand(
      t,
      envelope(t, 'set-cli', { scope: 'task', scopeId: t.taskId, adapter: 'aider', timing: 'now' }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({ status: 'rejected', code: 'outside-allowed-set' });
  });
});
