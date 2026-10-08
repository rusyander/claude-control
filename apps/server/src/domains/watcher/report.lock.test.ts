import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchEvent } from './types.ts';

/**
 * Замок отчёта под спором на Windows: `open(замок, 'wx')`, пока сосед свой замок
 * ещё удаляет, отвечает EPERM, а не EEXIST — живой замер 08.10: три процесса,
 * ~1 ответ на 400 попыток. Замок считал EPERM чужой бедой и ронял запись
 * (полный прогон: «два процесса пишут одновременно», код писателя 1).
 * Подменён ровно ответ ОС на один `open` замка; сам замок и запись — настоящие.
 */
const busy = vi.hoisted(() => ({ left: 0, code: 'EPERM' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((path: string, flags: string, ...rest: unknown[]) => {
      if (String(path).endsWith('.lock') && flags === 'wx' && busy.left > 0) {
        busy.left -= 1;
        throw Object.assign(new Error(`${busy.code}: operation not permitted, open '${path}'`), {
          code: busy.code,
        });
      }
      return (actual.openSync as (...args: unknown[]) => number)(path, flags, ...rest);
    }) as typeof actual.openSync,
  };
});

const { sectionsOf, writeReportSections } = await import('./report.ts');

const section = (id: string): WatchEvent => ({
  id,
  ref: 'WR-1',
  entryClass: 'failure',
  severity: 'high',
  source: 'server',
  kind: 'log-error',
  message: id,
  firstSeen: 'a',
  lastSeen: 'b',
  count: 1,
  analyzedCount: 0,
});

describe('замок отчёта наблюдателя', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watch-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['EPERM', 'EACCES'])('%s на замке соседа — повтор, а не сбой записи', (code) => {
    busy.left = 2;
    busy.code = code;
    const path = join(dir, 'WATCH-REPORT.md');
    writeReportSections(path, [section('aaaaaa000001')]);
    expect(busy.left).toBe(0);
    expect([...sectionsOf(readFileSync(path, 'utf8')).keys()]).toEqual(['aaaaaa000001']);
  });
});
