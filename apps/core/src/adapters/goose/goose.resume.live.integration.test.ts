import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { SessionSpec } from '../adapter.types.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import {
  resumePin,
  resumeSpec,
  resumeTurn,
  type ResumeStand,
} from '../conformance/__fixtures__/resume-run.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from './goose.ts';
import { copyGooseSession, findGooseSession, gooseSessionDb } from './transcript.ts';

/**
 * Живое продолжение разговора Goose (1.54, `goose acp` → `session/load`) над заглушкой модели:
 * вторая сессия видит прежний разговор в запросе к модели, проигрыш истории не становится ходом.
 * Оба пути: прежняя сессия ядра (`resume.from`) и база человека (в копию идёт только этот
 * разговор, сама база не меняется). Чужой корень и подложный id — отказ до запуска процесса.
 */

const present = hasCli(gooseRunFacts.binary.command);
const MARK = 'REMEMBER_ALPHA_42';
let live: LiveRoot;
let stub: StubModel;
let stand: ResumeStand;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('goose-resume-');
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      return `REPLY_${requests.length}`;
    },
  });
  stand = {
    live,
    channel: GOOSE_CHANNELS[0]!,
    dialect: 'openai-chat',
    baseUrl: stub.baseUrl,
    // Goose без TEMP и PATHEXT не пишет свои временные файлы (как в P81-прогоне).
    keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
  };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const turn = (spec: SessionSpec, text: string) =>
  resumeTurn(createGooseAdapter({ pollMs: 20 }), spec, text, requests);

describe.skipIf(!present)('goose resume on the real CLI over stub-model', () => {
  let first: SessionSpec;
  let conversation = '';

  it('a new session keeps its conversation in its own goose-home database', async () => {
    first = resumeSpec(stand);
    const got = await turn(first, MARK);
    conversation = got.conversationId;
    expect(got.ended).toMatchObject({ type: 'turn.ended', isError: false });
    expect(findGooseSession(gooseSessionDb(first.dir), live.cwd, conversation)).toBe('owned');
  }, 240_000);

  it('continuation of the prior core session: the resumed turn sees the earlier message', async () => {
    const next = resumeSpec(stand, { resume: { conversationId: conversation, from: first.dir } });
    const got = await turn(next, 'what did I say?');
    expect(got.conversationId).toBe(conversation);
    expect(got.ended).toMatchObject({ isError: false, text: `REPLY_${requests.length}` });
    expect(got.seen.length).toBeGreaterThan(0);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
  }, 240_000);

  it('adoption from the human goose store: one conversation copied, the human database unchanged', async () => {
    const human = join(live.root, 'human-goose');
    mkdirSync(human, { recursive: true });
    const humanDb = join(human, 'data', 'sessions', 'sessions.db');
    copyGooseSession(gooseSessionDb(first.dir), humanDb, conversation);
    const before = { bytes: readFileSync(humanDb), mtime: statSync(humanDb).mtimeMs };
    const adopted = resumeSpec(stand, {
      env: { pin: resumePin(stand, { GOOSE_PATH_ROOT: human }) },
      resume: { conversationId: conversation },
    });
    const got = await turn(adopted, 'and now?');
    expect(got.conversationId).toBe(conversation);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
    expect(readFileSync(humanDb).equals(before.bytes)).toBe(true);
    expect(statSync(humanDb).mtimeMs).toBe(before.mtime);
    expect(findGooseSession(gooseSessionDb(adopted.dir), live.cwd, conversation)).toBe('owned');
  }, 240_000);

  it('another root or a forged id is refused before spawn (no session dir)', async () => {
    const elsewhere = join(live.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const adapter = createGooseAdapter({ pollMs: 20 });
    for (const over of [
      { cwd: elsewhere, resume: { conversationId: conversation, from: first.dir } },
      { resume: { conversationId: '20261102_999', from: first.dir } },
    ]) {
      const spec = resumeSpec(stand, over);
      const got = await adapter.launch(spec);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(spec.dir)).toBe(false);
    }
  }, 60_000);
});
