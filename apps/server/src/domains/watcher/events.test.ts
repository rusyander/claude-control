import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WATCH_EVENTS_FILE, WATCH_EVENTS_FLUSH_MS, WatchEventStore } from './events.ts';
import { fingerprintOf, normalizePath, topFrame } from './fingerprint.ts';
import type { WatchSignal } from './types.ts';

/** Секрет собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['sk', 'ant', 'api03', 'Zx9Qw7Er5Ty3Ui1Op0As8Df6Gh4Jk2Lz'].join('-');

const server500 = (message: string, path = '/api/chats/abc'): WatchSignal => ({
  source: 'server',
  kind: 'http-5xx',
  method: 'GET',
  path,
  status: 500,
  message,
});

describe('кольцо сбоев наблюдателя', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watch-events-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('один сбой с разными числами склеивается в одну запись со счётчиком', () => {
    const store = new WatchEventStore(() => dir);
    const first = store.record(server500('ENOENT: port 5178 pid 1234', '/api/chats/1'));
    const second = store.record(server500('ENOENT: port 5199 pid 88', '/api/chats/2'));
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    const events = store.list();
    expect(events).toHaveLength(1);
    expect(events[0]!.count).toBe(2);
  });

  it('ошибка провайдера: одна причина дважды — одна запись, другая — другая; хвост stderr без секрета', () => {
    const store = new WatchEventStore(() => dir);
    const exit = (cause: string, output: string): WatchSignal => ({
      source: 'server',
      kind: 'cli-exit',
      message: `«claude» завершился с кодом 1 (-p): ${cause}`,
      output,
    });
    const a = store.record(exit('API Error: 529 overloaded', 'run 1\nAPI Error: 529 overloaded'));
    const b = store.record(exit('API Error: 529 overloaded', 'run 2\nAPI Error: 529 overloaded'));
    const c = store.record(exit('Invalid API key', `key=${SECRET}\nInvalid API key`));
    expect(b.event.id).toBe(a.event.id);
    expect(c.event.id).not.toBe(a.event.id);
    const events = store.list();
    expect(events.map((event) => event.count).sort()).toEqual([1, 2]);
    // Хвост — последнего повтора.
    expect(events.find((event) => event.id === a.event.id)!.output).toContain('run 2');
    const invalid = events.find((event) => event.id === c.event.id)!;
    expect(invalid.output).toContain('Invalid API key');
    expect(invalid.output).not.toContain(SECRET);
    store.flush();
    expect(readFileSync(join(dir, WATCH_EVENTS_FILE), 'utf8')).not.toContain(SECRET);
  });

  it('разные тексты и разные модули в стеке — разные сбои', () => {
    const store = new WatchEventStore(() => dir);
    store.record(server500('boom'));
    store.record(server500('bang'));
    // У сбоя запроса место — маршрут: другой стек того же маршрута ту же причину не делит.
    store.record({ ...server500('boom'), stack: 'Error: boom\n    at run (C:\\x\\other.ts:3:4)' });
    expect(store.list()).toHaveLength(2);
    // У ошибки страницы место — верхний кадр стека.
    const pageError = (stack: string): WatchSignal => ({
      source: 'client',
      kind: 'window-error',
      message: 'boom',
      stack,
    });
    store.record(pageError('Error: boom\n    at a (http://x/src/a.tsx:3:4)'));
    store.record(pageError('Error: boom\n    at b (http://x/src/b.tsx:9:1)'));
    store.record(pageError('Error: boom\n    at a (http://x/src/a.tsx:30:4)'));
    expect(store.list()).toHaveLength(4);
  });

  it('одна причина с двух сторон — один раздел: 5xx сервера и отказ страницы', () => {
    const store = new WatchEventStore(() => dir);
    const server = store.record({ ...server500('db locked'), path: '/api/chats/:chatId' });
    const client = store.record({
      source: 'client',
      kind: 'api-failure',
      method: 'get',
      path: '/api/chats/42',
      status: 502,
      message: 'db locked',
    });
    expect(client.isNew).toBe(false);
    expect(client.event.id).toBe(server.event.id);
    expect(client.event.count).toBe(2);
    expect(client.event.ref).toBe('WR-1');
  });

  it('медленный ответ и зависшая загрузка: одно место — одна причина, длительность — самая долгая', () => {
    const store = new WatchEventStore(() => dir);
    const slow = (ms: number): WatchSignal => ({
      source: 'server',
      kind: 'slow-request',
      method: 'GET',
      path: '/api/skills',
      durationMs: ms,
      message: `Ответ дольше 5 с: ${ms} мс`,
    });
    store.record(slow(6200));
    store.record(slow(9100));
    store.record(slow(7000));
    const [event] = store.list();
    expect(store.list()).toHaveLength(1);
    expect(event).toMatchObject({ count: 3, durationMs: 9100, severity: 'low' });
  });

  it('номер WR-n: по порядку, из отчёта для известной причины, после выключения — дальше', () => {
    const inReport = new Map([['feedfeedfeed', 'WR-40']]);
    const store = new WatchEventStore(() => dir, undefined, {
      refOf: (id) => inReport.get(id),
      maxRef: () => 40,
    });
    const first = store.record(server500('one'));
    const second = store.record(server500('two'));
    expect([first.event.ref, second.event.ref]).toEqual(['WR-41', 'WR-42']);
    store.clear();
    expect(store.record(server500('three')).event.ref).toBe('WR-43');
  });

  it('влитая моделью причина: счётчики сложены, повтор идёт в раздел, куда влили', () => {
    const store = new WatchEventStore(() => dir);
    const a = store.record(server500('alpha'), '2026-09-27T00:00:05.000Z').event;
    const b = store.record(server500('beta'), '2026-09-27T00:00:01.000Z').event;
    store.record(server500('beta'), '2026-09-27T00:00:09.000Z');
    const merged = store.merge(b.ref, a.id);
    expect(merged?.removed.id).toBe(b.id);
    expect(merged?.into).toMatchObject({
      count: 3,
      firstSeen: '2026-09-27T00:00:01.000Z',
      lastSeen: '2026-09-27T00:00:09.000Z',
      merged: [b.ref],
    });
    expect(store.record(server500('beta')).event.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.count).toBe(4);
    // Себя в себя и несуществующее — ничего не сливают.
    expect(store.merge(a.id, a.ref)).toBeUndefined();
    expect(store.merge('WR-999', a.id)).toBeUndefined();
  });

  it('замечание: повтор тем же файлом и заголовком — счётчик, ссылка на номер — тоже', () => {
    const store = new WatchEventStore(() => dir);
    const remark = {
      title: 'Флаг 3 не сбрасывается',
      explanation: 'почему',
      severity: 'medium' as const,
      location: 'src/a.ts:10',
    };
    const first = store.recordRemark(remark).event;
    expect(first).toMatchObject({
      entryClass: 'remark',
      kind: 'remark',
      source: 'model',
      count: 1,
    });
    // Другая строка того же файла, другие числа в заголовке — то же замечание.
    const again = store.recordRemark({
      ...remark,
      title: 'Флаг 7 не сбрасывается',
      location: 'src/a.ts:12',
    });
    expect(again.isNew).toBe(false);
    const byRef = store.recordRemark({
      title: 'совсем иначе сказано',
      explanation: 'x',
      severity: 'low',
      sameAs: first.ref,
    });
    expect(byRef.event.id).toBe(first.id);
    expect(byRef.event.count).toBe(3);
    // Замечание разбора не ждёт.
    expect(store.pending()).toHaveLength(0);
  });

  it('сверх потолка уходят самые давние по последнему появлению', () => {
    const store = new WatchEventStore(() => dir, 3);
    store.record(server500('a'), '2026-09-27T00:00:01.000Z');
    store.record(server500('b'), '2026-09-27T00:00:02.000Z');
    store.record(server500('c'), '2026-09-27T00:00:03.000Z');
    // Повтор «a» делает его свежим — уйти должен «b».
    store.record(server500('a'), '2026-09-27T00:00:04.000Z');
    store.record(server500('d'), '2026-09-27T00:00:05.000Z');
    const messages = store
      .list()
      .map((event) => event.message)
      .sort();
    expect(messages).toEqual(['a', 'c', 'd']);
  });

  it('секрет в тексте и стеке маскируется ДО записи на диск', () => {
    const store = new WatchEventStore(() => dir);
    store.record({
      ...server500(`auth failed with ${SECRET}`),
      stack: `Error\n    at call (x.ts:1:1) token=${SECRET}`,
    });
    store.flush();
    const raw = readFileSync(join(dir, WATCH_EVENTS_FILE), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('auth failed with');
  });

  /**
   * F-10. Модель читает код с Read без ограды пути, а в пачку попадает чужой
   * текст (ошибки страницы, пути запросов): находка может процитировать секрет.
   * Кольцо хранит её как есть — маскируется она при записи, как и сам сбой.
   */
  it('находка модели маскируется ДО записи на диск', () => {
    const store = new WatchEventStore(() => dir);
    const { event } = store.record(server500('x'));
    store.markAnalyzed(
      new Map([[event.id, 1]]),
      new Map([
        [
          event.id,
          {
            title: `token ${SECRET}`,
            happened: 'h',
            context: '',
            verdict: 'confirmed' as const,
            fix: `use ${SECRET}`,
            rootCause: SECRET,
          },
        ],
      ]),
    );
    store.flush();
    const raw = readFileSync(join(dir, WATCH_EVENTS_FILE), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(store.list()[0]!.finding?.title).toMatch(/^token /);
  });

  it('новый сбой, вытесненный потолком в том же вызове, не называется записанным', () => {
    const store = new WatchEventStore(() => dir, 2);
    store.record(server500('a'), '2026-09-27T00:00:05.000Z');
    store.record(server500('b'), '2026-09-27T00:00:06.000Z');
    const old = store.record({ ...server500('c'), at: '2026-09-27T00:00:01.000Z' });
    expect(old.kept).toBe(false);
    expect(store.list().map((item) => item.message)).not.toContain('c');
    expect(store.record(server500('d'), '2026-09-27T00:00:07.000Z').kept).toBe(true);
  });

  it('слияние записи прошлой версии (без номера) не кладёт пустую ссылку в merged', () => {
    const writer = new WatchEventStore(() => dir);
    const a = writer.record(server500('a')).event;
    const b = writer.record(server500('b')).event;
    writer.flush();
    const file = join(dir, WATCH_EVENTS_FILE);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { events: Array<{ ref?: string }> };
    delete data.events[1]!.ref;
    writeFileSync(file, JSON.stringify(data));
    // Файл прошлой версии читает следующий запуск панели — свежее кольцо.
    const store = new WatchEventStore(() => dir);
    const merged = store.merge(b.id, a.id);
    expect(merged?.into.merged).toEqual([]);
  });

  it('разобранный сбой не ждёт разбора, пока не повторится', () => {
    const store = new WatchEventStore(() => dir);
    const { event } = store.record(server500('x'));
    expect(store.pending()).toHaveLength(1);
    store.markAnalyzed(
      new Map([[event.id, 1]]),
      new Map([
        [event.id, { title: 't', happened: 'h', context: '', verdict: 'confirmed' as const }],
      ]),
    );
    expect(store.pending()).toHaveLength(0);
    expect(store.list()[0]!.finding?.verdict).toBe('confirmed');
    store.record(server500('x'));
    expect(store.pending()).toHaveLength(1);
  });
});

/**
 * F-172: кольцо на 200 сбоев со стеками — полмегабайта JSON, и каждый сигнал
 * читал и переписывал его целиком синхронно (замер: 6,4 мс на сигнал, лавина
 * 5xx из сотни запросов — больше полусекунды остановленного сервера). Кольцо
 * живёт в памяти, на диск уходит одной записью не позже чем через 250 мс после
 * первой правки и сразу — на выходе панели.
 */
describe('кольцо сбоев: память и отложенная запись', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watch-flush-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const file = () => join(dir, WATCH_EVENTS_FILE);

  it('пачка сигналов — одна запись после окна, не запись на каждый', () => {
    const store = new WatchEventStore(() => dir);
    store.record(server500('a'));
    store.record(server500('b'));
    store.record(server500('a'));
    expect(existsSync(file())).toBe(false);
    expect(
      store
        .list()
        .map((event) => event.count)
        .sort(),
    ).toEqual([1, 2]);

    vi.advanceTimersByTime(WATCH_EVENTS_FLUSH_MS);
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as { events: { count: number }[] };
    expect(saved.events.map((event) => event.count).sort()).toEqual([1, 2]);
  });

  it('поток сигналов не откладывает запись бесконечно: окно от первой правки', () => {
    const store = new WatchEventStore(() => dir);
    store.record(server500('a'));
    vi.advanceTimersByTime(WATCH_EVENTS_FLUSH_MS - 50);
    store.record(server500('b'));
    vi.advanceTimersByTime(50);
    expect(existsSync(file())).toBe(true);
  });

  it('flush на выходе: всё записанное читает следующий запуск', () => {
    const store = new WatchEventStore(() => dir);
    store.record(server500('a'));
    store.flush();
    expect(new WatchEventStore(() => dir).list().map((event) => event.message)).toEqual(['a']);
  });

  it('смена каталога данных: несохранённое уходит в прежний файл, чтение — из нового', () => {
    const other = mkdtempSync(join(tmpdir(), 'cc-watch-flush-other-'));
    try {
      let current = dir;
      const store = new WatchEventStore(() => current);
      store.record(server500('a'));
      current = other;
      expect(store.list()).toEqual([]);
      expect(new WatchEventStore(() => dir).list().map((event) => event.message)).toEqual(['a']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('выданная запись — снимок: повтор сбоя не меняет пачку, ушедшую на разбор', () => {
    const store = new WatchEventStore(() => dir);
    store.record(server500('a'));
    const batch = store.pending();
    store.record(server500('a'));
    expect(batch[0]!.count).toBe(1);
    expect(store.pending()[0]!.count).toBe(2);
  });
});

describe('отпечаток сбоя', () => {
  it('путь без строки запроса и с :id вместо значений', () => {
    expect(normalizePath('/api/chats/123/messages?x=1')).toBe('/api/chats/:id/messages');
  });

  it('буквенный сегмент с цифрой — часть маршрута, а не идентификатор', () => {
    expect(normalizePath('/api/project-tests/e2e')).toBe('/api/project-tests/e2e');
    expect(normalizePath('/api/v1/oauth2/x')).toBe('/api/v1/oauth2/x');
    expect(normalizePath('/api/runs/abcdef12')).toBe('/api/runs/:id');
    const at = (path: string): WatchSignal => ({ ...server500('same'), path });
    expect(fingerprintOf(at('/api/project-tests/e2e'))).not.toBe(
      fingerprintOf(at('/api/project-tests/x1')),
    );
  });

  it('стек Firefox/Safari без заголовка: верхний кадр — первая строка; хэш чанка сборки не в счёт', () => {
    expect(topFrame('fn@http://localhost:8888/src/pages/a.tsx:10:5\nb@b.ts:1:1')).toBe('a.tsx');
    expect(topFrame('TypeError: x\n    at f (http://h/assets/index-BdX8k2Qa.js:1:9)')).toBe(
      'index.js',
    );
    expect(topFrame('E\n    at f (/src/use-dropdown.ts:1:1)')).toBe('use-dropdown.ts');
  });

  it('верхний кадр стека — имя файла без номера строки', () => {
    const stack =
      'TypeError: x\n    at fn (C:\\work\\apps\\web\\src\\a.tsx:10:5)\n    at b (b.ts:1:1)';
    expect(topFrame(stack)).toBe('a.tsx');
  });

  it('номер строки в стеке не меняет отпечаток', () => {
    const base: WatchSignal = { source: 'client', kind: 'window-error', message: 'x' };
    expect(fingerprintOf({ ...base, stack: 'E\n    at f (a.ts:10:1)' })).toBe(
      fingerprintOf({ ...base, stack: 'E\n    at f (a.ts:99:7)' }),
    );
  });

  it('медленный ответ и зависшая загрузка — по месту: другой текст того же маршрута — та же причина', () => {
    const slow: WatchSignal = {
      source: 'server',
      kind: 'slow-request',
      method: 'GET',
      path: '/api/skills',
      message: 'Ответ дольше порога',
    };
    expect(fingerprintOf(slow)).toBe(
      fingerprintOf({ ...slow, path: '/api/skills?x=1', message: 'Совсем другая формулировка' }),
    );
    expect(fingerprintOf(slow)).not.toBe(fingerprintOf({ ...slow, path: '/api/rules' }));
  });
});
