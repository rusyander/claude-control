import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { newId } from '../../lib/ids/uuidv7.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot } from '../conformance/__fixtures__/live.ts';
import type { ResumeChildConfig, ResumeChildResult } from './__fixtures__/resume-child.ts';
import { qwenSessionId } from './session-id.ts';

/**
 * Живой Qwen Code над заглушкой модели (ключи не тратятся): id сеанса ядра — UUIDv7, CLI
 * принимает только v1–5. Каждая «жизнь ядра» — свой процесс со своим переходником: второй
 * процесс знает лишь id сеанса ядра (то, что лежит в журнале), и возобновление по нему находит
 * ТОТ ЖЕ разговор CLI — модель видит ответ первого хода в истории.
 */

const CHILD = fileURLToPath(new URL('./__fixtures__/resume-child.ts', import.meta.url));
const present = hasCli(qwenRunFacts.binary.command);
const live = liveRoot('qwen-resume-');
let stub: StubModel | undefined;

afterAll(async () => {
  await stub?.close();
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/** Процесс асинхронно: заглушка модели живёт в цикле событий теста, `spawnSync` её усыпил бы. */
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

describe.skipIf(!present)('qwen adapter on the real CLI — session id and resume', () => {
  it('a core UUIDv7 session starts; a new process resumes by the core id alone and the model sees the first turn', async () => {
    stub = await startStubModel({
      script: (ctx) => {
        if (!ctx.request.raw.includes('SECOND_MARKER')) return 'ANSWER_ONE';
        return ctx.request.raw.includes('ANSWER_ONE') ? 'HISTORY_SEEN' : 'HISTORY_MISSING';
      },
    });
    const coreId = newId();
    const first = await lifetime({
      live,
      sessionId: coreId,
      message: 'FIRST_MARKER say anything',
      baseUrl: stub.baseUrl,
    });
    expect(first, JSON.stringify(first)).toMatchObject({ launched: true, text: 'ANSWER_ONE' });
    // Разговор CLI назван производным id: тем, что ядро передало, и тем, что выводится снова.
    expect(first.conversationId).toBe(qwenSessionId(coreId));
    expect(first.argv).toContain(qwenSessionId(coreId));

    // «Перезапуск ядра»: другой процесс, другой сеанс ядра, возобновление по id из журнала.
    const second = await lifetime({
      live,
      sessionId: newId(),
      resume: coreId,
      message: 'SECOND_MARKER what did you answer',
      baseUrl: stub.baseUrl,
    });
    expect(second, JSON.stringify(second)).toMatchObject({
      launched: true,
      text: 'HISTORY_SEEN',
      conversationId: qwenSessionId(coreId),
    });
  }, 360_000);
});
