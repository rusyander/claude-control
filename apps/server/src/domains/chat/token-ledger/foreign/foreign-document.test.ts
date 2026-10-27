import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionDocuments } from '../watch/group-watcher/session-documents.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import {
  continueSessionFile,
  continueSessionsDir,
  continueToolOf,
  continueWatchEvents,
  foreignDocumentKind,
  newestContinueSession,
} from './foreign-document.ts';

/**
 * Переписка Continue — документ НАСТОЯЩЕГО `cn` 1.5.47 на подменной модели
 * (`continue-1.5-list.json`: один вызов `List`, два ответа модели, пути обезличены).
 * Состояния `errored` / `canceled` и тексты срока — формы исходника `cn`
 * (`dist/index.js`): живьём на подменной модели их не вызвать.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__', 'continue-1.5-list.json'), 'utf8'),
) as Record<string, unknown>;
const NOW = Date.parse('2026-10-27T10:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'foreign-doc-'));
  dirs.push(dir);
  return dir;
};

type State = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: string;
  out?: string;
};
/** Документ `cn` с одним ответом модели и его вызовами. */
function doc(sessionId: string, states: readonly State[], usage = true): Record<string, unknown> {
  return {
    sessionId,
    workspaceDirectory: 'C:\\qa',
    history: [
      { message: { role: 'user', content: 'go' } },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: states.map((s) => ({
            id: s.id,
            type: 'function',
            function: { name: s.name, arguments: JSON.stringify(s.args) },
          })),
          ...(usage ? { usage: { prompt_tokens: 500, completion_tokens: 5, model: 'm' } } : {}),
        },
        toolCallStates: states.map((s) => ({
          toolCallId: s.id,
          toolCall: { id: s.id, function: { name: s.name, arguments: JSON.stringify(s.args) } },
          status: s.status,
          parsedArgs: s.args,
          ...(s.out !== undefined ? { output: [{ content: s.out }] } : {}),
        })),
      },
    ],
  };
}
const results = (events: readonly WatchEvent[]) =>
  events.filter(
    (event): event is Extract<WatchEvent, { kind: 'toolResult' }> => event.kind === 'toolResult',
  );

describe('foreign-document (Continue)', () => {
  it('род документа — только у Continue', () => {
    expect(foreignDocumentKind('continue')).toBe('continue');
    expect(foreignDocumentKind('qwen')).toBeUndefined();
    expect(foreignDocumentKind('gemini')).toBeUndefined();
  });

  it('реальная запись cn 1.5.47: два вызова с расходом, инструмент, его ответ, текст ответа', () => {
    const events = continueWatchEvents()(FIXTURE, NOW);
    expect(events).toEqual([
      // prompt_tokens включает кэш: 1234 − 100 прочитанных.
      {
        kind: 'call',
        t: NOW,
        model: 'ftalk-cpu',
        input: 1134,
        cacheRead: 100,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 36,
      },
      { kind: 'tool', t: NOW, id: 'call_rzod8uhu', name: 'List', input: { dirpath: 'C:/qa/' } },
      { kind: 'toolResult', t: NOW, id: 'call_rzod8uhu', chars: 66 },
      {
        kind: 'call',
        t: NOW,
        model: 'ftalk-cpu',
        input: 81,
        cacheRead: 1248,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 64,
      },
      { kind: 'activity', t: NOW },
    ]);
  });

  it('документ переписан целиком: отданное не повторяется, поздний ответ вызова — отдаётся', () => {
    const read = continueWatchEvents();
    const calling = doc('s1', [
      { id: 'b1', name: 'Bash', args: { command: 'ls' }, status: 'calling', out: 'part' },
    ]);
    const first = read(calling, NOW);
    expect(first.map((event) => event.kind)).toEqual(['call', 'tool']);
    // Тот же документ — ничего; вызов кончился — только его ответ.
    expect(read(calling, NOW + 1)).toEqual([]);
    const done = doc('s1', [
      { id: 'b1', name: 'Bash', args: { command: 'ls' }, status: 'done', out: 'a\nb' },
    ]);
    expect(read(done, NOW + 2)).toEqual([{ kind: 'toolResult', t: NOW + 2, id: 'b1', chars: 3 }]);
    expect(read(done, NOW + 3)).toEqual([]);
    // Следующий ход — свой файл, своя сессия: те же места в истории — новые записи.
    expect(
      read(
        doc('s2', [{ id: 'b1', name: 'Bash', args: { command: 'ls' }, status: 'done', out: 'x' }]),
        NOW + 4,
      ).map((e) => e.kind),
    ).toEqual(['call', 'tool', 'toolResult']);
  });

  it('вызов, ещё не дописанный моделью, и ответ без расхода — не отдаются', () => {
    const read = continueWatchEvents();
    expect(
      read(doc('s1', [{ id: 'g1', name: 'Bash', args: {}, status: 'generating' }], false), NOW),
    ).toEqual([]);
  });

  it('ответы cn: отказ человека и политики, ошибка оболочки, срок без вывода', () => {
    const read = continueWatchEvents();
    const events = read(
      doc('s1', [
        {
          id: 'd1',
          name: 'Bash',
          args: { command: 'git push' },
          status: 'canceled',
          out: 'Permission denied by user',
        },
        {
          id: 'd2',
          name: 'Bash',
          args: { command: 'rm -rf x' },
          status: 'canceled',
          out: 'Command blocked by security policy',
        },
        {
          id: 'e1',
          name: 'Bash',
          args: { command: 'pnpm lint' },
          status: 'errored',
          out: 'Error executing tool Bash: Error (exit code 2): lint failed at 12 files',
        },
        {
          id: 'e2',
          name: 'Read',
          args: { filepath: 'C:/qa/x' },
          status: 'errored',
          out: 'Error executing tool Read: ENOENT: no such file',
        },
        {
          id: 't1',
          name: 'Bash',
          args: { command: 'sleep 999', timeout: 30 },
          status: 'done',
          out: 'out\n\n[Command timed out after 30 seconds of no output]',
        },
      ]),
      NOW,
    );
    const byId = Object.fromEntries(results(events).map((event) => [event.id, event]));
    expect(byId.d1).toMatchObject({ denied: 'permission' });
    expect(byId.d2).toMatchObject({ denied: 'policy' });
    expect(byId.e1).toMatchObject({ isError: true, errorKind: 'exit' });
    expect(byId.e1?.errorHead).toContain('lint failed');
    expect(byId.e2).toMatchObject({ isError: true, errorKind: 'other' });
    expect(byId.e2?.denied).toBeUndefined();
    expect(byId.t1).toMatchObject({ timedOutMs: 30_000 });
    expect(byId.t1?.isError).toBeUndefined();
    // Исполненный вызов без ошибки — ни отказа, ни ошибки, хотя текст похож.
    const ok = results(
      read(
        doc('s9', [
          { id: 'k', name: 'Bash', args: {}, status: 'done', out: 'Permission denied by user' },
        ]),
        NOW,
      ),
    );
    expect(ok[0]).toEqual({ kind: 'toolResult', t: NOW, id: 'k', chars: 25 });
  });

  it('инструменты cn → имена и аргументы Claude', () => {
    expect(continueToolOf('Bash', { command: 'ls', timeout: 30 })).toEqual({
      name: 'Bash',
      input: { command: 'ls', timeout: 30_000 },
    });
    expect(continueToolOf('Bash', { command: 'ls' })).toEqual({
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(continueToolOf('Read', { filepath: 'a.ts' })).toEqual({
      name: 'Read',
      input: { file_path: 'a.ts' },
    });
    expect(continueToolOf('Write', { filepath: 'a.ts', content: 'x' })).toEqual({
      name: 'Write',
      input: { file_path: 'a.ts' },
    });
    expect(continueToolOf('Edit', { file_path: 'b.ts' })).toEqual({
      name: 'Edit',
      input: { file_path: 'b.ts' },
    });
    expect(continueToolOf('MultiEdit', { file_path: 'b.ts' })).toEqual({
      name: 'MultiEdit',
      input: { file_path: 'b.ts' },
    });
    expect(continueToolOf('Search', { pattern: 'foo', path: 'src' })).toEqual({
      name: 'Grep',
      input: { pattern: 'foo', path: 'src' },
    });
    expect(continueToolOf('Fetch', { url: 'u' })).toEqual({ name: 'Fetch', input: { url: 'u' } });
  });

  it('каталог сессий: CONTINUE_GLOBAL_DIR, иначе ~/.continue', () => {
    expect(continueSessionsDir({ CONTINUE_GLOBAL_DIR: join('X', 'cg') })).toBe(
      join('X', 'cg', 'sessions'),
    );
    expect(continueSessionsDir({})).toMatch(/[\\/]\.continue[\\/]sessions$/);
  });

  it('свежая сессия копии: своя папка (регистр и косые на Windows не важны), не раньше хода, не список', () => {
    const dir = tmp();
    const since = Date.now() - 60_000;
    const put = (name: string, workspace: string, mtime: number) => {
      const path = join(dir, name);
      writeFileSync(
        path,
        JSON.stringify({ sessionId: name, workspaceDirectory: workspace, history: [] }),
      );
      utimesSync(path, mtime / 1000, mtime / 1000);
    };
    put('old.json', 'C:\\work\\copy', since - 10_000);
    put('other.json', 'C:\\work\\other', since + 30_000);
    put('mine.json', 'c:/WORK/copy/', since + 10_000);
    put('sessions.json', 'C:\\work\\copy', since + 40_000);
    writeFileSync(join(dir, 'broken.json'), '{"sessionId":');
    expect(newestContinueSession(dir, 'C:\\work\\copy', since, 'win32')).toBe(
      join(dir, 'mine.json'),
    );
    // На posix регистр важен.
    expect(newestContinueSession(dir, 'C:\\work\\copy', since, 'linux')).toBeUndefined();
    // Новее из своих — по времени, не по месту в каталоге (имя раньше по алфавиту).
    put('a-mine2.json', 'C:\\work\\copy', since + 20_000);
    expect(newestContinueSession(dir, 'C:\\work\\copy', since, 'win32')).toBe(
      join(dir, 'a-mine2.json'),
    );
    expect(
      newestContinueSession(join(dir, 'nope'), 'C:\\work\\copy', since, 'win32'),
    ).toBeUndefined();
    expect(continueSessionFile(dir, 'mine')).toBe(join(dir, 'mine.json'));
    expect(continueSessionFile(dir, 'absent')).toBeUndefined();
  });

  it('SessionDocuments: перечитывает только сдвинутый документ, недописанный — на следующем тике', () => {
    const dir = tmp();
    mkdirSync(join(dir, 's'));
    const path = join(dir, 's', 'a.json');
    const docs = new SessionDocuments();
    const read = continueWatchEvents();
    writeFileSync(path, '{"sessionId":"a","history":[');
    expect(docs.read(path, read, NOW, 0)).toEqual([]);
    writeFileSync(
      path,
      JSON.stringify(doc('a', [{ id: 'x', name: 'Bash', args: {}, status: 'done', out: 'o' }])),
    );
    expect(docs.read(path, read, NOW + 1, 0).map((e) => e.kind)).toEqual([
      'call',
      'tool',
      'toolResult',
    ]);
    // Рано (интервал) — пусто, даже если документ сдвинулся.
    writeFileSync(
      path,
      JSON.stringify(
        doc('a', [
          { id: 'x', name: 'Bash', args: {}, status: 'done', out: 'o' },
          { id: 'y', name: 'Read', args: { filepath: 'f' }, status: 'done', out: 'pp' },
        ]),
      ),
    );
    expect(docs.read(path, read, NOW + 2, 30_000)).toEqual([]);
    expect(docs.read(path, read, NOW + 40_000, 30_000).map((e) => e.kind)).toEqual([
      'tool',
      'toolResult',
    ]);
    // Документа нет — пусто, без ошибки.
    expect(docs.read(join(dir, 'absent.json'), read, NOW, 0)).toEqual([]);
  });

  it('SessionDocuments.prime: прошлое старого документа не догоняется, документ этого хода — с начала', () => {
    const dir = tmp();
    const path = join(dir, 'a.json');
    writeFileSync(
      path,
      JSON.stringify(doc('a', [{ id: 'x', name: 'Bash', args: {}, status: 'done', out: 'o' }])),
    );
    const old = new SessionDocuments();
    const oldRead = continueWatchEvents();
    // Ход начат после рождения файла: прошлое — в отданное.
    old.prime(path, oldRead, NOW, Date.now() + 60_000);
    expect(old.read(path, oldRead, NOW + 1, 0)).toEqual([]);
    // CLI дописал вызов: отдаётся только он, прошлое так и не догоняется.
    const grown = (ids: readonly string[]) =>
      JSON.stringify(
        doc(
          'a',
          ids.map((id) => ({ id, name: 'Bash', args: {}, status: 'done', out: 'o' })),
        ),
      );
    writeFileSync(path, grown(['x', 'y']));
    expect(old.read(path, oldRead, NOW + 2, 0)).toEqual([
      { kind: 'tool', t: NOW + 2, id: 'y', name: 'Bash', input: {} },
      { kind: 'toolResult', t: NOW + 2, id: 'y', chars: 1 },
    ]);
    writeFileSync(path, grown(['x']));
    const fresh = new SessionDocuments();
    const freshRead = continueWatchEvents();
    // Файл родился после начала хода: читается с начала.
    fresh.prime(path, freshRead, NOW, Date.now() - 60_000);
    expect(fresh.read(path, freshRead, NOW + 1, 0).map((e) => e.kind)).toEqual([
      'call',
      'tool',
      'toolResult',
    ]);
  });
});
