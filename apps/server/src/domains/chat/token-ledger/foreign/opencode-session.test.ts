import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDocuments } from '../watch/group-watcher/session-documents.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import { foreignDocumentKind, foreignDocumentReader } from './foreign-document.ts';
import {
  CHILD_SESSION,
  ROOT_SESSION,
  appendOpencodeRows,
  deniedTurn,
  openWalWriter,
  writeOpencodeDb,
} from './opencode-db.fixture.ts';
import {
  loadOpencodeSession,
  newestOpencodeSession,
  opencodeDocumentSource,
  opencodeRef,
  opencodeSessionRef,
  parseOpencodeRef,
} from './opencode-db.ts';
import { opencodeWatchEvents } from './opencode-session.ts';

/**
 * Сессия OpenCode — запись НАСТОЯЩЕГО opencode 1.18.35 на подменной модели во
 * временном доме: десять ходов `opencode run -c` одной сессии (MULTI, EXIT, HOOK, DENY,
 * ASK, TIMEOUT, EDIT, TASK, FAIL, TEXT), отказ плагина, правила и человека, срок
 * оболочки, ненулевой выход, субагент `task`, ошибка модели. Читается из настоящей
 * базы SQLite, собранной из схемы и строк записи, — тем же путём, что живая база.
 */

const of = <K extends WatchEvent['kind']>(list: readonly WatchEvent[], kind: K) =>
  list.filter((event): event is Extract<WatchEvent, { kind: K }> => event.kind === kind);

describe('opencode: сессия из базы → события сторожа', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-session-'));
    db = join(dir, 'opencode.db');
    writeOpencodeDb(db);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = () => {
    const doc = loadOpencodeSession(opencodeRef(db, ROOT_SESSION));
    return opencodeWatchEvents()(doc, 1);
  };

  it('документ: сообщения сессии с частями, субагент — дочерней сессией', () => {
    const doc = loadOpencodeSession(opencodeRef(db, ROOT_SESSION)) as {
      session: { id: string; parentId: string | null };
      messages: Array<{ info: { role: string }; parts: Array<{ id: string; type: string }> }>;
      children: Array<{ session: { id: string; parentId: string }; messages: unknown[] }>;
    };
    expect(doc.session).toMatchObject({ id: ROOT_SESSION, parentId: null });
    expect(doc.messages).toHaveLength(29);
    expect(doc.messages[1]?.parts.map((part) => part.type)).toEqual([
      'step-start',
      'tool',
      'step-finish',
    ]);
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.session).toEqual(
      expect.objectContaining({ id: CHILD_SESSION, parentId: ROOT_SESSION }),
    );
    expect(doc.children[0]?.messages).toHaveLength(3);
    expect(loadOpencodeSession(opencodeRef(db, 'ses_missing'))).toBeUndefined();
    expect(loadOpencodeSession(opencodeRef(join(dir, 'none.db'), ROOT_SESSION))).toBeUndefined();
  });

  it('вызовы — именами Claude: оболочка со сроком в мс, файлы, субагент — Agent', () => {
    const tools = of(read(), 'tool');
    expect(tools.map((tool) => [tool.name, tool.input])).toEqual([
      ['Bash', { command: 'node -e "process.exit(3)"' }],
      ['Read', { file_path: 'C:\\qa\\proj\\missing.txt' }],
      [
        'Bash',
        { command: `node -e "console.log('boom out');console.error('boom err');process.exit(2)"` },
      ],
      ['Bash', { command: 'echo HOOKME' }],
      ['Bash', { command: 'echo DENYME' }],
      ['Bash', { command: 'echo ASKME' }],
      ['Bash', { command: 'ping -n 8 127.0.0.1', timeout: 1500 }],
      ['Write', { file_path: 'C:\\qa\\proj\\w.txt' }],
      ['Edit', { file_path: 'C:\\qa\\proj\\w.txt' }],
      [
        'Agent',
        { description: 'probe sub', prompt: 'QA_SUB run one echo', subagent_type: 'general' },
      ],
      ['Bash', { command: 'echo sub-probe' }],
    ]);
    expect(tools.map((tool) => tool.sidechain === true)).toEqual([
      ...Array.from({ length: 10 }, () => false),
      true,
    ]);
    // Время — собственное время вызова в базе, не время чтения.
    expect(tools[0]?.t).toBe(1793098081564);
  });

  it('ответы: выход ≠ 0, ошибка, отказы плагина, правила и человека, срок', () => {
    const results = new Map(of(read(), 'toolResult').map((result) => [result.id, result]));
    expect(results.get('call_2')).toMatchObject({
      isError: true,
      errorKind: 'exit',
      errorHead: '',
    });
    expect(results.get('call_3')).toMatchObject({
      isError: true,
      errorKind: 'other',
      errorHead: 'File not found: C:\\qa\\proj\\missing.txt',
    });
    // Выход записан и при выводе: голова — вывод, род — выход.
    expect(results.get('call_5')).toMatchObject({
      isError: true,
      errorKind: 'exit',
      errorHead: 'boom out | boom err',
    });
    expect(results.get('call_7')).toMatchObject({ denied: 'probe-guard' });
    expect(results.get('call_9')).toMatchObject({ denied: 'policy' });
    expect(results.get('call_11')).toMatchObject({ denied: 'permission' });
    expect(results.get('call_12')).toMatchObject({ timedOutMs: 1500 });
    expect(results.get('call_12')?.isError).toBeUndefined();
    for (const id of ['call_14', 'call_15', 'call_17', 'call_18']) {
      const result = results.get(id);
      expect([id, result?.isError, result?.denied, result?.timedOutMs]).toEqual([
        id,
        undefined,
        undefined,
        undefined,
      ]);
    }
    expect(results.get('call_17')?.chars).toBe(106);
  });

  it('расход: каждый запрос — свой вызов с окном без кэша, субагент — sidechain', () => {
    const calls = of(read(), 'call');
    expect(calls).toHaveLength(20);
    expect(calls[0]).toEqual({
      kind: 'call',
      t: 1793098081880,
      model: 'stub-model',
      input: 400,
      cacheRead: 600,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 20,
    });
    expect(calls.filter((call) => call.sidechain)).toHaveLength(2);
    expect(calls.some((call) => 'turnTotal' in call)).toBe(false);
  });

  it('ошибка модели — сбой запроса с именем, кодом и текстом; ответы — «жива»', () => {
    const list = read();
    expect(of(list, 'apiError')).toEqual([
      {
        kind: 'apiError',
        t: 1793098109442,
        head: 'APIError 400: probe: model refused the request',
      },
    ]);
    expect(of(list, 'activity')).toHaveLength(9);
    // Реплики человека не отдаются: начало хода сторож получает от панели.
    expect(of(list, 'start')).toEqual([]);
  });

  it('события — по времени: субагент между вызовом task и его ответом', () => {
    const list = read();
    expect(list.map((event) => event.t)).toEqual(
      [...list.map((event) => event.t)].sort((a, b) => a - b),
    );
    const ids = list.flatMap((event) =>
      event.kind === 'tool' || event.kind === 'toolResult' ? [`${event.kind}:${event.id}`] : [],
    );
    expect(ids.indexOf('tool:call_17')).toBeLessThan(ids.indexOf('tool:call_18'));
    expect(ids.indexOf('toolResult:call_18')).toBeLessThan(ids.indexOf('toolResult:call_17'));
  });

  it('каждая запись — один раз: второе чтение того же документа пусто', () => {
    const reader = opencodeWatchEvents();
    const doc = loadOpencodeSession(opencodeRef(db, ROOT_SESSION));
    expect(reader(doc, 1).length).toBeGreaterThan(40);
    expect(reader(doc, 2)).toEqual([]);
  });

  it('вызов, чьи аргументы ещё пишутся (pending), отдаётся, когда пошёл; ответ — когда устоялся', () => {
    const reader = opencodeWatchEvents();
    const doc = (status: string) => ({
      messages: [
        {
          id: 'm1',
          created: 10,
          info: { role: 'assistant' },
          parts: [
            {
              id: 'p1',
              created: 11,
              type: 'tool',
              callID: 'c1',
              tool: 'bash',
              state: { status, input: { command: 'pnpm test' }, time: { start: 12 } },
            },
          ],
        },
      ],
    });
    expect(reader(doc('pending'), 1)).toEqual([]);
    expect(reader(doc('running'), 2)).toEqual([
      { kind: 'tool', t: 12, id: 'c1', name: 'Bash', input: { command: 'pnpm test' } },
    ]);
    expect(reader(doc('running'), 3)).toEqual([]);
    expect(of(reader(doc('completed'), 4), 'toolResult')).toHaveLength(1);
  });

  it('сжатие: часть compaction (форма из исходника 1.18: auto, overflow), отмена — не сбой', () => {
    // Сжатия и отмены живая запись не содержит: форма части — `type:"compaction",auto,overflow`
    // (opencode 1.18.35), имя ошибки отмены — `MessageAbortedError`.
    const message = (id: string, part: Record<string, unknown>, error?: unknown) => ({
      id,
      created: 5,
      info: { role: id === 'u' ? 'user' : 'assistant', ...(error ? { error } : {}) },
      parts: [{ id: `${id}-p`, created: 6, ...part }],
    });
    const list = opencodeWatchEvents()(
      {
        messages: [
          message('u', { type: 'compaction', auto: false, overflow: false }),
          message('a', { type: 'compaction', auto: true }),
          message('x', { type: 'text', text: '' }, { name: 'MessageAbortedError', data: {} }),
        ],
        children: [{ messages: [message('c', { type: 'compaction', auto: true })] }],
      },
      1,
    );
    expect(list).toEqual([
      { kind: 'compact', t: 6, manual: true },
      { kind: 'compact', t: 6 },
    ]);
  });

  it('размышление — в выходе вызова; запрос без расхода (сорвался) — не вызов', () => {
    const step = (id: string, tokens: Record<string, unknown>) => ({
      id,
      created: 7,
      type: 'step-finish',
      tokens,
    });
    const list = opencodeWatchEvents()(
      {
        messages: [
          {
            id: 'm',
            created: 5,
            info: { role: 'assistant', modelID: 'gpt-5' },
            parts: [
              step('s1', { input: 10, output: 4, reasoning: 30, cache: { read: 90, write: 5 } }),
              step('s2', { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
            ],
          },
        ],
      },
      1,
    );
    expect(list).toEqual([
      {
        kind: 'call',
        t: 7,
        model: 'gpt-5',
        input: 10,
        cacheRead: 90,
        cacheWrite: 5,
        cacheWrite1h: 0,
        output: 34,
      },
    ]);
  });

  it('читатель документа по роду: opencode при драйвере SQLite', () => {
    expect(foreignDocumentKind('opencode')).toBe('opencode');
    const doc = loadOpencodeSession(opencodeRef(db, ROOT_SESSION));
    expect(of(foreignDocumentReader('opencode')(doc, 1), 'tool')).toHaveLength(11);
  });
});

describe('opencode: поиск сессии и ссылка', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-find-'));
    db = join(dir, 'opencode.db');
    writeOpencodeDb(db);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('первый ход: свежая корневая сессия каталога копии, субагент не берётся', () => {
    // Сессии записи: корень родился в 1793098076635, субагент — в 1793098106341.
    expect(newestOpencodeSession(db, 'C:\\qa\\proj', 1793098070000, 'win32')).toBe(
      opencodeRef(db, ROOT_SESSION),
    );
    expect(newestOpencodeSession(db, 'c:/QA/proj/', 1793098070000, 'win32')).toBe(
      opencodeRef(db, ROOT_SESSION),
    );
    // Начата до хода — не этого хода; субагент свежее, но не корень.
    expect(newestOpencodeSession(db, 'C:\\qa\\proj', 1793098080000, 'win32')).toBeUndefined();
    expect(newestOpencodeSession(db, 'C:\\qa\\other', 1793098070000, 'win32')).toBeUndefined();
    // Не Windows: регистр различается.
    expect(newestOpencodeSession(db, 'C:/QA/proj', 1793098070000, 'linux')).toBeUndefined();
    expect(newestOpencodeSession(join(dir, 'none.db'), 'C:\\qa\\proj', 0, 'win32')).toBeUndefined();
  });

  it('ссылка: база и id по последней #, нет базы — нет ссылки', () => {
    expect(parseOpencodeRef('C:/a#b/opencode.db#ses_1')).toEqual({
      db: 'C:/a#b/opencode.db',
      sessionId: 'ses_1',
    });
    expect(parseOpencodeRef('C:/opencode.db')).toBeUndefined();
    expect(parseOpencodeRef('C:/opencode.db#')).toBeUndefined();
    expect(opencodeSessionRef(db, 'ses_1')).toBe(`${db}#ses_1`);
    expect(opencodeSessionRef(join(dir, 'none.db'), 'ses_1')).toBeUndefined();
  });

  it('WAL: запись живого CLI лежит в журнале — отпечаток сдвигается, чтение её видит', () => {
    const ref = opencodeRef(db, ROOT_SESSION);
    const writer = openWalWriter(db);
    try {
      const before = opencodeDocumentSource.stamp(ref);
      const reader = opencodeWatchEvents();
      reader(loadOpencodeSession(ref), 1);
      writer.append(deniedTurn(ROOT_SESSION, 1793098120000, 1, 'wal'));
      expect(opencodeDocumentSource.stamp(ref)).not.toEqual(before);
      expect(of(reader(loadOpencodeSession(ref), 2), 'toolResult')).toEqual([
        expect.objectContaining({ id: 'call_wal_0', denied: 'permission' }),
      ]);
    } finally {
      writer.close();
    }
  });

  it('источник: отпечаток сдвигается записью CLI, рождение — время сессии', () => {
    const ref = opencodeRef(db, ROOT_SESSION);
    expect(opencodeDocumentSource.bornAt(ref)).toBe(1793098076635);
    expect(opencodeDocumentSource.bornAt(opencodeRef(db, 'ses_missing'))).toBeUndefined();
    const before = opencodeDocumentSource.stamp(ref);
    appendOpencodeRows(db, deniedTurn(ROOT_SESSION, 1793098120000, 1, 'late'));
    expect(opencodeDocumentSource.stamp(ref)).not.toEqual(before);
    expect(opencodeDocumentSource.stamp(opencodeRef(join(dir, 'none.db'), ROOT_SESSION))).toBe(
      undefined,
    );
  });

  it('SessionDocuments над базой: дописанное читается, отданное — нет', () => {
    const ref = opencodeRef(db, ROOT_SESSION);
    const docs = new SessionDocuments();
    const reader = opencodeWatchEvents();
    expect(docs.read(ref, reader, 1_000, 0, opencodeDocumentSource).length).toBeGreaterThan(40);
    expect(docs.read(ref, reader, 2_000, 0, opencodeDocumentSource)).toEqual([]);
    appendOpencodeRows(db, deniedTurn(ROOT_SESSION, 1793098120000, 2, 'late'));
    const fresh = docs.read(ref, reader, 3_000, 0, opencodeDocumentSource);
    expect(fresh.map((event) => event.kind)).toEqual([
      'tool',
      'toolResult',
      'tool',
      'toolResult',
      'call',
    ]);
  });

  it('prime: сессия, начатая до хода, — в отданное; начатая в ходе — с начала', () => {
    const ref = opencodeRef(db, ROOT_SESSION);
    const old = new SessionDocuments();
    const oldReader = opencodeWatchEvents();
    old.prime(ref, oldReader, 1_000, 1793098090000, opencodeDocumentSource);
    expect(old.read(ref, oldReader, 2_000, 0, opencodeDocumentSource)).toEqual([]);
    const fresh = new SessionDocuments();
    const freshReader = opencodeWatchEvents();
    fresh.prime(ref, freshReader, 1_000, 1793098070000, opencodeDocumentSource);
    expect(fresh.read(ref, freshReader, 2_000, 0, opencodeDocumentSource).length).toBeGreaterThan(
      40,
    );
  });
});

describe('opencode без драйвера SQLite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('рода документа нет — охват честно «только текст хода»', async () => {
    vi.resetModules();
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    const fresh = await import('./foreign-document.ts');
    expect(fresh.foreignDocumentKind('opencode')).toBeUndefined();
    expect(fresh.foreignDocumentKind('continue')).toBe('continue');
    const db = await import('./opencode-db.ts');
    expect(db.sqliteDriver()).toBeUndefined();
    expect(db.loadOpencodeSession('C:/x/opencode.db#ses_1')).toBeUndefined();
  });
});
