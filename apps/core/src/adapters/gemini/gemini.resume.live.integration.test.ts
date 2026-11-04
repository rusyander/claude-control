import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
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
import { createGeminiAdapter, GEMINI_CHANNELS } from './index.ts';
import { findGeminiChat, GEMINI_HOME_DIR } from './transcript.ts';

/**
 * Живое продолжение разговора Gemini CLI (0.66, `gemini --acp` → `session/load`) над заглушкой
 * модели (Windows с CLI в PATH или контейнер `tools/core-linux.mjs --clis`): вторая сессия видит
 * прежний разговор в запросе к модели. Оба пути: прежняя сессия ядра (`resume.from`) и дом
 * человека (копия одного файла разговора, `.project_root` и строки `projects.json`; дом человека
 * не меняется). Чужой корень и подложный id — отказ до запуска процесса.
 */

const present = hasCli(geminiRunFacts.binary.command);
const MARK = 'REMEMBER_ALPHA_42';
let live: LiveRoot;
let stub: StubModel;
let stand: ResumeStand;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('gemini-resume-');
  stub = await startStubModel({
    script: (ctx) => {
      requests.push(ctx.request.raw);
      return `REPLY_${requests.length}`;
    },
  });
  stand = { live, channel: GEMINI_CHANNELS[0]!, dialect: 'google-genai', baseUrl: stub.baseUrl };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const turn = (spec: SessionSpec, text: string) =>
  resumeTurn(createGeminiAdapter({ pollMs: 20 }), spec, text, requests);

/** Опись `.gemini` дома — в текст ошибки: формат хранилища снят пробой, расхождение видно сразу. */
function listing(home: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === '.project_root' || entry.name === 'projects.json') {
        out.push(`${relative(home, path)}: ${readFileSync(path, 'utf8').slice(0, 300)}`);
      } else out.push(relative(home, path));
    }
  };
  const g = join(home, '.gemini');
  if (existsSync(g)) walk(g);
  return out.join('\n');
}

describe.skipIf(!present)('gemini resume on the real CLI over stub-model', () => {
  let first: SessionSpec;
  let conversation = '';

  it('a new session keeps its conversation in its own GEMINI_CLI_HOME', async () => {
    first = resumeSpec(stand);
    const got = await turn(first, MARK);
    conversation = got.conversationId;
    expect(got.ended).toMatchObject({ type: 'turn.ended', isError: false });
    const home = join(first.dir, GEMINI_HOME_DIR);
    expect(findGeminiChat(home, live.cwd, conversation).verdict, listing(home)).toBe('owned');
  }, 240_000);

  it('continuation of the prior core session: the resumed turn sees the earlier message', async () => {
    const next = resumeSpec(stand, { resume: { conversationId: conversation, from: first.dir } });
    const got = await turn(next, 'what did I say?');
    expect(got.conversationId).toBe(conversation);
    expect(got.ended).toMatchObject({ isError: false });
    expect(got.seen.length).toBeGreaterThan(0);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
  }, 240_000);

  it('adoption from the human gemini home: one chat copied, the human home unchanged', async () => {
    const human = join(live.root, 'human-gemini');
    mkdirSync(join(human, '.gemini'), { recursive: true });
    const firstGemini = join(first.dir, GEMINI_HOME_DIR, '.gemini');
    cpSync(join(firstGemini, 'tmp'), join(human, '.gemini', 'tmp'), { recursive: true });
    cpSync(join(firstGemini, 'projects.json'), join(human, '.gemini', 'projects.json'));
    const found = findGeminiChat(human, live.cwd, conversation);
    expect(found.verdict, listing(human)).toBe('owned');
    const before = {
      chat: readFileSync(found.file!, 'utf8'),
      mtime: statSync(found.file!).mtimeMs,
    };
    const adopted = resumeSpec(stand, {
      env: { pin: resumePin(stand, { GEMINI_CLI_HOME: human }) },
      resume: { conversationId: conversation },
    });
    const got = await turn(adopted, 'and now?');
    expect(got.conversationId).toBe(conversation);
    expect(got.seen.some((raw) => raw.includes(MARK))).toBe(true);
    expect(readFileSync(found.file!, 'utf8')).toBe(before.chat);
    expect(statSync(found.file!).mtimeMs).toBe(before.mtime);
    const copy = join(adopted.dir, GEMINI_HOME_DIR);
    expect(findGeminiChat(copy, live.cwd, conversation).verdict, listing(copy)).toBe('owned');
  }, 240_000);

  it('another root or a forged id is refused before spawn (no session dir)', async () => {
    const elsewhere = join(live.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const adapter = createGeminiAdapter({ pollMs: 20 });
    for (const over of [
      { cwd: elsewhere, resume: { conversationId: conversation, from: first.dir } },
      { resume: { conversationId: crypto.randomUUID(), from: first.dir } },
    ]) {
      const spec = resumeSpec(stand, over);
      const got = await adapter.launch(spec);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(spec.dir)).toBe(false);
    }
  }, 60_000);
});
