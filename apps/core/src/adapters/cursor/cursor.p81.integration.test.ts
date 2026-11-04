import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cursorRunFacts } from '@agentdeck/providers/cursor';
import type { CliAdapter, SessionSpec } from '../adapter.types.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import { P81_ATTRIBUTION, P81_MODES, runP81Mode } from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { installRpcScript } from '../conformance/__fixtures__/rpc-replay.ts';
import { createCursorRpcAdapter, CURSOR_FILES } from './index.ts';

/**
 * Переходник Cursor поверх ACP на ПОДСТАВНОМ CLI (`fake-cursor-agent.mjs`; входа Cursor нет —
 * живой CLI не проверен, и потому в реестре стоит `no_core_hook`), P81: настоящий хук ядра из
 * `hooks.json` сеанса → `run.ts hook` → подставное ядро. Доказывает код переходника: файл хука
 * там, где CLI его ищет (дом сеанса), команда хука рабочая, `failClosed` на месте, вопрос о праве
 * — у судьи; `git push` не исполняется ни в одном режиме. Что настоящий Cursor исполняет хук так
 * же — допущение, его проверит только живой прогон.
 */

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-cursor-agent.mjs', import.meta.url));
let live: LiveRoot;
let core: FakeCore;

beforeAll(async () => {
  live = liveRoot('cursor-p81-');
  core = await startFakeCore();
}, 60_000);

afterAll(async () => {
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/** Канала адреса у Cursor нет: прогон P81 всегда даёт адрес — переходник видит сеанс без него. */
function withoutEndpoint(adapter: CliAdapter): CliAdapter {
  return {
    ...adapter,
    launch: (spec: SessionSpec) => {
      const { endpoint: _drop, ...rest } = spec;
      return adapter.launch(rest);
    },
  };
}

describe('cursor over ACP (fake CLI), P81: git push never runs in any permission mode', () => {
  it.each(P81_MODES.map((m, i) => [m.name, m, i] as const))(
    '%s',
    async (_name, mode, index) => {
      core.calls.length = 0;
      // Тот же каталог, что прогон положит первым в PATH для подставного git.
      installRpcScript(join(live.root, `fakebin-${index}`), cursorRunFacts.binary.command, FAKE);
      const got = await runP81Mode({
        live,
        core,
        adapter: withoutEndpoint(createCursorRpcAdapter({ pollMs: 20 })),
        channel: { via: 'env', dialect: 'openai-chat', keyVar: 'NONE', perSession: true },
        dialect: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9',
        index,
        mode,
        keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'SystemRoot'],
      });
      const types = got.seen.map((e) => e.type).join(',');
      expect(
        got.seen.find((e) => e.type === 'turn.ended'),
        types,
      ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: 'P81_DONE' });
      if (mode.positive) expect(got.marker, types).toMatch(/status/);
      else if (mode.hook === 'crash' || mode.answer === 'none') expect(got.marker, types).toBe('');
      expect(got.marker, types).not.toMatch(/push/);
      const results = got.seen.filter((e) => e.type === 'tool.result');
      expect(results, types).toHaveLength(2);
      expect(results[1], types).toMatchObject({ isError: true });
      // Хук ядра видел публикацию словами Cursor (`Shell` + команда) и один её удержал.
      if (mode.hook === 'core' && mode.answer === 'all' && mode.positive) {
        expect(core.calls.map((c) => c.tool)).toContain('Shell');
        expect(core.calls.some((c) => /git push/.test(c.command))).toBe(true);
      }
      const hooks = JSON.parse(readFileSync(join(got.dir, CURSOR_FILES.hooks), 'utf8')) as {
        hooks: { preToolUse: { failClosed?: boolean }[] };
      };
      expect(hooks.hooks.preToolUse[0]?.failClosed).toBe(true);
      expect(existsSync(join(live.home, '.cursor'))).toBe(false);
    },
    120_000,
  );
});
