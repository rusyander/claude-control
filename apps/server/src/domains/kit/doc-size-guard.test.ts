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

  it('результат инструмента до 96 КБ читается целиком; тот же размер вне tool-results — отказ', () => {
    const mid = join(dir, 'tool-results', 'diff-mid.txt');
    writeFileSync(mid, rows(1000));
    expect(guard(read(mid))).toBeNull();
    expect(guard(read(big))?.decision).toBe('deny');
  });

  it('чтение окном проходит', () => {
    expect(guard(read(big, { offset: 1, limit: 400 }))).toBeNull();
  });
});

// Бриф полосы ревью — и есть её задача: заглушка спавна велит прочесть его одним Read, а отказ на
// 31 КБ стоил измеренному ревью 6 ошибок на 66 чтениях. Исключение — только это имя и место.
describe('doc-size-guard: бриф полосы ревью читается целиком', () => {
  const at = (rel: string): string => {
    const f = join(dir, ...rel.split('/'));
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, rows(500));
    return f;
  };

  it('lane-*prompt.md в review-<slug>/plan/ и в review-<slug>/ — целиком, с любым слэшем', () => {
    const inPlan = at('.agent/tmp/review-g9/plan/lane-A1-r1.prompt.md');
    const inRoot = at('.agent/tmp/review-g9/lane-B2-r3-prompt.md');
    for (const f of [inPlan, inRoot, inPlan.replace(/\\/g, '/'), inRoot.replace(/\\/g, '/')])
      expect(guard(read(f))).toBeNull();
  });

  // Бриф перезапуска `lane-A-prompt-r2.md` получал отказ: «prompt» в середине имени — всё тот же бриф.
  it('бриф с prompt в середине имени (перезапуск) — тоже целиком', () => {
    expect(guard(read(at('.agent/tmp/review-x/lane-A-prompt-r2.md')))).toBeNull();
    expect(guard(read(at('.agent/tmp/review-x/plan/lane-B1.prompt.v2.md')))).toBeNull();
  });

  it.each([
    ['отчёт полосы, не бриф', '.agent/tmp/review-g9/lane-A1.md'],
    ['plan.md рядом с брифами', '.agent/tmp/review-g9/plan/plan.md'],
    ['бриф вне review-<slug>/', '.agent/tmp/other/lane-A1-r1.prompt.md'],
    ['бриф на два уровня глубже', '.agent/tmp/review-g9/plan/x/lane-A1-r1.prompt.md'],
    ['бриф вне .agent/tmp', 'docs/review-g9/plan/lane-A1-r1.prompt.md'],
  ])('%s — по-прежнему отказ', (_name, rel) => {
    expect(guard(read(at(rel)))?.decision).toBe('deny');
  });
});
