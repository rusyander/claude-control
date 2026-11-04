import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gooseRunFacts } from '@agentdeck/providers/goose';
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
import { createGooseAdapter, GOOSE_CHANNELS, GOOSE_FILES } from './goose.ts';

/**
 * Живой Goose (1.54, `goose acp`) над заглушкой модели, P81: `git push` не исполняется ни в одном
 * режиме права переходника. Хук ядра — настоящий (плагин сеанса → `run.ts hook` → подставное
 * ядро); `git status` обязан дойти до подставного git там, где он разрешён (проверка не пуста).
 * Падение хука — отказ (`on_failure: block`): Goose без этого вызов исполняет.
 */

const present = hasCli(gooseRunFacts.binary.command);
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;
/** Тела запросов к модели: по ним видно, что Goose отдал модели в подсказке и инструментах. */
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('goose-p81-');
  core = await startFakeCore();
  // Модель: сначала `git status`, затем `git push`, затем текст.
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      const done = toolTurns(ctx.request.raw);
      if (done === 0)
        return { tool: { name: 'developer__shell', args: { command: 'git status' } } };
      if (done === 1) {
        return { tool: { name: 'developer__shell', args: { command: 'git push origin main' } } };
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
  'goose adapter on the real CLI — P81 git push refused in every mode',
  () => {
    it.each(P81_MODES.map((m, i) => [m.name, m, i] as const))(
      '%s',
      async (_name, mode, index) => {
        core.calls.length = 0;
        requests.length = 0;
        const got = await runP81Mode({
          live,
          core,
          adapter: createGooseAdapter({ pollMs: 20 }),
          channel: GOOSE_CHANNELS[0]!,
          dialect: 'openai-chat',
          baseUrl: stub.baseUrl,
          index,
          mode,
          // Goose без TEMP и PATHEXT не находит `git.cmd` и не пишет свои временные файлы.
          keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
        });
        const types = got.seen.map((e) => e.type).join(',');
        if (process.env.P81_DIAG) {
          appendFileSync(
            process.env.P81_DIAG,
            `[goose p81] ${mode.name}: marker=${JSON.stringify(got.marker)} hook=${JSON.stringify(core.calls)} events=${types}\n${got.stdout}\n`,
          );
        }
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          types,
        ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: 'P81_DONE' });
        if (mode.positive) expect(got.marker, types).toMatch(/status/);
        else if (mode.hook === 'crash') expect(got.marker, types).toBe('');
        // Публикация не исполнилась ни разу, и судья увидел её неудачей вызова.
        expect(got.marker, types).not.toMatch(/push/);
        const results = got.seen.filter((e) => e.type === 'tool.result');
        expect(results, types).toHaveLength(2);
        expect(results[1], types).toMatchObject({ isError: true });
        // Вопрос о праве Goose задаёт раньше хука: когда он разрешён, хук ядра видел публикацию
        // словами Goose (`shell` + команда как есть) и один её удержал.
        if (mode.hook === 'core' && mode.answer === 'all') {
          expect(core.calls.map((c) => c.tool)).toContain('shell');
          expect(core.calls.some((c) => /git push/.test(c.command))).toBe(true);
        }
        // Корень Goose — свой у сеанса: плагин с хуком там, дом человека не тронут.
        expect(existsSync(join(got.dir, GOOSE_FILES.hooks))).toBe(true);
        expect(readFileSync(join(got.dir, GOOSE_FILES.hooks), 'utf8')).toMatch(
          /"on_failure": "block"/,
        );
        expect(existsSync(join(live.home, '.config', 'goose'))).toBe(false);
        // Дом человека Goose находит через ОС: навыки оттуда не дошли ни до модели (подсказка,
        // `load_skill`, подагенты `delegate`), ни до команд ACP.
        expect(requests.length, types).toBeGreaterThan(0);
        for (const body of requests) {
          expect(body).not.toMatch(/load_skill|"name":"delegate"/);
        }
        expect(got.stdout).not.toContain('"commandType":"Skill"');
      },
      240_000,
    );
  },
);
