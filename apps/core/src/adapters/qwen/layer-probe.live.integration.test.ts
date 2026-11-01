import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent } from '../adapter.types.ts';
import {
  EventTap,
  liveRoot,
  liveSpec,
  readJsonLines,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { createQwenAdapter, QWEN_CHANNELS } from './qwen.ts';

/**
 * Проба Q7 этапа 7 на живом Qwen Code 0.24.3 над заглушкой модели (одноразовые дом и `~/.qwen`):
 * - слоем Qwen ядро не управляет: `observe` идёт `on`, и это названо (G3);
 * - хуки человека исполняет сам CLI: UserPromptSubmit (метка платформы в `prompt` байт в байт),
 *   PreToolUse; хук ядра — тоже;
 * - отказ хука человека (код 2) в потоке неотличим от ошибки инструмента — `hook.refused` не
 *   издаётся (переходник без чтения отказов, назван в `SdkRule.hookRefusals`).
 * Команда хука — голыми словами: Qwen исполняет её через `cmd` без кавычек.
 * Нет `qwen` в PATH — пропуск с причиной.
 */

const present = hasCli(qwenRunFacts.binary.command);
const HOOK = fileURLToPath(new URL('../claude/__fixtures__/layer-hook.mjs', import.meta.url));
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

describe.skipIf(!present)('stage 7 layer probe on the real qwen CLI (live)', () => {
  it('Q7 observe runs on (named); user hooks run by the CLI see the marker; a user deny is no hook.refused', async () => {
    const live = liveRoot('q7-');
    roots.push(live);
    const log = join(live.root, 'hooks.jsonl');
    const hook = (role: string, mode: string) => `node ${HOOK} ${role} ${log} ${mode}`;
    mkdirSync(join(live.home, '.qwen'), { recursive: true });
    writeFileSync(
      join(live.home, '.qwen', 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('ups', 'allow') }] }],
          PreToolUse: [
            { matcher: 'read_file', hooks: [{ type: 'command', command: hook('user', 'exit2') }] },
          ],
        },
      }),
    );
    writeFileSync(join(live.cwd, 'a.txt'), 'hello\n');
    const stub = await startStubModel({
      script: (ctx) =>
        ctx.info.tools.length === 0
          ? 'side'
          : ctx.info.hasToolResult
            ? 'DONE'
            : { tool: { name: 'read_file', args: { file_path: join(live.cwd, 'a.txt') } } },
    });
    stubs.push(stub);
    const adapter = createQwenAdapter();
    const spec = liveSpec(live, {
      layer: { hooks: 'observe', skills: 'on' },
      coreHook: hook('core', 'allow'),
      endpoint: {
        channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
        endpoint: { baseUrl: stub.baseUrl, dialect: 'openai-chat', model: 'stub-model', key: 'k' },
      },
    });
    const launched = await adapter.launch(spec);
    if (!launched.ok) throw new Error(launched.reason);
    expect(launched.layer).toMatchObject({ asked: 'observe', ran: 'on' });
    expect(launched.layer.detail).toContain('qwen: no layer control');
    const tap = new EventTap(adapter, launched.handle);
    const cmdId = crypto.randomUUID();
    try {
      await adapter.send(launched.handle, 'HUMAN_WORD', cmdId, 'human');
      await tap.until((e) => e.type === 'turn.ended' && e.attribution === cmdId, 120_000);
    } finally {
      await adapter.stop(launched.handle, 'tree');
    }
    const hooks = readJsonLines(log) as { role: string; input: Record<string, unknown> }[];
    expect([...new Set(hooks.map((h) => h.role))].sort()).toEqual(['core', 'ups', 'user']);
    expect(hooks.filter((h) => h.role === 'ups').map((h) => h.input.prompt)).toContain(
      '<!-- agentdeck:platform -->\nagentdeck-from: human\nHUMAN_WORD',
    );
    const events: AdapterEvent[] = tap.seen;
    expect(events.some((e) => e.type === 'tool.result' && e.isError)).toBe(true);
    expect(events.filter((e) => e.type === 'hook.refused')).toEqual([]);
  }, 600_000);
});
