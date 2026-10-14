import { describe, expect, it } from 'vitest';
import {
  bestMatching,
  compareVersions,
  formatVersion,
  parseVersion,
  satisfiesRange,
  wantedRange,
  type Triple,
} from './runtime-range.ts';

const v = (text: string): Triple => parseVersion(text) as Triple;

describe('parseVersion', () => {
  it('читает префикс v, короткие и суффиксные записи', () => {
    expect(parseVersion('v22.22.2')).toEqual([22, 22, 2]);
    expect(parseVersion('22')).toEqual([22, 0, 0]);
    expect(parseVersion('Python 3.12.1rc1')).toEqual([3, 12, 1]);
    expect(parseVersion('go version go1.25.3 windows/amd64')).toEqual([1, 25, 3]);
    expect(parseVersion('lts/*')).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
  });

  it('сравнивает по частям, а не строкой', () => {
    expect(compareVersions(v('22.9.0'), v('22.10.0'))).toBe(-1);
    expect(compareVersions(v('24.13.0'), v('22.22.2'))).toBe(1);
    expect(compareVersions(v('3.12.0'), v('3.12.0'))).toBe(0);
    expect(formatVersion(v('v20.17'))).toBe('20.17.0');
  });
});

describe('satisfiesRange', () => {
  it('диапазон из engines: >=22.22.2 <23 — ровно то, что отвергло Node 24', () => {
    expect(satisfiesRange(v('24.13.0'), '>=22.22.2 <23')).toBe(false);
    expect(satisfiesRange(v('22.21.1'), '>=22.22.2 <23')).toBe(false);
    expect(satisfiesRange(v('22.22.2'), '>=22.22.2 <23')).toBe(true);
    expect(satisfiesRange(v('22.30.0'), '>=22.22.2 <23')).toBe(true);
    // Пробел после оператора и `&&` — тоже записи из реальных package.json.
    expect(satisfiesRange(v('22.30.0'), '>= 22.22.2 && < 23')).toBe(true);
  });

  it('линия, точная версия, каретка, тильда', () => {
    expect(satisfiesRange(v('22.21.1'), '22')).toBe(true);
    expect(satisfiesRange(v('23.0.0'), '22')).toBe(false);
    expect(satisfiesRange(v('3.12.7'), '3.12')).toBe(true);
    expect(satisfiesRange(v('3.13.0'), '3.12')).toBe(false);
    expect(satisfiesRange(v('22.22.2'), 'v22.22.2')).toBe(true);
    expect(satisfiesRange(v('22.22.3'), '22.22.2')).toBe(false);
    expect(satisfiesRange(v('22.9.0'), '^22.1.0')).toBe(true);
    expect(satisfiesRange(v('23.0.0'), '^22.1.0')).toBe(false);
    expect(satisfiesRange(v('22.1.9'), '~22.1.0')).toBe(true);
    expect(satisfiesRange(v('22.2.0'), '~22.1.0')).toBe(false);
  });

  it('альтернативы и запятая питоновского requires-python', () => {
    expect(satisfiesRange(v('20.17.0'), '^20.0.0 || ^22.0.0')).toBe(true);
    expect(satisfiesRange(v('21.0.0'), '^20.0.0 || ^22.0.0')).toBe(false);
    expect(satisfiesRange(v('3.12.4'), '>=3.9,<3.13')).toBe(true);
    expect(satisfiesRange(v('3.14.0'), '>=3.9,<3.13')).toBe(false);
  });

  it('непонятная запись — undefined, а не «не подходит»', () => {
    expect(satisfiesRange(v('24.0.0'), 'lts/iron')).toBeUndefined();
    expect(satisfiesRange(v('24.0.0'), '')).toBeUndefined();
  });
});

describe('wantedRange', () => {
  it('алиасы менеджеров версий не требование', () => {
    expect(wantedRange('lts/*')).toBeUndefined();
    expect(wantedRange('node')).toBeUndefined();
    expect(wantedRange('system')).toBeUndefined();
    expect(wantedRange('  ')).toBeUndefined();
    expect(wantedRange('v22.22.2\n')).toBe('v22.22.2');
    expect(wantedRange('>=22.22.2 <23')).toBe('>=22.22.2 <23');
  });
});

describe('bestMatching', () => {
  it('берёт самую новую из подходящих', () => {
    const list = ['20.17.0', '22.21.1', '22.22.2', '24.13.0'].map((text) => ({
      text,
      version: v(text),
    }));
    expect(bestMatching(list, '>=22 <23')?.text).toBe('22.22.2');
    expect(bestMatching(list, '>=22.22.2 <23')?.text).toBe('22.22.2');
    expect(bestMatching(list, '>=22.30 <23')).toBeUndefined();
    expect(bestMatching(list, '^20')?.text).toBe('20.17.0');
  });
});
