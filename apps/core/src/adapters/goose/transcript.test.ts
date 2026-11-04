import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from './goose.ts';
import {
  copyGooseSession,
  findGooseSession,
  gooseOwnsTranscript,
  gooseResume,
  gooseSessionDb,
  gooseTranscriptPresent,
} from './transcript.ts';

/**
 * Продолжение разговора Goose: суд строки `sessions` (id И `working_dir`), новая база с одним этим
 * разговором в доме сеанса. Схема — снятая с Goose 1.54 (проба 02.11), укороченная до колонок,
 * которые читает суд и перенос; чужие разговоры и каталог моделей в копию попасть не должны.
 */

const { DatabaseSync: Db } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');
const base = mkdtempSync(join(tmpdir(), 'goose-transcript-'));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = join(base, 'work');
const ID = '20261102_1';

const SCHEMA = [
  'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, goose_mode TEXT NOT NULL DEFAULT 'auto')",
  'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL)',
  'CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, created_timestamp INTEGER NOT NULL, input_tokens INTEGER)',
  'CREATE INDEX idx_messages_session ON messages(session_id)',
  'CREATE TABLE provider_inventory_entries (inventory_key TEXT PRIMARY KEY, provider_id TEXT NOT NULL)',
];

let seq = 0;
/** База Goose: разговор `ID` в `cwd` и чужой разговор человека `20261102_2`. */
function store(cwd = ROOT): string {
  seq += 1;
  const dir = join(base, `root-${seq}`, 'data', 'sessions');
  mkdirSync(dir, { recursive: true });
  const db: DatabaseSync = new Db(join(dir, 'sessions.db'));
  for (const sql of SCHEMA) db.exec(sql);
  db.exec('INSERT INTO schema_version (version) VALUES (16)');
  const session = db.prepare('INSERT INTO sessions (id, name, working_dir) VALUES (?, ?, ?)');
  session.run(ID, 'ours', cwd);
  session.run('20261102_2', 'private', join(base, 'secret-project'));
  const msg = db.prepare(
    'INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, 1)',
  );
  msg.run(ID, 'user', '[{"type":"text","text":"REMEMBER_ALPHA_42"}]');
  msg.run('20261102_2', 'user', '[{"type":"text","text":"PRIVATE_NOTE"}]');
  msg.run(ID, 'assistant', '[{"type":"text","text":"ok"}]');
  db.prepare(
    'INSERT INTO usage_ledger (session_id, created_timestamp, input_tokens) VALUES (?, 1, 10)',
  ).run(ID);
  db.exec("INSERT INTO provider_inventory_entries VALUES ('k', 'openai')");
  db.close();
  return join(base, `root-${seq}`);
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
      channel: GOOSE_CHANNELS[0]!,
      endpoint: { baseUrl: 'http://127.0.0.1:9', dialect: 'openai-chat', model: 'm', key: 'k' },
    },
    ...over,
  } as SessionSpec;
}

const rows = (db: string, sql: string): Record<string, unknown>[] => {
  const conn = new Db(db, { readOnly: true });
  try {
    return conn.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    conn.close();
  }
};

describe('goose transcript ownership (adoption from the human store)', () => {
  it('a sessions row with this id AND this working_dir → owned', () => {
    const root = store();
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: root }, ROOT, ID)).toBe(true);
  });

  it('another root → not owned (the root IS compared)', () => {
    const root = store(join(base, 'elsewhere'));
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: root }, ROOT, ID)).toBe(false);
    expect(findGooseSession(gooseSessionDb(join(root, '..', 'x')), ROOT, ID)).toBe('absent');
  });

  it('a forged id, a foreign-shaped id, a missing store → false; a relative root → unknown', () => {
    const root = store();
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: root }, ROOT, '20261102_9')).toBe(false);
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: root }, ROOT, "1' OR '1'='1")).toBe(false);
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: join(base, 'none') }, ROOT, ID)).toBe(false);
    expect(gooseOwnsTranscript({ GOOSE_PATH_ROOT: 'rel' }, ROOT, ID)).toBeUndefined();
  });

  it('an ended core session: present only when its own goose-home holds the conversation', () => {
    const dir = join(base, 'ended');
    copyGooseSession(join(store(), 'data', 'sessions', 'sessions.db'), gooseSessionDb(dir), ID);
    expect(gooseTranscriptPresent({}, ID, dir)).toBe(true);
    expect(gooseTranscriptPresent({}, '20261102_2', dir)).toBe(false);
    expect(gooseTranscriptPresent({}, ID)).toBeUndefined();
  });
});

describe('goose resume stage — a new database with one conversation', () => {
  it('adoption: only that conversation is copied; the human other chats and inventory stay out', () => {
    const root = store();
    const s = spec({ env: { pin: { GOOSE_PATH_ROOT: root } }, resume: { conversationId: ID } });
    const stage = gooseResume(s);
    if (!stage.ok) throw new Error(stage.reason);
    stage.place();
    const db = gooseSessionDb(s.dir);
    expect(rows(db, 'SELECT id, working_dir FROM sessions')).toEqual([
      { id: ID, working_dir: ROOT },
    ]);
    expect(rows(db, 'SELECT session_id, content_json FROM messages ORDER BY id')).toEqual([
      { session_id: ID, content_json: '[{"type":"text","text":"REMEMBER_ALPHA_42"}]' },
      { session_id: ID, content_json: '[{"type":"text","text":"ok"}]' },
    ]);
    expect(rows(db, 'SELECT version FROM schema_version')).toEqual([{ version: 16 }]);
    expect(rows(db, 'SELECT count(*) AS n FROM usage_ledger')).toEqual([{ n: 1 }]);
    expect(rows(db, 'SELECT count(*) AS n FROM provider_inventory_entries')).toEqual([{ n: 0 }]);
    // Индексы схемы перенесены: Goose не перестраивает базу.
    expect(
      rows(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_session'",
      ),
    ).toHaveLength(1);
  });

  it('continuation: the source is the prior core session, never the human store', () => {
    const human = store();
    const prior = join(base, 'sessions', 'prior');
    copyGooseSession(join(human, 'data', 'sessions', 'sessions.db'), gooseSessionDb(prior), ID);
    const ok = spec({
      env: { pin: { GOOSE_PATH_ROOT: join(base, 'no-human') } },
      resume: { conversationId: ID, from: prior },
    });
    expect(gooseResume(ok).ok).toBe(true);
    const bare = spec({
      env: { pin: { GOOSE_PATH_ROOT: human } },
      resume: { conversationId: ID, from: join(base, 'sessions', 'bare') },
    });
    expect(gooseResume(bare)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^resume_not_owned/),
    });
  });

  it('a foreign root or a forged id is refused BEFORE spawn: no session dir, no process', async () => {
    const adapter = createGooseAdapter({ command: 'agentdeck-no-such-goose' });
    expect(adapter.caps.resume).toBe(true);
    for (const [root, id] of [
      [store(join(base, 'other-root')), ID],
      [store(), '20261102_7'],
    ] as const) {
      const s = spec({ env: { pin: { GOOSE_PATH_ROOT: root } }, resume: { conversationId: id } });
      const got = await adapter.launch(s);
      expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^resume_not_owned/) });
      expect(existsSync(s.dir)).toBe(false);
    }
  });
});
