import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexRunFacts } from '@agentdeck/providers/codex';
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
import { CODEX_CHANNELS, createCodexAdapter } from './codex.ts';
import { findCodexRollout } from './transcript.ts';

/**
 * Живое продолжение нити Codex (codex-cli 0.155.1) над заглушкой модели: вторая сессия видит
 * прежний разговор в запросе к модели. Оба пути: продолжение прежней сессии ядра (`resume.from`) и
 * разговор человека (копия одного файла из его CODEX_HOME — сам файл не меняется). Чужой корень и
 * подложный id — отказ до запуска процесса.
 */

const present = hasCli(codexRunFacts.binary.command);
const MARK = 'REMEMBER_ALPHA_42';
let live: LiveRoot;
let stub: StubModel;
let stand: ResumeStand;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('codex-resume-');
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      return `REPLY_${requests.length}`;
    },
  });
  stand = {
    live,
    channel: CODEX_CHANNELS[0]!,
    dialect: 'openai-responses',
    baseUrl: stub.baseUrl,
  };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const turn = (spec: SessionSpec, text: string) =>
  resumeTurn(createCodexAdapter({ pollMs: 20 }), spec, text, requests);

describe.skipIf(!present)('codex resume on the real CLI over stub-model', () => {
  let first: SessionSpec;
  let thread = '';

  it('a new session persists its thread in its own CODEX_HOME', async () => {
    first = resumeSpec(stand);
    const got = await turn(first, MARK);
    thread = got.conversationId;
    expect(got.ended).toMatchObject({ type: 'turn.ended', isError: false });
    expect(findCodexRollout(join(first.dir, 'codex-home'), live.cwd, thread).verdict).toBe('owned');
  }, 240_000);

  it('continuation of the prior core session: the resumed turn sees the earlier message', async () => {
    const next = resumeSpec(stand, { resume: { conversationId: thread, from: first.dir } });
    const got = await turn(next, 'what did I say?');
    expect(got.conversationId).toBe(thread);
    expect(got.ended).toMatchObject({ isError: false });
    expect(got.seen.length).toBeGreaterThan(0);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
  }, 240_000);

  it('adoption from the human CODEX_HOME: one file copied, the human store unchanged', async () => {
    const human = join(live.root, 'human-codex');
    mkdirSync(human, { recursive: true });
    cpSync(join(first.dir, 'codex-home', 'sessions'), join(human, 'sessions'), { recursive: true });
    const found = findCodexRollout(human, live.cwd, thread);
    const before = {
      text: readFileSync(found.file!, 'utf8'),
      mtime: statSync(found.file!).mtimeMs,
    };
    const adopted = resumeSpec(stand, {
      env: { pin: resumePin(stand, { CODEX_HOME: human }) },
      resume: { conversationId: thread },
    });
    const got = await turn(adopted, 'and now?');
    expect(got.conversationId).toBe(thread);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
    // Хранилище человека не тронуто: ни строки, ни времени записи; сеанс писал в свою копию.
    expect(readFileSync(found.file!, 'utf8')).toBe(before.text);
    expect(statSync(found.file!).mtimeMs).toBe(before.mtime);
    expect(existsSync(join(adopted.dir, 'codex-home', 'sessions', found.rel!))).toBe(true);
    expect(existsSync(join(human, 'config.toml'))).toBe(false);
  }, 240_000);

  it('another root or a forged id is refused before spawn (no session dir)', async () => {
    const elsewhere = join(live.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const adapter = createCodexAdapter({ pollMs: 20 });
    for (const over of [
      { cwd: elsewhere, resume: { conversationId: thread, from: first.dir } },
      { resume: { conversationId: crypto.randomUUID(), from: first.dir } },
    ]) {
      const spec = resumeSpec(stand, over);
      const got = await adapter.launch(spec);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(spec.dir)).toBe(false);
    }
  }, 60_000);
});
