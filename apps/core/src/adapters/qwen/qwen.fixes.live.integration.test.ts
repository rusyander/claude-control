import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { newId } from '../../lib/ids/uuidv7.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent } from '../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveFacts,
  liveRoot,
  liveSpec,
} from '../conformance/__fixtures__/live.ts';
import type { ResumeChildConfig, ResumeChildResult } from './__fixtures__/resume-child.ts';
import { createQwenAdapter, QWEN_CHANNELS } from './qwen.ts';

/**
 * core-s2 на живом Qwen Code над заглушкой модели (ключи не тратятся, дом одноразовый):
 * F-14 — бриф с «- y…» доходит до модели системной подсказкой, а не включает yolo;
 * V5 / F-42 — ответ на `can_use_tool`, который ядро не смогло собрать, уходит отказом: CLI не
 * исполняет инструмент и доводит ход до конца, а не ждёт ответа.
 */

const CHILD = fileURLToPath(new URL('./__fixtures__/resume-child.ts', import.meta.url));
const present = hasCli(qwenRunFacts.binary.command);
const live = liveRoot('qwen-fixes-');
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

async function lifetime(cfg: ResumeChildConfig): Promise<ResumeChildResult> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      CHILD,
      Buffer.from(JSON.stringify(cfg)).toString('base64url'),
    ],
    { windowsHide: true, timeout: 150_000 },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  await once(child, 'close');
  const line = stdout.trim().split('\n').pop() ?? '';
  if (!line.startsWith('{')) throw new Error(`child gave no result: ${stderr.slice(-2000)}`);
  return JSON.parse(line) as ResumeChildResult;
}

describe.skipIf(!present)('qwen adapter on the real CLI — core-s2 fixes', () => {
  it('F-14 a brief that starts with "- y" reaches the model as the system prompt, yolo stays off', async () => {
    const stub = await startStubModel({
      script: (ctx) =>
        ctx.request.raw.includes('BRIEF_DASH_MARKER') ? 'BRIEF_SEEN' : 'BRIEF_MISSING',
    });
    stubs.push(stub);
    const result = await lifetime({
      live,
      sessionId: newId(),
      message: 'say anything',
      baseUrl: stub.baseUrl,
      brief: '- y BRIEF_DASH_MARKER: a markdown bullet brief',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ launched: true, text: 'BRIEF_SEEN' });
    expect(result.argv).toContain('--approval-mode');
    expect(result.argv).not.toContain('--yolo');
  }, 200_000);

  it('V5 an unusable permit reply is sent as a deny: the tool does not run and the turn ends', async () => {
    const target = join(live.cwd, 'v5-should-not-exist.txt');
    const stub = await startStubModel({
      script: {
        steps: [
          { tool: { name: 'write_file', args: { file_path: target, content: 'x' } } },
          'AFTER_DENY',
        ],
      },
    });
    stubs.push(stub);
    const channel = QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!;
    const adapter = createQwenAdapter();
    const launched = await adapter.launch(
      liveSpec(live, {
        coreHook: `node ${HOOK_LOG} core --log ${live.logs.core}`,
        permitServer: { name: 'agentdeck-permit', tool: 'approve' },
        endpoint: {
          channel,
          endpoint: {
            baseUrl: stub.baseUrl,
            dialect: 'openai-chat',
            model: 'stub-model',
            key: 'k',
          },
        },
      }),
    );
    if (!launched.ok) throw new Error(launched.reason);
    const tap = new EventTap(adapter, launched.handle);
    try {
      await adapter.send(launched.handle, 'write the file', crypto.randomUUID());
      const ask = (await tap.until((e) => e.type === 'permit.request', 90_000)) as Extract<
        AdapterEvent,
        { type: 'permit.request' }
      >;
      // Сбой кодека ядра: ответа нет (`undefined`) — переходник обязан отказать.
      expect(adapter.answerPermit).toBeTypeOf('function');
      await adapter.answerPermit?.(launched.handle, ask.requestId, undefined);
      const ended = (await tap.until((e) => e.type === 'turn.ended', 90_000)) as Extract<
        AdapterEvent,
        { type: 'turn.ended' }
      >;
      expect(ended.text).toBe('AFTER_DENY');
      expect(existsSync(target)).toBe(false);
    } finally {
      await adapter.stop(launched.handle, 'tree');
    }
  }, 200_000);

  // F-126: доля `\\localhost\C$\…` — тот же файл, что путь диска. Вопрос CLI отвечается «да»,
  // чтобы единственным замком было правило оверлея (судья ядра отказывает и так, второй замок).
  it.skipIf(!present || !/^[A-Za-z]:/.test(live.root))(
    'F-126 the core token read through the admin share of this machine is denied by the CLI rule',
    async () => {
      const facts = liveFacts(live);
      mkdirSync(facts.coreHome, { recursive: true });
      const token = join(facts.coreHome, 'core-token.txt');
      writeFileSync(token, 'TOPSECRET-SHARE');
      const viaShare = `\\\\localhost\\${token[0]!.toUpperCase()}$${token.slice(2)}`;
      const stub = await startStubModel({
        script: {
          steps: [{ tool: { name: 'read_file', args: { file_path: viaShare } } }, 'AFTER_READ'],
        },
      });
      stubs.push(stub);
      const channel = QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!;
      const adapter = createQwenAdapter();
      const launched = await adapter.launch(
        liveSpec(live, {
          coreHook: `node ${HOOK_LOG} core --log ${live.logs.core}`,
          permitServer: { name: 'agentdeck-permit', tool: 'approve' },
          endpoint: {
            channel,
            endpoint: {
              baseUrl: stub.baseUrl,
              dialect: 'openai-chat',
              model: 'stub-model',
              key: 'k',
            },
          },
        }),
      );
      if (!launched.ok) throw new Error(launched.reason);
      const tap = new EventTap(adapter, launched.handle);
      try {
        await adapter.send(launched.handle, 'read the file', crypto.randomUUID());
        for (;;) {
          const event = await tap.until(
            (e) => e.type === 'permit.request' || e.type === 'turn.ended',
            120_000,
          );
          if (event.type === 'turn.ended') break;
          if (event.type !== 'permit.request') continue;
          const input = (event.raw as { input?: Record<string, unknown> }).input ?? {};
          await adapter.answerPermit?.(launched.handle, event.requestId, {
            behavior: 'allow',
            updatedInput: input,
          });
        }
        expect(stub.bodies.length).toBeGreaterThan(1);
        expect(stub.bodies.join('\n')).not.toContain('TOPSECRET-SHARE');
      } finally {
        await adapter.stop(launched.handle, 'tree');
      }
    },
    200_000,
  );
});
