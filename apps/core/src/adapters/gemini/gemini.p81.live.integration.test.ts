import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import { P81_ATTRIBUTION, P81_MODES, runP81Mode } from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { createGeminiAdapter, GEMINI_CHANNELS, GEMINI_FILES } from './index.ts';

/**
 * Живой Gemini CLI (0.66, `gemini --acp`) над заглушкой модели google-genai, P81: `git push` не
 * исполняется ни в одном режиме права переходника. Хука до вызова в режиме ACP у Gemini нет
 * (проба 02.11: `BeforeTool` из settings под `--acp` не зовётся) — публикацию держит файл политики
 * сеанса (оверлей запретов ядра), а `git status` в разрешённых режимах обязан дойти до
 * подставного git (проверка не пуста). Режимы с хуком ядра здесь — те же режимы права: хук
 * переходник не ставит, поэтому «упавший хук» ничего не меняет и `git status` там исполняется.
 */

const present = hasCli(geminiRunFacts.binary.command);
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;

/** Сколько ответов инструментов уже в запросе google-genai. */
const functionResponses = (raw: string): number => (raw.match(/"functionResponse"/g) ?? []).length;

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('gemini-p81-');
  core = await startFakeCore();
  // Модель: сначала `git status`, затем `git push`, затем текст.
  stub = await startStubModel({
    script: (ctx) => {
      const done = functionResponses(ctx.request.raw);
      if (done === 0)
        return { tool: { name: 'run_shell_command', args: { command: 'git status' } } };
      if (done === 1)
        return { tool: { name: 'run_shell_command', args: { command: 'git push origin main' } } };
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
  'gemini over ACP, P81: git push never runs in any permission mode (live)',
  () => {
    it.each(P81_MODES.map((m, i) => [m.name, m, i] as const))(
      '%s',
      async (_name, mode, index) => {
        core.calls.length = 0;
        const got = await runP81Mode({
          live,
          core,
          adapter: createGeminiAdapter({ pollMs: 20 }),
          channel: GEMINI_CHANNELS[0]!,
          dialect: 'google-genai',
          baseUrl: stub.baseUrl,
          index,
          mode,
          keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
        });
        const types = got.seen.map((e) => e.type).join(',');
        if (process.env.P81_DIAG) {
          appendFileSync(
            process.env.P81_DIAG,
            `[gemini p81] ${mode.name}: marker=${JSON.stringify(got.marker)} events=${types}\n${got.stdout}\n`,
          );
        }
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          types,
        ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: 'P81_DONE' });
        // Свои `git rev-parse` CLI делает сам при старте (поиск корня) — это не вызов модели.
        const marker = got.marker
          .split('\n')
          .filter((line) => line && !line.startsWith('rev-parse '))
          .join('\n');
        // Хука нет: `git status` идёт везде, где вопрос о праве разрешён (и при «упавшем хуке»).
        if (mode.positive || mode.hook === 'crash') expect(marker, types).toMatch(/status/);
        else expect(marker, types).toBe('');
        expect(got.marker, types).not.toMatch(/push/);
        const results = got.seen.filter((e) => e.type === 'tool.result');
        if (mode.name === 'read-only session') {
          // Политика закрыла оболочку по имени: CLI отказывает вызову внутри себя, строки
          // tool_call в потоке ACP нет (живой прогон 02.11) — успешного результата тоже.
          expect(
            results.filter((e) => e.type === 'tool.result' && !e.isError),
            types,
          ).toEqual([]);
        } else {
          expect(results, types).toHaveLength(2);
          expect(results[1], types).toMatchObject({ isError: true });
        }
        // Хук ядра не звался ни разу: переходник его не ставит, защита — политика.
        expect(core.calls).toEqual([]);
        expect(readFileSync(join(got.dir, GEMINI_FILES.policy), 'utf8')).toContain(
          'commandPrefix = "git push"',
        );
        expect(existsSync(join(live.home, '.gemini'))).toBe(false);
      },
      240_000,
    );
  },
);
