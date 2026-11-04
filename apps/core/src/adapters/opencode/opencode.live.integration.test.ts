import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
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
import { createOpencodeAdapter, OPENCODE_CHANNELS, OPENCODE_FILES } from './opencode.ts';

/**
 * Живой opencode (1.18, `opencode acp`) над заглушкой модели, P81: `git push` не исполняется ни в
 * одном режиме права переходника. Хук ядра — настоящий (плагин сеанса `tool.execute.before` →
 * `run.ts hook --json` → подставное ядро); `git status` обязан дойти до подставного git там, где
 * он разрешён (проверка не пуста). Хук не запустился — отказ (плагин fail-closed).
 */

const present = hasCli(opencodeRunFacts.binary.command);
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('opencode-p81-');
  core = await startFakeCore();
  // Модель: сначала `git status`, затем `git push`, затем текст.
  stub = await startStubModel({
    script: (ctx) => {
      const done = toolTurns(ctx.request.raw);
      if (done === 0) {
        return { tool: { name: 'bash', args: { command: 'git status', description: 'status' } } };
      }
      if (done === 1) {
        return {
          tool: { name: 'bash', args: { command: 'git push origin main', description: 'publish' } },
        };
      }
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
  'opencode adapter on the real CLI — P81 git push refused in every mode',
  () => {
    it.each(P81_MODES.map((m, i) => [m.name, m, i] as const))(
      '%s',
      async (_name, mode, index) => {
        core.calls.length = 0;
        const got = await runP81Mode({
          live,
          core,
          adapter: createOpencodeAdapter({ pollMs: 20 }),
          channel: OPENCODE_CHANNELS[0]!,
          dialect: 'openai-chat',
          baseUrl: stub.baseUrl,
          index,
          mode,
          // opencode без PATHEXT не находит `git.cmd`; TEMP — его временные файлы.
          keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
        });
        const types = got.seen.map((e) => e.type).join(',');
        if (process.env.P81_DIAG) {
          appendFileSync(
            process.env.P81_DIAG,
            `[opencode p81] ${mode.name}: marker=${JSON.stringify(got.marker)} hook=${JSON.stringify(core.calls)} events=${types}\n${got.stdout}\n`,
          );
        }
        const readOnly = /read-only/.test(mode.name);
        // Отказ на вопрос о праве opencode 1.18 останавливает ход (дальше модель не зовётся):
        // ход закрыт своим ответом, но без текста модели.
        const halted = mode.answer === 'none' || mode.hook === 'allow-all';
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          types,
        ).toMatchObject({
          attribution: P81_ATTRIBUTION,
          isError: false,
          ...(halted ? {} : { text: 'P81_DONE' }),
        });
        if (mode.positive) expect(got.marker, types).toMatch(/status/);
        else if (mode.hook === 'crash' || readOnly || mode.answer === 'none') {
          expect(got.marker, types).toBe('');
        }
        // Публикация не исполнилась ни разу.
        expect(got.marker, types).not.toMatch(/push/);
        const results = got.seen.filter((e) => e.type === 'tool.result');
        expect(results.length, types).toBeGreaterThan(0);
        if (readOnly) {
          // `bash: deny` снимает инструмент: вызов модели opencode исполняет как `invalid`
          // (поток ACP по-прежнему называет его `bash`, хук ядра видит `invalid`).
          expect(core.calls.length, types).toBeGreaterThan(0);
          expect(new Set(core.calls.map((c) => c.tool)), types).toEqual(new Set(['invalid']));
        } else {
          // Удержанный вызов судья видит неудачей.
          expect(results.at(-1), types).toMatchObject({ isError: true });
        }
        // Хук opencode зовёт раньше вопроса о праве: хук ядра видел публикацию словами
        // opencode (`bash` + команда как есть) и один её удержал.
        if (mode.hook === 'core' && mode.answer !== 'none' && !readOnly) {
          expect(core.calls.map((c) => c.tool)).toContain('bash');
          expect(core.calls.some((c) => /git push/.test(c.command))).toBe(true);
        }
        // Дома opencode — свои у сеанса: конфиг с плагином там, дом человека не тронут.
        const config = readFileSync(join(got.dir, OPENCODE_FILES.config), 'utf8');
        expect(config).toMatch(/agentdeck-core-hook\.mjs/);
        expect(existsSync(join(got.dir, OPENCODE_FILES.plugin))).toBe(true);
        expect(existsSync(join(live.home, '.config', 'opencode'))).toBe(false);
        expect(existsSync(join(live.home, '.local', 'share', 'opencode'))).toBe(false);
      },
      240_000,
    );
  },
);
