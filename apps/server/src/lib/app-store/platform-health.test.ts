import { describe, it, expect } from 'vitest';
import type { PlatformHealthRecord } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';
import { getPlatformHealth, savePlatformHealth } from './platform-health.ts';

/**
 * След пробы контура: что переживает неудачу, а что нет.
 *
 * Тут решается судьба каталога моделей при обрыве связи, поэтому проверяется
 * ровно то, что человек увидит на экране: список не пропал, пропавшая модель
 * названа пропавшей, а «не отвечает сейчас» не превратилось в «моделей нет».
 */

const ok = (models: string[], checkedAt: string): PlatformHealthRecord => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.example.ru/v1/models',
  detail: '',
  models: models.map((id) => ({ id })),
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt,
});

const failed = (checkedAt: string): PlatformHealthRecord => ({
  ...ok([], checkedAt),
  outcome: 'unreachable',
  reachable: false,
  detail: 'Нет связи с контуром.',
});

const emptyState = (): AppState => ({}) as AppState;

describe('savePlatformHealth: что переживает неудачную пробу', () => {
  it('список моделей остаётся, и рядом стоит дата последнего успеха', () => {
    // Неудачная проба возвращает пустой каркас. Затирание превратило бы любой
    // обрыв сети в пустой каталог — то есть в «ключу больше ничего не выдано».
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', failed('2026-09-10T12:00:00.000Z'));

    const record = getPlatformHealth(state).g!;
    expect(record.outcome).toBe('unreachable');
    expect(record.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(record.lastOkAt).toBe('2026-09-10T10:00:00.000Z');
    expect(record.checkedAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('матрица возможностей остаётся: неудачная проба ничего не отменяет', () => {
    // Иначе карточка после обрыва связи пишет «панель ничего не утверждает о
    // контуре, пока не сходила к нему» — по контуру, к которому она ходила час
    // назад и чей ответ у неё на руках.
    const state = emptyState();
    savePlatformHealth(state, 'g', {
      ...ok(['a'], '2026-09-10T10:00:00.000Z'),
      capabilities: [{ id: 'models', state: 'yes', detail: 'список ключа', evidence: 'answer' }],
      limits: { nonStreamTimeoutSec: 30 },
      notes: ['контур отвечает потоком'],
    });
    savePlatformHealth(state, 'g', failed('2026-09-10T12:00:00.000Z'));

    const record = getPlatformHealth(state).g!;
    expect(record.capabilities.map((c) => c.id)).toEqual(['models']);
    expect(record.limits.nonStreamTimeoutSec).toBe(30);
    expect(record.notes).toEqual(['контур отвечает потоком']);
    // А исход и причина — от нынешней пробы, иначе экран соврал бы про связь.
    expect(record.outcome).toBe('unreachable');
    expect(record.detail).toBe('Нет связи с контуром.');
  });

  it('неудачная проба не объявляет модели пропавшими', () => {
    // Иначе первый же обрыв сети пометил бы «пропала у контура» весь список.
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', failed('2026-09-10T12:00:00.000Z'));

    expect(getPlatformHealth(state).g!.retired).toBeUndefined();
  });
});

describe('savePlatformHealth: пропавшие модели', () => {
  it('исчезнувшая из ответа модель помечается и помнит, когда её видели', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T12:00:00.000Z'));

    expect(getPlatformHealth(state).g!.retired).toEqual([
      { id: 'b', retired: true, lastSeenAt: '2026-09-10T10:00:00.000Z' },
    ]);
  });

  it('«видели тогда-то» — дата последнего УСПЕХА, а не последней пробы', () => {
    // Между двумя удачными пробами может лежать сколько угодно неудачных. Взяв
    // дату неудачной, карточка называла бы «последней встречей» минуту, в
    // которую контур не ответил ничего.
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', failed('2026-09-10T12:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T14:00:00.000Z'));

    expect(getPlatformHealth(state).g!.retired).toEqual([
      { id: 'b', retired: true, lastSeenAt: '2026-09-10T10:00:00.000Z' },
    ]);
  });

  it('вернувшаяся модель пометку теряет', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T12:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T14:00:00.000Z'));

    expect(getPlatformHealth(state).g!.retired).toBeUndefined();
  });

  it('пропавшая раньше не задваивается и не молодеет', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T12:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T14:00:00.000Z'));

    expect(getPlatformHealth(state).g!.retired).toEqual([
      { id: 'b', retired: true, lastSeenAt: '2026-09-10T10:00:00.000Z' },
    ]);
  });
});

describe('savePlatformHealth: новинки контура', () => {
  it('на первой удачной пробе новинок нет', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));

    expect(getPlatformHealth(state).g!.newIds).toBeUndefined();
    expect(getPlatformHealth(state).g!.knownIds).toEqual(['a', 'b']);
  });

  it('появившаяся модель названа новинкой ровно один раз', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T12:00:00.000Z'));
    expect(getPlatformHealth(state).g!.newIds).toEqual(['b']);

    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T14:00:00.000Z'));
    expect(getPlatformHealth(state).g!.newIds).toBeUndefined();
  });

  it('вернувшаяся модель новинкой не считается', () => {
    const state = emptyState();
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T10:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T12:00:00.000Z'));
    savePlatformHealth(state, 'g', ok(['a', 'b'], '2026-09-10T14:00:00.000Z'));

    expect(getPlatformHealth(state).g!.newIds).toBeUndefined();
  });
});

describe('getPlatformHealth: записи прошлых версий панели', () => {
  it('строки вместо объектов читаются как модели, а не роняют раздел', () => {
    // Ровно то, что лежит в state.json у человека, обновившего панель: схемой
    // этот срез не проверяется, и старый формат приезжает как есть.
    const state = {
      platformHealth: { g: { ...ok([], 'x'), models: ['a', 'b'] } },
    } as unknown as AppState;

    expect(getPlatformHealth(state).g!.models).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('запись без списка моделей вовсе не роняет запись новой пробы', () => {
    const state = { platformHealth: { g: { outcome: 'ok' } } } as unknown as AppState;
    savePlatformHealth(state, 'g', ok(['a'], '2026-09-10T10:00:00.000Z'));

    expect(getPlatformHealth(state).g!.models).toEqual([{ id: 'a' }]);
  });

  it('у записи без списков они пустые, а не отсутствующие', () => {
    // Импорт настроек с чужой машины кладёт сюда что угодно: срез не проверяется
    // схемой. Карточка контура читает `capabilities.length` и `notes.map` без
    // страховки — по обещанию типа, которого такая запись не выполняет, и весь
    // раздел уходил в экран ошибки.
    const state = { platformHealth: { g: { outcome: 'ok' } } } as unknown as AppState;

    const record = getPlatformHealth(state).g!;
    expect(record.capabilities).toEqual([]);
    expect(record.notes).toEqual([]);
    expect(record.compromises).toEqual([]);
    expect(record.limits).toEqual({});
  });
});
