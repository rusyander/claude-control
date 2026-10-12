import { describe, expect, it } from 'vitest';
import { parseLogLine, passesLevel } from './logParse';
import { MAX_SNIPPET_CHARS, maskSecrets, snippetAround } from './logPrompt';
import { countLevels, filterRows, parseEntries, splitMatches } from './logView';

const entries = (...texts: string[]) => texts.map((text, id) => ({ id, text }));

describe('отбор строк', () => {
  const rows = parseEntries(
    entries(
      '{"level":"error","msg":"db down"}',
      '    at connect (db.js:3)',
      'level=info msg=started',
      'GET /health 200',
      '[WARN] slow query',
    ),
  );

  it('порог уровня: стек ошибки остаётся с ней, строки без уровня скрыты', () => {
    expect(filterRows(rows, { search: '', level: 'error' }).map((row) => row.entry.id)).toEqual([
      0, 1,
    ]);
    expect(filterRows(rows, { search: '', level: 'warn' }).map((row) => row.entry.id)).toEqual([
      0, 1, 4,
    ]);
    expect(filterRows(rows, { search: '' })).toHaveLength(5);
  });

  it('поиск без учёта регистра, вместе с уровнем', () => {
    expect(filterRows(rows, { search: 'HEALTH' }).map((row) => row.entry.id)).toEqual([3]);
    expect(filterRows(rows, { search: 'slow', level: 'error' })).toEqual([]);
  });

  it('счётчики уровней и куски подсветки', () => {
    expect(countLevels(rows)).toEqual({ error: 2, warn: 1, info: 1, debug: 0 });
    expect(splitMatches('Error: error!', 'ERROR')).toEqual(['', 'Error', ': ', 'error', '!']);
    expect(splitMatches('plain', '')).toEqual(['plain']);
  });

  it('разбор кешируется на строке: повторный проход отдаёт тот же объект', () => {
    const list = entries('[ERROR] boom');
    expect(parseEntries(list)[0]?.parsed).toBe(parseEntries(list)[0]?.parsed);
  });
});

describe('уровень строки', () => {
  it.each([
    ['{"level":"error","msg":"db down","attempt":3}', 'error'],
    ['{"level":40,"msg":"slow"}', 'warn'],
    ['{"severity":"INFO","message":"ok"}', 'info'],
    ['time=2026-10-12 level=warn msg="disk 90%"', 'warn'],
    ['2026-10-12 10:00:00.123 ERROR 4242 --- [main] o.s.boot.SpringApplication : failed', 'error'],
    ['ERROR:root:cannot connect', 'error'],
    ['2026/10/12 10:00:00 [error] 7#7: *1 connect() failed', 'error'],
    ['[DEBUG] cache miss', 'debug'],
    ['panic: runtime error: index out of range', 'error'],
    ['java.lang.IllegalStateException: closed', 'error'],
    ['GET /health 200 3ms', undefined],
    ['the error rate dashboard', undefined],
  ])('%s → %s', (text, level) => {
    expect(parseLogLine(text).level).toBe(level);
  });

  it('JSON: сообщение и поля без уровня и времени', () => {
    expect(
      parseLogLine('{"ts":1,"level":"error","msg":"db down","attempt":3,"err":{"code":"E1"}}'),
    ).toEqual({
      level: 'error',
      message: 'db down',
      fields: [
        ['attempt', '3'],
        ['err', '{"code":"E1"}'],
      ],
    });
  });

  it('стек вызовов наследует уровень строки выше, без неё — нет', () => {
    expect(parseLogLine('    at Server.listen (net.js:1)', 'error')).toMatchObject({
      level: 'error',
      continuation: true,
    });
    expect(parseLogLine('    at Server.listen (net.js:1)').level).toBeUndefined();
  });

  it('порог «уровень и важнее»: без уровня скрыто при пороге', () => {
    expect(passesLevel('error', 'warn')).toBe(true);
    expect(passesLevel('info', 'warn')).toBe(false);
    expect(passesLevel(undefined, 'warn')).toBe(false);
    expect(passesLevel(undefined)).toBe(true);
  });
});

describe('просьба агенту', () => {
  it('секреты замаскированы во всех видах записи, остальное как было', () => {
    const text = [
      'password=hunter2 user=bob',
      '{"api_key":"sk-123","id":7}',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      'connect postgres://shop:s3cret@db:5432/shop failed',
      'DB_TOKEN: abc123',
    ].join('\n');
    const masked = maskSecrets(text);
    for (const secret of ['hunter2', 'sk-123', 'eyJhbGciOiJIUzI1NiJ9', 's3cret', 'abc123']) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain('user=bob');
    expect(masked).toContain('"id":7');
    expect(masked).toContain('postgres://shop:••••@db:5432/shop');
  });

  it('строки вокруг выбранной: 20 с каждой стороны, предел размера', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    expect(snippetAround(lines, 50)).toMatchObject({ from: 30, to: 70 });
    expect(snippetAround(lines, 2)).toMatchObject({ from: 0, to: 22 });
    const long = Array.from({ length: 41 }, () => 'x'.repeat(500));
    const cut = snippetAround(long, 20);
    expect(cut.text.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(cut.from).toBeLessThanOrEqual(20);
    expect(cut.to).toBeGreaterThanOrEqual(20);
  });
});
