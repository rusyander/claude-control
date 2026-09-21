import { describe, expect, it } from 'vitest';
import type { PlatformToolShimReport } from '@agentdeck/contracts';
import {
  shimDropped,
  shimEmptyKind,
  showsToolShim,
  showsToolsFact,
  smokeToolsLineKind,
} from './toolShimView';

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
  dropped: 0,
  flaws: [],
  ...patch,
});

describe('пустота карточки прослойки', () => {
  it('инструменты выброшены — это не «панель ничего не знает»', () => {
    // Запросы с инструментами шли, но прослойка выключена: `idle` здесь врал бы
    // ровно там, где панель сама выбросила список и знает, чем это чинится.
    expect(shimEmptyKind(report({ dropped: 2 }))).toBe('dropped');
  });

  it('сервер прежней версии без счётчика не превращается в ноль-факт', () => {
    // `undefined > 0` прочиталось бы как «выброшенных нет» — то же незнание под
    // видом факта, от которого заведена проверка формы сводки.
    const old = report();
    delete (old as Partial<PlatformToolShimReport>).dropped;
    expect(shimDropped(old)).toBe(0);
    expect(shimEmptyKind(old)).toBe('idle');
  });

  it('карточка показывается ради выброшенных даже без контура с прослойкой', () => {
    // Условие «есть контур с прослойкой» в этом случае ложно по определению:
    // прослойка и выключена. Молчать здесь значило бы спрятать единственный
    // экран, объясняющий безрукого агента.
    expect(showsToolShim(false, true, report({ dropped: 1 }))).toBe(true);
    expect(showsToolShim(false, true, report())).toBe(false);
    expect(showsToolShim(false, false, report({ dropped: 1 }))).toBe(false);
  });

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

  it('сводка без счётчиков вызовов и заявок — не «вызовов не было»', () => {
    // Ревью Т5, m14: сервер другой версии без `calls`/`claimed` давал `quiet`,
    // то есть панель утверждала факт там, где не поняла ответ.
    const partial = { requests: 3, flaws: [] } as unknown as PlatformToolShimReport;
    expect(shimEmptyKind(partial)).toBe('none');
    expect(showsToolShim(true, true, partial)).toBe(false);
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

/**
 * Строка пробы инструментов: наклонение решается здесь, а не разметкой.
 *
 * Дорогой случай — «прослойку включила панель»: если строка при этом молчит,
 * умолчание превращается в сюрприз, о котором человек узнаёт по длине хода.
 */
describe('строка итога пробы инструментов', () => {
  const tools = { ok: false, reason: 'no-call' } as const;

  it('прослойка выключена: зовёт — зелёно, не зовёт — предложение', () => {
    expect(smokeToolsLineKind({ toolShim: false }, { ok: true })).toBe('ok');
    expect(smokeToolsLineKind({ toolShim: false }, tools)).toBe('offer');
  });

  it('включённая ПАНЕЛЬЮ прослойка отчитывается о себе, включённая человеком — молчит', () => {
    expect(
      smokeToolsLineKind({ toolShim: true, toolShimFromProbe: '2026-09-20T10:00:00.000Z' }, tools),
    ).toBe('auto');
    expect(smokeToolsLineKind({ toolShim: true }, tools)).toBe('none');
  });

  it('модель зовёт, а прослойка включена панелью прежней пробой — отчитываться не о чем', () => {
    expect(
      smokeToolsLineKind(
        { toolShim: true, toolShimFromProbe: '2026-09-20T10:00:00.000Z' },
        { ok: true },
      ),
    ).toBe('none');
  });
});
