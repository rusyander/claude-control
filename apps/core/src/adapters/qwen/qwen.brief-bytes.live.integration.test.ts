import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import { runP81Mode } from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { createQwenAdapter, QWEN_CHANNELS } from './qwen.ts';

/**
 * Бриф сеанса доходит до модели байт в байт (F3: «•» U+2022 в брифе виделся как BEL в командной
 * строке процесса qwen). Настоящий Qwen Code, модель — stub-model: в системном промпте запроса
 * модели — каждый символ брифа (кириллица, «•», «—», эмодзи вне BMP), ни одного управляющего.
 */

const BRIEF = 'BRIEF_START • пункт — второй « » ✓ 𝄞 BRIEF_END';
const present = hasCli(qwenRunFacts.binary.command);
const channel = QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat');
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('qwen-brief-');
  core = await startFakeCore();
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      return 'BRIEF_SEEN';
    },
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/** Системный текст запроса openai-chat: сообщения `system`/`developer`, содержимое строкой. */
function systemText(raw: string): string {
  const body = JSON.parse(raw) as { messages?: { role: string; content: unknown }[] };
  return (body.messages ?? [])
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe.skipIf(!present || !channel)('qwen on the real CLI — brief bytes (F3)', () => {
  it('the brief reaches the model system prompt unchanged: U+2022 stays «•», no control chars', async () => {
    const got = await runP81Mode({
      live,
      core,
      adapter: createQwenAdapter({ pollMs: 20 }),
      channel: channel!,
      dialect: 'openai-chat',
      baseUrl: stub.baseUrl,
      index: 0,
      keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
      mode: {
        name: 'brief bytes',
        over: () => ({ brief: BRIEF, tools: 'none' }),
        hook: 'core',
        answer: 'all',
      },
    });
    const seen = got.seen.map((e) => e.type).join(',');
    expect(requests.length, seen).toBeGreaterThan(0);
    const system = systemText(requests[0]!);
    const at = system.indexOf('BRIEF_START');
    expect(at, system.slice(0, 2000)).toBeGreaterThan(-1);
    const brief = system.slice(at, system.indexOf('BRIEF_END', at) + 'BRIEF_END'.length);
    expect(brief).toBe(BRIEF);
    // Управляющие символы, кроме \t \n \r: BEL на месте «•» — дефект F3.
    const control = [...system].filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    });
    expect(control.map((ch) => ch.codePointAt(0))).toEqual([]);
  }, 240_000);
});
