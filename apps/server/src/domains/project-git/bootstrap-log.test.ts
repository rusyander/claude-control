import { describe, expect, it } from 'vitest';
import { firstErrorLine, quietLog } from './bootstrap-log.ts';

/**
 * Лог из живого ревью MR (13.10.2026): `npm ci` на Node 24 при `.nvmrc` 22 —
 * два с половиной килобайта `npm warn EBADENGINE`, и только потом причина.
 */
const NOISY = [
  '$ npm ci --prefer-offline --no-audit --no-fund',
  '[2026-10-13T14:01:00.000Z] cwd: C:/work/copy',
  '',
  'npm warn EBADENGINE Unsupported engine {',
  "npm warn EBADENGINE   package: 'app@1.0.0',",
  "npm warn EBADENGINE   required: { node: '>=22.22.2 <23' },",
  "npm warn EBADENGINE   current: { node: 'v24.13.0', npm: '11.6.2' }",
  'npm warn EBADENGINE }',
  'npm warn deprecated inflight@1.0.6: This module is not supported',
  'npm error code ELIFECYCLE',
  'npm error command failed',
  'npm error A complete log of this run can be found in: C:/x/_logs/1.log',
  '',
  '[2026-10-13T14:02:00.000Z] код 2',
].join('\n');

describe('quietLog', () => {
  it('убирает предупреждения установщиков, ошибки оставляет', () => {
    const quiet = quietLog(NOISY);
    expect(quiet).not.toContain('EBADENGINE');
    expect(quiet).not.toContain('deprecated');
    expect(quiet).toContain('npm error code ELIFECYCLE');
    expect(quiet.length).toBeLessThan(NOISY.length / 2);
  });

  it('узнаёт предупреждения с меткой каталога, pnpm и yarn', () => {
    const text = [
      '[web] npm warn EBADENGINE x',
      ' WARN  deprecated y@1',
      'warning foo',
      'ok line',
    ].join('\n');
    expect(quietLog(text)).toBe('ok line');
  });
});

describe('firstErrorLine', () => {
  it('первая строка настоящей ошибки, а не предупреждение и не служебная строка панели', () => {
    expect(firstErrorLine(NOISY)).toBe('npm error code ELIFECYCLE');
  });

  it('нет строки с признаком ошибки — последняя значащая после отсева шума', () => {
    const log = [
      '$ make setup',
      '[2026-10-13T14:00:00.000Z] cwd: x',
      'compiling…',
      'stopped here',
    ].join('\n');
    expect(firstErrorLine(log)).toBe('stopped here');
  });

  it('длинная строка режется, пустой лог — ничего', () => {
    const long = `error: ${'x'.repeat(500)}`;
    expect((firstErrorLine(long) ?? '').length).toBeLessThanOrEqual(301);
    expect(firstErrorLine('')).toBeUndefined();
    expect(firstErrorLine('$ cmd\n[2026-10-13T14:00:00.000Z] код 0')).toBeUndefined();
  });
});
