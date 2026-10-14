import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Страж размера чтения из набора: большой текстовый файл целиком не читается, а отказ сразу
 * отдаёт готовые окна offset/limit — большой результат инструмента (дифф MR в `tool-results`)
 * иначе просматривали поиском вместо чтения.
 */

type Verdict = { decision: string; reason: string } | null;
const guard = (
  (await import(
    pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'doc-size-guard.mjs')).href
  )) as {
    default: (input: Record<string, unknown>) => Verdict;
  }
).default;

const dir = mkdtempSync(join(tmpdir(), 'kit-doc-size-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rows = (n: number): string =>
  Array.from({ length: n }, (_, i) => `row ${i}`.padEnd(80, '.')).join('\n') + '\n';
const read = (file_path: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tool_name: 'Read',
  tool_input: { file_path, ...extra },
});

const big = join(dir, 'big.md');
writeFileSync(big, rows(1000));
mkdirSync(join(dir, 'tool-results'));
const persisted = join(dir, 'tool-results', 'diff.txt');
writeFileSync(persisted, rows(5000));

describe('doc-size-guard: окна чтения в отказе', () => {
  it('большой файл целиком — отказ с числом строк и первыми окнами', () => {
    const v = guard(read(big));
    expect(v?.decision).toBe('deny');
    expect(v?.reason).toContain('1001 lines');
    expect(v?.reason).toContain('offset=1 limit=400; offset=401 limit=400; offset=801 limit=400.');
    expect(v?.reason).not.toContain('persisted tool result');
  });

  it('результат инструмента: окон не больше восьми, остальные посчитаны, читать до конца', () => {
    const v = guard(read(persisted));
    expect(v?.reason).toContain('offset=2801 limit=400, … 5 more (13 windows)');
    expect(v?.reason).toContain('persisted tool result is read to the end');
  });

  it('чтение окном проходит', () => {
    expect(guard(read(big, { offset: 1, limit: 400 }))).toBeNull();
  });
});
