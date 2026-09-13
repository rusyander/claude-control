import { describe, expect, it } from 'vitest';
import type { PlatformToolShimReport } from '@agentdeck/contracts';
import { shimEmptyKind, showsToolShim, showsToolsFact } from './toolShimView';

describe('showsToolsFact', () => {
  it('раздел, где все контуры получают инструменты полем, факта о тексте не показывает', () => {
    expect(showsToolsFact(['native'])).toBe(false);
    expect(showsToolsFact(['native', 'shim'])).toBe(true);
    expect(showsToolsFact(['none'])).toBe(true);
  });

  it('до первого контура факт объясняет обычную цену раздела', () => {
    expect(showsToolsFact([])).toBe(true);
  });
});

/**
 * Решения карточки «Инструменты через контур».
 *
 * Главное здесь — не перепутать незнание с фактом: «запросов с инструментами не
 * было» и «вызовов не случилось» человек читает по-разному, и второе на месте
 * первого означает, что панель утверждает то, чего не проверяла.
 */

const report = (patch: Partial<PlatformToolShimReport> = {}): PlatformToolShimReport => ({
  requests: 0,
  turns: 0,
  calls: 0,
  claimed: 0,
  flaws: [],
  ...patch,
});

describe('пустота карточки прослойки', () => {
  it('запросов с инструментами не было — это незнание, а не тишина', () => {
    expect(shimEmptyKind(report())).toBe('idle');
  });

  it('запросы шли, а вызовов не случилось — это факт', () => {
    expect(shimEmptyKind(report({ requests: 3 }))).toBe('quiet');
  });

  it('заявка без вызова тишиной не считается', () => {
    // Ходов с вызовами ноль, но сказать о них нужно: ответ выглядел удачным.
    expect(shimEmptyKind(report({ requests: 2, claimed: 1 }))).toBe('none');
  });

  it('несостоявшийся вызов тоже не тишина', () => {
    expect(
      shimEmptyKind(report({ requests: 1, flaws: [{ reason: 'блок без тега', count: 1 }] })),
    ).toBe('none');
  });

  it('сводки нет или она неполная — карточка молчит, а не падает', () => {
    expect(shimEmptyKind(undefined)).toBe('none');
    expect(shimEmptyKind({ requests: 1 } as PlatformToolShimReport)).toBe('none');
  });
});

describe('показ карточки прослойки', () => {
  it('нужен и включённый контур, и живой шлюз, и разборчивая сводка', () => {
    expect(showsToolShim(true, true, report())).toBe(true);
    expect(showsToolShim(false, true, report())).toBe(false);
    expect(showsToolShim(true, false, report())).toBe(false);
    expect(showsToolShim(true, true, undefined)).toBe(false);
  });
});
