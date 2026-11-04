import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../stub-tasks/__fixtures__/e2e/stand.ts';
import type { SessionEconomy } from './adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude/claude.ts';
import { CODEX_CHANNELS, createCodexAdapter } from './codex/codex.ts';
import {
  EventTap,
  hookCommand,
  livePin,
  liveRoot,
  liveSpec,
  type LiveRoot,
} from './conformance/__fixtures__/live.ts';
import { runP81Mode } from './conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from './conformance/__fixtures__/p81-stand.ts';

/**
 * Рычаги экономии на НАСТОЯЩЕМ CLI (s10 p9): не план, а то, что увидел процесс CLI. Модель
 * (stub-model) зовёт оболочку CLI; ответ инструмента в следующем запросе к модели — свидетель:
 * - Claude Code 2.1.310: Bash печатает переменные рычагов (окружение процесса и `settings.env`
 *   доходят до дочерней оболочки) и 20 000 знаков — с `bashOutputMaxChars` 6000 их в ответе меньше,
 *   без рычагов — все;
 * - Codex 0.155.1: `exec_command` печатает 40 000 знаков — с `tool_output_token_limit` (2000)
 *   ответ инструмента короче (замер 02.11: серия 4000 знаков против 5000 со своим пределом 2500),
 *   то есть config.toml дома сеанса прочитан. `model_auto_compact_token_limit` так не виден: отчёт
 *   заглушки об окне выше предела (usage 150k при пределе 100k) сжатия в том же ходе не вызвал.
 * Сравнение всегда с прогоном без рычагов на том же CLI: зелёное без рычага было бы декорацией.
 */

const claudeHere = hasCli(claudeRunFacts.binary.command);
const codexHere = hasCli(codexRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];
let core: FakeCore | undefined;

beforeAll(async () => {
  if (codexHere) core = await startFakeCore();
}, 60_000);

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  await core?.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/** Длина самой длинной серии знака `ch` в тексте (вывод инструмента в теле запроса). */
const longestRun = (text: string, ch: string): number =>
  Math.max(0, ...(text.match(new RegExp(`${ch}+`, 'g')) ?? []).map((s) => s.length));

const LEVERS =
  'echo "W=$CLAUDE_CODE_AUTO_COMPACT_WINDOW R=$CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS T=$CLAUDE_CODE_PROMPT_CACHE_TTL I=$CLAUDE_CODE_AUTO_CONNECT_IDE S=$CLAUDE_CODE_SILENT_TURN_REMINDER"';
const BIG = `node -e "process.stdout.write('y'.repeat(20000))"`;

async function claudeTurn(economy: SessionEconomy | undefined): Promise<string> {
  const live = liveRoot('economy-claude-');
  roots.push(live);
  mkdirSync(join(live.home, '.claude'), { recursive: true });
  writeFileSync(
    join(live.home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash'] } }),
  );
  const stub = await startStubModel({
    script: { steps: [{ tool: { name: 'Bash', args: { command: `${LEVERS}; ${BIG}` } } }, 'DONE'] },
  });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const launched = await adapter.launch(
    liveSpec(live, {
      endpoint: {
        channel: CLAUDE_CHANNELS[0]!,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: 'anthropic-messages',
          model: 'stub-model',
          key: 'BOUND-ROUTE-TOKEN',
        },
      },
      coreHook: hookCommand('core', live.logs.core),
      env: { pin: livePin(live) },
      ...(economy ? { economy } : {}),
    }),
  );
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'run the probe', 'cmd-economy-1');
    const ended = await tap.until((e) => e.type === 'turn.ended', 120_000);
    expect(ended).toMatchObject({ text: 'DONE' });
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  return stub.bodies.at(-1) ?? '';
}

describe.skipIf(!claudeHere)('economy levers on the real Claude Code (s10 p9)', () => {
  it('the child sees every lever: env + settings.env reach Bash, bashOutputMaxChars cuts the output; without levers neither', async () => {
    const levers: SessionEconomy = {
      compactWindow: 160_000,
      bashOutputChars: 6_000,
      readOutputTokens: 3_000,
      cacheTtl: '1h',
      detachIde: true,
      workHabits: true,
    };
    const on = await claudeTurn(levers);
    expect(on).toContain('W=160000 R=3000 T=1h I=false S=0');
    expect(longestRun(on, 'y')).toBeLessThan(20_000);
    const off = await claudeTurn(undefined);
    expect(off).toContain('W= R= T= I= S=');
    expect(longestRun(off, 'y')).toBe(20_000);
  }, 300_000);
});

/** Ход Codex: модель зовёт `exec_command` с большим выводом, затем текст. */
async function codexTurn(
  economy: SessionEconomy | undefined,
): Promise<{ bodies: readonly string[] }> {
  const live = liveRoot('economy-codex-');
  roots.push(live);
  const requests: string[] = [];
  const stub = await startStubModel({
    script: (ctx: { request: { raw: string } }) => {
      requests.push(ctx.request.raw);
      if (!ctx.request.raw.includes('function_call_output'))
        return {
          tool: {
            name: 'exec_command',
            args: { cmd: `node -e "process.stdout.write('z'.repeat(40000))"` },
          },
        };
      return 'DONE';
    },
  });
  stubs.push(stub);
  await runP81Mode({
    live,
    core: core!,
    adapter: createCodexAdapter({ pollMs: 20 }),
    channel: CODEX_CHANNELS[0]!,
    dialect: 'openai-responses',
    baseUrl: stub.baseUrl,
    index: 0,
    mode: {
      name: 'economy',
      over: () => (economy ? { economy } : {}),
      hook: 'core',
      answer: 'all',
    },
    keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
  });
  return { bodies: requests };
}

describe.skipIf(!codexHere)('economy levers on the real Codex (s10 p9)', () => {
  it('tool_output_token_limit cuts the tool output below codex own limit; without levers codex own limit', async () => {
    const on = await codexTurn({ bashOutputChars: 4_000, readOutputTokens: 2_000 });
    const off = await codexTurn(undefined);
    const outOf = (bodies: readonly string[]) =>
      longestRun(bodies.find((b) => b.includes('function_call_output')) ?? '', 'z');
    expect(outOf(off.bodies), 'codex output reached the model').toBeGreaterThan(0);
    expect(outOf(on.bodies)).toBeLessThan(outOf(off.bodies));
  }, 300_000);
});
