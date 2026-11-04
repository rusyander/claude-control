import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import {
  P81_ATTRIBUTION,
  P81_MODES,
  runP81Mode,
  toolTurns,
} from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { createKimiAdapter, KIMI_CHANNELS, KIMI_FILES } from './index.ts';

/**
 * Живой Kimi Code (2.4.1, `kimi acp`) над заглушкой модели openai-chat, P81: `git push` не
 * исполняется ни в одном режиме права переходника. Хук ядра — настоящий (`[[hooks]]` PreToolUse
 * в config.toml сеанса → `run.ts hook` → подставное ядро); `git status` обязан дойти до
 * подставного git там, где он разрешён. Падение хука — отказ: команда хука `… || exit 2`, сам
 * Kimi упавший хук (код ≠ 2) считает разрешением.
 */

const present = hasCli(kimiRunFacts.binary.command);
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('kimi-p81-');
  core = await startFakeCore();
  // Модель: сначала `git status`, затем `git push`, затем текст.
  stub = await startStubModel({
    script: (ctx) => {
      const done = toolTurns(ctx.request.raw);
      if (done === 0) return { tool: { name: 'Bash', args: { command: 'git status' } } };
      if (done === 1) return { tool: { name: 'Bash', args: { command: 'git push origin main' } } };
      return 'P81_DONE';
    },
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

describe.skipIf(!present)(
  'kimi over ACP, P81: git push never runs in any permission mode (live)',
  () => {
    it.each(P81_MODES.map((m, i) => [m.name, m, i] as const))(
      '%s',
      async (_name, mode, index) => {
        core.calls.length = 0;
        const got = await runP81Mode({
          live,
          core,
          adapter: createKimiAdapter({ pollMs: 20 }),
          channel: KIMI_CHANNELS[0]!,
          dialect: 'openai-chat',
          baseUrl: stub.baseUrl,
          index,
          mode,
          keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
        });
        const types = got.seen.map((e) => e.type).join(',');
        if (process.env.P81_DIAG) {
          appendFileSync(
            process.env.P81_DIAG,
            `[kimi p81] ${mode.name}: marker=${JSON.stringify(got.marker)} hook=${JSON.stringify(core.calls)} events=${types}\n${got.stdout}\n`,
          );
        }
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          types,
        ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: 'P81_DONE' });
        if (mode.positive) expect(got.marker, types).toMatch(/status/);
        else if (mode.hook === 'crash') expect(got.marker, types).toBe('');
        expect(got.marker, types).not.toMatch(/push/);
        const results = got.seen.filter((e) => e.type === 'tool.result');
        expect(results, types).toHaveLength(2);
        expect(results[1], types).toMatchObject({ isError: true });
        // Хук ядра видел публикацию словами Kimi (`Bash` + команда как есть) и один её удержал.
        if (mode.hook === 'core' && mode.answer === 'all' && mode.positive) {
          expect(core.calls.map((c) => c.tool)).toContain('Bash');
          expect(core.calls.some((c) => /git push/.test(c.command))).toBe(true);
        }
        expect(readFileSync(join(got.dir, KIMI_FILES.config), 'utf8')).toMatch(/\|\| exit 2"/);
        expect(existsSync(join(live.home, '.kimi-code'))).toBe(false);
      },
      240_000,
    );
  },
);
