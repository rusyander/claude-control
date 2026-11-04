import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
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
import { createKimiAdapter, KIMI_CHANNELS } from './index.ts';
import { findKimiSession, KIMI_HOME_DIR } from './transcript.ts';

/**
 * Живое продолжение разговора Kimi Code (2.4.1, `kimi acp` → `session/load`) над заглушкой модели
 * (контейнер `tools/core-linux.mjs --clis`): вторая сессия видит прежний разговор в запросе к
 * модели. Оба пути: прежняя сессия ядра (`resume.from`) и дом человека (копия каталога одного
 * разговора и указателя с его строкой; дом человека не меняется). Чужой корень и подложный id —
 * отказ до запуска процесса.
 */

const present = hasCli(kimiRunFacts.binary.command);
const MARK = 'REMEMBER_ALPHA_42';
let live: LiveRoot;
let stub: StubModel;
let stand: ResumeStand;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('kimi-resume-');
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      return `REPLY_${requests.length}`;
    },
  });
  stand = { live, channel: KIMI_CHANNELS[0]!, dialect: 'openai-chat', baseUrl: stub.baseUrl };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const turn = (spec: SessionSpec, text: string) =>
  resumeTurn(createKimiAdapter({ pollMs: 20 }), spec, text, requests);

/** Опись дома Kimi — в текст ошибки: формат хранилища снят пробой, расхождение видно сразу. */
function listing(home: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'state.json' && !dir.endsWith('notify')) {
        out.push(`${relative(home, path)}: ${readFileSync(path, 'utf8').slice(0, 600)}`);
      } else out.push(relative(home, path));
    }
  };
  if (existsSync(home)) walk(home);
  const index = join(home, 'session_index.jsonl');
  return `${out.join('\n')}\n--- index:\n${existsSync(index) ? readFileSync(index, 'utf8') : '(none)'}`;
}

describe.skipIf(!present)('kimi resume on the real CLI over stub-model', () => {
  let first: SessionSpec;
  let conversation = '';

  it('a new session keeps its conversation in its own KIMI_CODE_HOME', async () => {
    first = resumeSpec(stand);
    const got = await turn(first, MARK);
    conversation = got.conversationId;
    expect(got.ended).toMatchObject({ type: 'turn.ended', isError: false });
    const home = join(first.dir, KIMI_HOME_DIR);
    expect(findKimiSession(home, live.cwd, conversation).verdict, listing(home)).toBe('owned');
  }, 240_000);

  it('continuation of the prior core session: the resumed turn sees the earlier message', async () => {
    const next = resumeSpec(stand, { resume: { conversationId: conversation, from: first.dir } });
    const got = await turn(next, 'what did I say?');
    expect(got.conversationId).toBe(conversation);
    expect(got.ended).toMatchObject({ isError: false });
    expect(got.seen.length).toBeGreaterThan(0);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
  }, 240_000);

  it('adoption from the human kimi home: one conversation copied, the human home unchanged', async () => {
    const human = join(live.root, 'human-kimi');
    mkdirSync(human, { recursive: true });
    const firstHome = join(first.dir, KIMI_HOME_DIR);
    cpSync(join(firstHome, 'sessions'), join(human, 'sessions'), { recursive: true });
    // Абсолютный каталог в строке указателя переводится на дом человека, относительный — как был.
    const row = readFileSync(join(firstHome, 'session_index.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.sessionId === conversation)!;
    const dir = String(row.sessionDir);
    const humanRow = {
      ...row,
      sessionDir: dir.startsWith(firstHome) ? join(human, relative(firstHome, dir)) : dir,
    };
    const index = join(human, 'session_index.jsonl');
    writeFileSync(index, `${JSON.stringify(humanRow)}\n`);
    const found = findKimiSession(human, live.cwd, conversation);
    expect(found.verdict, listing(human)).toBe('owned');
    const wire = join(found.dir!, 'agents', 'main', 'wire.jsonl');
    const before = {
      index: readFileSync(index, 'utf8'),
      wire: existsSync(wire) ? readFileSync(wire, 'utf8') : null,
      mtime: statSync(index).mtimeMs,
    };
    const adopted = resumeSpec(stand, {
      env: { pin: resumePin(stand, { KIMI_CODE_HOME: human }) },
      resume: { conversationId: conversation },
    });
    const got = await turn(adopted, 'and now?');
    expect(got.conversationId).toBe(conversation);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
    expect(readFileSync(index, 'utf8')).toBe(before.index);
    expect(statSync(index).mtimeMs).toBe(before.mtime);
    expect(existsSync(wire) ? readFileSync(wire, 'utf8') : null).toBe(before.wire);
    expect(findKimiSession(join(adopted.dir, KIMI_HOME_DIR), live.cwd, conversation).verdict).toBe(
      'owned',
    );
  }, 240_000);

  it('another root or a forged id is refused before spawn (no session dir)', async () => {
    const elsewhere = join(live.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const adapter = createKimiAdapter({ pollMs: 20 });
    for (const over of [
      { cwd: elsewhere, resume: { conversationId: conversation, from: first.dir } },
      { resume: { conversationId: `session_${crypto.randomUUID()}`, from: first.dir } },
    ]) {
      const spec = resumeSpec(stand, over);
      const got = await adapter.launch(spec);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(spec.dir)).toBe(false);
    }
  }, 60_000);
});
