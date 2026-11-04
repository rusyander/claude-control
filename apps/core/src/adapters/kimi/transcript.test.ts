import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { createKimiAdapter, KIMI_CHANNELS } from './index.ts';
import {
  findKimiSession,
  KIMI_HOME_DIR,
  kimiOwnsTranscript,
  kimiResume,
  kimiTranscriptPresent,
} from './transcript.ts';

/**
 * Продолжение разговора Kimi Code: суд строки указателя (id И `workDir`) и `state.json` каталога
 * (тот же id и корень), перенос в дом сеанса одного каталога разговора и указателя с одной его
 * строкой. Раскладка — снятая с Kimi Code 2.4.1 (проба 02.11 в контейнере).
 */

const base = mkdtempSync(join(tmpdir(), 'kimi-transcript-'));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = join(base, 'work');
const ID = 'session_0b6f6a52-3a51-4c8e-9a3b-2f1d6c7e8a90';
const OTHER = 'session_9d2c1e4b-7f6a-4b3c-8d2e-1a0b9c8d7e6f';

let seq = 0;

interface Store {
  home: string;
  dir: string;
}

/**
 * Дом Kimi: разговор `ID` (каталог `sessionDir` абсолютный или относительный) и чужой разговор
 * человека `OTHER`. `state` и `rowRoot` подменяют содержимое для отказов.
 */
function store(
  opts: {
    rowRoot?: string;
    stateRoot?: string;
    stateId?: string;
    relative?: boolean;
    sessionDir?: string;
  } = {},
): Store {
  seq += 1;
  const home = join(base, `home-${seq}`);
  const rel = join('sessions', 'wd_work_ab12', ID);
  const dir = join(home, rel);
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ id: opts.stateId ?? ID, cwd: opts.stateRoot ?? ROOT }),
  );
  writeFileSync(
    join(dir, 'agents', 'main', 'wire.jsonl'),
    '{"type":"user","text":"REMEMBER_ALPHA_42"}\n',
  );
  const otherRel = join('sessions', 'wd_secret_cd34', OTHER);
  mkdirSync(join(home, otherRel, 'agents', 'main'), { recursive: true });
  writeFileSync(
    join(home, otherRel, 'state.json'),
    JSON.stringify({ id: OTHER, cwd: join(base, 'secret-project') }),
  );
  writeFileSync(join(home, otherRel, 'agents', 'main', 'wire.jsonl'), '{"text":"PRIVATE_NOTE"}\n');
  const rows = [
    {
      sessionId: OTHER,
      sessionDir: join(home, otherRel),
      workDir: join(base, 'secret-project'),
    },
    {
      sessionId: ID,
      sessionDir: opts.sessionDir ?? (opts.relative ? rel : dir),
      workDir: opts.rowRoot ?? ROOT,
    },
  ];
  writeFileSync(
    join(home, 'session_index.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`,
  );
  return { home, dir };
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
      channel: KIMI_CHANNELS[0]!,
      endpoint: { baseUrl: 'http://127.0.0.1:9', dialect: 'openai-chat', model: 'm', key: 'k' },
    },
    ...over,
  } as SessionSpec;
}

const indexRows = (home: string): Record<string, unknown>[] =>
  readFileSync(join(home, 'session_index.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('kimi transcript ownership (adoption from the human home)', () => {
  it('an index row with this id AND this workDir, confirmed by state.json → owned', () => {
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: store().home }, ROOT, ID)).toBe(true);
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: store({ relative: true }).home }, ROOT, ID)).toBe(
      true,
    );
  });

  it('another root in the index row or in state.json → not owned (both roots ARE compared)', () => {
    const elsewhere = join(base, 'elsewhere');
    expect(
      kimiOwnsTranscript({ KIMI_CODE_HOME: store({ rowRoot: elsewhere }).home }, ROOT, ID),
    ).toBe(false);
    expect(
      kimiOwnsTranscript({ KIMI_CODE_HOME: store({ stateRoot: elsewhere }).home }, ROOT, ID),
    ).toBe(false);
    expect(findKimiSession(store({ rowRoot: elsewhere }).home, ROOT, ID).verdict).toBe('foreign');
  });

  it('state.json naming another id → not owned (the index alone proves nothing)', () => {
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: store({ stateId: OTHER }).home }, ROOT, ID)).toBe(
      false,
    );
  });

  it('a sessionDir outside <home>/sessions → not owned (a row cannot point out of the home)', () => {
    // Снаружи — каталог с «правильным» state.json: отказ держит именно граница дома, не state.
    const outside = join(base, 'planted');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'state.json'), JSON.stringify({ id: ID, cwd: ROOT }));
    for (const sessionDir of [outside, '../planted', join('sessions', '..', '..', 'planted')]) {
      // Дом — `<base>/home-N`: `..` от него и есть `<base>/planted`.
      expect(kimiOwnsTranscript({ KIMI_CODE_HOME: store({ sessionDir }).home }, ROOT, ID)).toBe(
        false,
      );
    }
    const { home } = store({ sessionDir: 'sessions' });
    writeFileSync(join(home, 'sessions', 'state.json'), JSON.stringify({ id: ID, cwd: ROOT }));
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: home }, ROOT, ID)).toBe(false);
  });

  it('a forged id, a bare uuid (no `session_`), a missing home → false; a relative home → unknown', () => {
    const { home } = store();
    expect(
      kimiOwnsTranscript({ KIMI_CODE_HOME: home }, ROOT, `session_${crypto.randomUUID()}`),
    ).toBe(false);
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: home }, ROOT, ID.slice('session_'.length))).toBe(
      false,
    );
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: join(base, 'none') }, ROOT, ID)).toBe(false);
    expect(kimiOwnsTranscript({ KIMI_CODE_HOME: 'rel' }, ROOT, ID)).toBeUndefined();
  });

  it('an ended core session: present only when its own kimi-home holds the conversation', () => {
    const prior = spec({
      env: { pin: { KIMI_CODE_HOME: store().home } },
      resume: { conversationId: ID },
    });
    const stage = kimiResume(prior);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    expect(kimiTranscriptPresent({}, ID, prior.dir)).toBe(true);
    expect(kimiTranscriptPresent({}, OTHER, prior.dir)).toBe(false);
    expect(kimiTranscriptPresent({}, ID)).toBeUndefined();
  });
});

describe('kimi resume stage — one conversation dir and one index row', () => {
  it('adoption, absolute sessionDir: the copy points at its own dir; the human home unchanged', () => {
    const { home, dir } = store();
    const before = readFileSync(join(home, 'session_index.jsonl'), 'utf8');
    const s = spec({ env: { pin: { KIMI_CODE_HOME: home } }, resume: { conversationId: ID } });
    const stage = kimiResume(s);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    const target = join(s.dir, KIMI_HOME_DIR);
    const copied = join(target, 'sessions', 'wd_work_ab12', ID);
    expect(indexRows(target)).toEqual([{ sessionId: ID, sessionDir: copied, workDir: ROOT }]);
    expect(readFileSync(join(copied, 'agents', 'main', 'wire.jsonl'), 'utf8')).toContain(
      'REMEMBER_ALPHA_42',
    );
    expect(existsSync(join(target, 'sessions', 'wd_secret_cd34'))).toBe(false);
    expect(findKimiSession(target, ROOT, ID)).toMatchObject({ verdict: 'owned', dir: copied });
    expect(readFileSync(join(home, 'session_index.jsonl'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
  });

  it('adoption, relative sessionDir: the row keeps its relative form', () => {
    const { home } = store({ relative: true });
    const s = spec({ env: { pin: { KIMI_CODE_HOME: home } }, resume: { conversationId: ID } });
    const stage = kimiResume(s);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    expect(indexRows(join(s.dir, KIMI_HOME_DIR))).toEqual([
      {
        sessionId: ID,
        sessionDir: join('sessions', 'wd_work_ab12', ID),
        workDir: ROOT,
      },
    ]);
  });

  it('continuation: the source is the prior core session, never the human home', () => {
    const human = store().home;
    const prior = spec({ env: { pin: { KIMI_CODE_HOME: human } }, resume: { conversationId: ID } });
    const first = kimiResume(prior);
    if (!first.ok) throw new Error(first.reason);
    first.place();
    const ok = spec({
      env: { pin: { KIMI_CODE_HOME: join(base, 'no-human') } },
      resume: { conversationId: ID, from: prior.dir },
    });
    expect(kimiResume(ok).ok).toBe(true);
    const bare = spec({
      env: { pin: { KIMI_CODE_HOME: human } },
      resume: { conversationId: ID, from: join(base, 'sessions', 'bare') },
    });
    expect(kimiResume(bare)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^resume_not_owned/),
    });
  });

  it('a foreign root or a forged id is refused BEFORE spawn: no session dir, no process', async () => {
    const adapter = createKimiAdapter({ command: 'agentdeck-no-such-kimi' });
    expect(adapter.caps.resume).toBe(true);
    for (const [home, id] of [
      [store({ rowRoot: join(base, 'other-root') }).home, ID],
      [store().home, `session_${crypto.randomUUID()}`],
    ] as const) {
      const s = spec({ env: { pin: { KIMI_CODE_HOME: home } }, resume: { conversationId: id } });
      const got = await adapter.launch(s);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(s.dir)).toBe(false);
    }
  });
});
