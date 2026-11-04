import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pathsFoldCase } from '../../platform/user-dirs.ts';
import type { SessionSpec } from '../adapter.types.ts';
import { createGeminiAdapter, GEMINI_CHANNELS } from './index.ts';
import {
  findGeminiChat,
  GEMINI_HOME_DIR,
  geminiOwnsTranscript,
  geminiResume,
  geminiTranscriptPresent,
} from './transcript.ts';

/**
 * Продолжение разговора Gemini CLI: суд файла разговора (id в первой строке) и `.project_root`
 * его метки (тот же корень), перенос в дом сеанса одного файла, `.project_root` и `projects.json`
 * с одной строкой. Раскладка — снятая с Gemini CLI 0.66 (пробы 02–03.11, контейнер и Windows).
 */

const base = mkdtempSync(join(tmpdir(), 'gemini-transcript-'));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = join(base, 'work');
// Корень, как его пишет CLI: нижний регистр только на Windows; на Linux путь как есть (каталог
// mkdtemp несёт заглавные — свёрнутый корень там уже чужой).
const CLI_ROOT = pathsFoldCase() ? ROOT.toLowerCase() : ROOT;
const ID = '0b6f6a52-3a51-4c8e-9a3b-2f1d6c7e8a90';
const OTHER = '9d2c1e4b-7f6a-4b3c-8d2e-1a0b9c8d7e6f';
const CHAT = `session-2026-11-03T07-54-${ID.slice(0, 8)}.jsonl`;

let seq = 0;

/** Первая строка файла разговора — как её пишет Gemini 0.66. */
const head = (id: string): string =>
  `${JSON.stringify({ sessionId: id, projectHash: 'h', startTime: 't', kind: 'main' })}\n`;

/**
 * Дом Gemini человека: разговор `ID` под меткой `work` и чужой разговор `OTHER` под меткой
 * `secret`. `projectRoot` и `headId` подменяют содержимое для отказов.
 */
function store(opts: { projectRoot?: string; headId?: string } = {}): string {
  seq += 1;
  const home = join(base, `home-${seq}`);
  const g = join(home, '.gemini');
  const projectRoot = opts.projectRoot ?? CLI_ROOT;
  mkdirSync(join(g, 'tmp', 'work', 'chats'), { recursive: true });
  writeFileSync(join(g, 'tmp', 'work', '.project_root'), projectRoot);
  writeFileSync(
    join(g, 'tmp', 'work', 'chats', CHAT),
    `${head(opts.headId ?? ID)}{"type":"user","content":[{"text":"REMEMBER_ALPHA_42"}]}\n`,
  );
  const secret = join(base, 'secret-project');
  mkdirSync(join(g, 'tmp', 'secret', 'chats'), { recursive: true });
  writeFileSync(join(g, 'tmp', 'secret', '.project_root'), secret);
  writeFileSync(
    join(g, 'tmp', 'secret', 'chats', `session-2026-11-03T07-50-${OTHER.slice(0, 8)}.jsonl`),
    `${head(OTHER)}{"type":"user","content":[{"text":"PRIVATE_NOTE"}]}\n`,
  );
  writeFileSync(
    join(g, 'projects.json'),
    JSON.stringify({ projects: { [projectRoot]: 'work', [secret]: 'secret' } }),
  );
  return home;
}

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  seq += 1;
  return {
    sessionId: `s${seq}`,
    dir: join(base, 'sessions', `s${seq}`),
    cwd: ROOT,
    brief: 'B',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(base, 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'off', skills: 'off' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 'st',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'x',
    },
    coreHook: 'node hook',
    endpoint: {
      channel: GEMINI_CHANNELS[0]!,
      endpoint: { baseUrl: 'http://127.0.0.1:9', dialect: 'google-genai', model: 'm', key: 'k' },
    },
    ...over,
  } as SessionSpec;
}

describe('gemini transcript ownership (adoption from the human home)', () => {
  it('the chat whose first line names this id, under a slug whose .project_root is this root → owned', () => {
    const home = store();
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: home }, ROOT, ID)).toBe(true);
    // Корень в .project_root CLI пишет в нижнем регистре на Windows — сравнение путей ОС.
    expect(findGeminiChat(home, ROOT, ID)).toMatchObject({ verdict: 'owned', slug: 'work' });
  });

  it('another root → not owned (the root IS compared)', () => {
    const home = store();
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: home }, join(base, 'other-root'), ID)).toBe(
      false,
    );
    expect(findGeminiChat(home, join(base, 'other-root'), ID).verdict).toBe('foreign');
    const moved = store({ projectRoot: join(base, 'elsewhere') });
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: moved }, ROOT, ID)).toBe(false);
  });

  it('a file named after the id whose first line names another id → not owned (the name proves nothing)', () => {
    const home = store({ headId: '0b6f6a52-0000-4000-8000-000000000000' });
    expect(findGeminiChat(home, ROOT, ID).verdict).toBe('absent');
  });

  it('a forged id, a non-uuid id, a missing home → false; a relative home → unknown', () => {
    const home = store();
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: home }, ROOT, crypto.randomUUID())).toBe(false);
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: home }, ROOT, '../work')).toBe(false);
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: join(base, 'none') }, ROOT, ID)).toBe(false);
    expect(geminiOwnsTranscript({ GEMINI_CLI_HOME: 'rel/home' }, ROOT, ID)).toBeUndefined();
  });

  it('an ended core session: present only when its own gemini-home holds the conversation', () => {
    const prior = spec({
      env: { pin: { GEMINI_CLI_HOME: store() } },
      resume: { conversationId: ID },
    });
    expect(geminiTranscriptPresent({}, ID, prior.dir)).toBe(false);
    const stage = geminiResume(prior);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    expect(geminiTranscriptPresent({}, ID, prior.dir)).toBe(true);
    expect(geminiTranscriptPresent({}, OTHER, prior.dir)).toBe(false);
    expect(geminiTranscriptPresent({}, ID)).toBeUndefined();
  });
});

describe('gemini resume stage — one chat file, its .project_root and one projects.json row', () => {
  it('adoption: the copy holds only this chat; the human home is unchanged', () => {
    const home = store();
    const before = readFileSync(join(home, '.gemini', 'projects.json'), 'utf8');
    const s = spec({ env: { pin: { GEMINI_CLI_HOME: home } }, resume: { conversationId: ID } });
    const stage = geminiResume(s);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    const g = join(s.dir, GEMINI_HOME_DIR, '.gemini');
    expect(readFileSync(join(g, 'tmp', 'work', 'chats', CHAT), 'utf8')).toContain(
      'REMEMBER_ALPHA_42',
    );
    expect(readFileSync(join(g, 'tmp', 'work', '.project_root'), 'utf8')).toBe(CLI_ROOT);
    expect(JSON.parse(readFileSync(join(g, 'projects.json'), 'utf8'))).toEqual({
      projects: { [CLI_ROOT]: 'work' },
    });
    expect(existsSync(join(g, 'tmp', 'secret'))).toBe(false);
    expect(readFileSync(join(home, '.gemini', 'projects.json'), 'utf8')).toBe(before);
  });

  it('continuation: the source is the prior core session, never the human home', () => {
    const human = store();
    const prior = spec({
      env: { pin: { GEMINI_CLI_HOME: human } },
      resume: { conversationId: ID },
    });
    const first = geminiResume(prior);
    if (!first.ok) throw new Error(first.reason);
    first.place();
    const ok = spec({
      env: { pin: { GEMINI_CLI_HOME: join(base, 'no-human') } },
      resume: { conversationId: ID, from: prior.dir },
    });
    expect(geminiResume(ok).ok).toBe(true);
    const bare = spec({
      env: { pin: { GEMINI_CLI_HOME: human } },
      resume: { conversationId: ID, from: join(base, 'sessions', 'bare') },
    });
    expect(geminiResume(bare)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^resume_not_owned/),
    });
  });

  it('a foreign root or a forged id is refused BEFORE spawn: no session dir, no process', async () => {
    const adapter = createGeminiAdapter({ command: 'agentdeck-no-such-gemini' });
    expect(adapter.caps.resume).toBe(true);
    expect(adapter.ownsTranscript).toBeTypeOf('function');
    for (const [home, id] of [
      [store({ projectRoot: join(base, 'other-root') }), ID],
      [store(), crypto.randomUUID()],
    ] as const) {
      const s = spec({ env: { pin: { GEMINI_CLI_HOME: home } }, resume: { conversationId: id } });
      const got = await adapter.launch(s);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(s.dir)).toBe(false);
    }
  });
});
