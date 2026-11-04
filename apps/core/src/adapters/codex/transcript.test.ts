import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { createCodexDialect } from './app-server.ts';
import { CODEX_CHANNELS, createCodexAdapter } from './codex.ts';
import { mapCodexPermission } from './permission.ts';
import {
  codexOwnsTranscript,
  codexResume,
  codexTranscriptPresent,
  findCodexRollout,
} from './transcript.ts';

/**
 * Продолжение нити Codex: суд транскрипта (свой id внутри файла И корень), копия только файла
 * разговора в дом сеанса, `thread/resume` в рукопожатии. Хранилища — временные каталоги, формат —
 * снятый с codex-cli 0.155.1 (проба 02.11): первая строка `session_meta` с `payload.{id,cwd}`.
 */

const base = mkdtempSync(join(tmpdir(), 'codex-transcript-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ID = '01a19a70-fb10-7240-81fd-83da3012ce29';
const OTHER = '01a19a70-c82d-7763-a27f-8b502242302a';
const ROOT = join(base, 'work');
const REL = join('2026', '11', '02', `rollout-2026-11-02T09-07-38-${ID}.jsonl`);

let seq = 0;
/** Дом Codex с одним файлом разговора: имя — по `nameId`, внутри — `innerId` и `cwd`. */
function home(over: { nameId?: string; innerId?: string; cwd?: string; rel?: string } = {}) {
  seq += 1;
  const dir = join(base, `home-${seq}`);
  const rel = over.rel ?? REL.replace(ID, over.nameId ?? ID);
  const file = join(dir, 'sessions', rel);
  mkdirSync(join(file, '..'), { recursive: true });
  const meta = {
    timestamp: '2026-11-02T04:07:38.081Z',
    type: 'session_meta',
    payload: { id: over.innerId ?? ID, cwd: over.cwd ?? ROOT, cli_version: '0.155.1' },
  };
  const turn = { type: 'response_item', payload: { role: 'user', text: 'REMEMBER_ALPHA_42' } };
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(turn)}\n`);
  return { dir, file };
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
    coreHook: 'C:\\n\\node.exe C:\\c\\run.ts hook',
    endpoint: {
      channel: CODEX_CHANNELS[0]!,
      endpoint: {
        baseUrl: 'http://127.0.0.1:9',
        dialect: 'openai-responses',
        model: 'm',
        key: 'k',
      },
    },
    ...over,
  } as SessionSpec;
}

describe('codex transcript ownership (adoption from the human CODEX_HOME)', () => {
  it('own id inside the rollout AND this root → owned; the file sits under sessions/YYYY/MM/DD', () => {
    const h = home();
    expect(codexOwnsTranscript({ CODEX_HOME: h.dir }, ROOT, ID)).toBe(true);
    expect(findCodexRollout(h.dir, ROOT, ID)).toMatchObject({ verdict: 'owned', rel: REL });
  });

  it('another root → not owned (the root IS compared)', () => {
    const h = home({ cwd: join(base, 'elsewhere') });
    expect(codexOwnsTranscript({ CODEX_HOME: h.dir }, ROOT, ID)).toBe(false);
    expect(findCodexRollout(h.dir, ROOT, ID).verdict).toBe('foreign');
  });

  it('a forged id: the file name carries the id, the rollout inside is another thread → not owned', () => {
    const h = home({ innerId: OTHER });
    expect(codexOwnsTranscript({ CODEX_HOME: h.dir }, ROOT, ID)).toBe(false);
  });

  it('no such thread, a non-UUID id, a missing store → false; a relative CODEX_HOME → unknown', () => {
    const h = home();
    expect(codexOwnsTranscript({ CODEX_HOME: h.dir }, ROOT, OTHER)).toBe(false);
    expect(codexOwnsTranscript({ CODEX_HOME: h.dir }, ROOT, `../${ID}`)).toBe(false);
    expect(codexOwnsTranscript({ CODEX_HOME: join(base, 'nope') }, ROOT, ID)).toBe(false);
    expect(codexOwnsTranscript({ CODEX_HOME: 'rel/home' }, ROOT, ID)).toBeUndefined();
    // Без CODEX_HOME — `~/.codex` дома из пина.
    const userHome = join(base, 'user');
    const inUser = join(userHome, '.codex', 'sessions', REL);
    mkdirSync(join(inUser, '..'), { recursive: true });
    writeFileSync(inUser, readFileSync(h.file));
    expect(codexOwnsTranscript({ HOME: userHome, USERPROFILE: userHome }, ROOT, ID)).toBe(true);
  });

  it('an ended core session: present only when its own CODEX_HOME holds the thread', () => {
    const dir = join(base, 'ended');
    const rollout = join(dir, 'codex-home', 'sessions', REL);
    mkdirSync(join(rollout, '..'), { recursive: true });
    writeFileSync(rollout, readFileSync(home().file));
    expect(codexTranscriptPresent({}, ID, dir)).toBe(true);
    expect(codexTranscriptPresent({}, OTHER, dir)).toBe(false);
    expect(codexTranscriptPresent({}, ID)).toBeUndefined();
  });
});

describe('codex resume stage — the copy into the session home', () => {
  it('adoption: only the rollout is copied, to the same place under the session CODEX_HOME', () => {
    const h = home();
    const s = spec({ env: { pin: { CODEX_HOME: h.dir } }, resume: { conversationId: ID } });
    const stage = codexResume(s);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    const copy = join(s.dir, 'codex-home', 'sessions', REL);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(h.file, 'utf8'));
  });

  it('continuation: the source is the prior core session dir, never the human store', () => {
    const human = home();
    const prior = join(base, 'sessions', 'prior');
    const rollout = join(prior, 'codex-home', 'sessions', REL);
    mkdirSync(join(rollout, '..'), { recursive: true });
    writeFileSync(rollout, readFileSync(human.file));
    const s = spec({
      env: { pin: { CODEX_HOME: join(base, 'empty-human') } },
      resume: { conversationId: ID, from: prior },
    });
    expect(codexResume(s).ok).toBe(true);
    // Прежняя сессия без нити: отказ, даже если у человека она есть.
    const bare = spec({
      env: { pin: { CODEX_HOME: human.dir } },
      resume: { conversationId: ID, from: join(base, 'sessions', 'bare') },
    });
    expect(codexResume(bare)).toMatchObject({ ok: false, reason: /^resume_not_owned/ });
    const self = spec({ resume: { conversationId: ID, from: 'x' } });
    expect(codexResume(self)).toMatchObject({ ok: false, reason: /not an absolute/ });
  });

  it('a foreign root or a forged id is refused BEFORE spawn: no session dir, no process', async () => {
    const adapter = createCodexAdapter({ command: 'agentdeck-no-such-codex' });
    for (const h of [home({ cwd: join(base, 'other-root') }), home({ innerId: OTHER })]) {
      const s = spec({ env: { pin: { CODEX_HOME: h.dir } }, resume: { conversationId: ID } });
      const got = await adapter.launch(s);
      expect(got).toMatchObject({ ok: false, reason: /^resume_not_owned/ });
      expect(existsSync(s.dir)).toBe(false);
    }
  });

  it('the adapter answers adoption itself (ownsTranscript) and declares resume', () => {
    const adapter = createCodexAdapter();
    const h = home();
    expect(adapter.caps.resume).toBe(true);
    expect(adapter.ownsTranscript?.({ CODEX_HOME: h.dir }, ROOT, ID)).toBe(true);
    expect(adapter.ownsTranscript?.({ CODEX_HOME: h.dir }, join(base, 'x'), ID)).toBe(false);
  });
});

describe('codex dialect — thread/resume', () => {
  const dialect = (resume?: string) =>
    createCodexDialect({
      cwd: 'C:\\w',
      hookCommand: 'H',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: 'BRIEF',
      model: 'stub-model',
      permit: 'core',
      mapPermission: mapCodexPermission,
      ...(resume ? { resume } : {}),
    });
  const toThread = (d: ReturnType<typeof dialect>) => {
    const out = [...d.start()];
    out.push(...d.push(JSON.stringify({ id: 1, result: {} })).out);
    const hook = {
      key: 'k',
      eventName: 'preToolUse',
      source: 'user',
      command: 'H',
      currentHash: 'h',
    };
    out.push(...d.push(JSON.stringify({ id: 2, result: { data: [{ hooks: [hook] }] } })).out);
    out.push(...d.push(JSON.stringify({ id: 3, result: {} })).out);
    return JSON.parse(out.at(-1)!.line) as { method: string; params: Record<string, unknown> };
  };

  it('resume: thread/resume of that thread, not a new ephemeral one; init names the same id', () => {
    const d = dialect(ID);
    const sent = toThread(d);
    expect(sent.method).toBe('thread/resume');
    expect(sent.params).toMatchObject({
      threadId: ID,
      cwd: 'C:\\w',
      developerInstructions: 'BRIEF',
    });
    expect(sent.params).not.toHaveProperty('ephemeral');
    const step = d.push(JSON.stringify({ id: 4, result: { thread: { id: ID } } }));
    expect(step.events).toMatchObject([{ type: 'init', conversationId: ID }]);
    expect(d.ready).toBe(true);
    // Прошлые вызовы нити вне хода — не новые вызовы.
    const replay = d.push(
      JSON.stringify({
        method: 'item/started',
        params: { item: { type: 'commandExecution', id: 'old', command: 'git status' } },
      }),
    );
    expect(replay.events).toEqual([]);
  });

  it('resume answered with another thread id → the handshake fails (never a silent new thread)', () => {
    const d = dialect(ID);
    toThread(d);
    d.push(JSON.stringify({ id: 4, result: { thread: { id: OTHER } } }));
    expect(d.failed).toMatch(/thread\/resume answered thread/);
    expect(d.ready).toBe(false);
  });

  it('a new session starts a persisted thread (the file the next session continues)', () => {
    const sent = toThread(dialect());
    expect(sent.method).toBe('thread/start');
    expect(sent.params).toMatchObject({ ephemeral: false });
  });
});
