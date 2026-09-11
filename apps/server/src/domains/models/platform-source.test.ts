import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import { isPlatformCatalogStale, resolvePlatformSource } from './catalog-source.ts';
import { platformModels } from './platform-catalog.ts';

/**
 * Источник каталога «контур»: когда он работает и что показывает.
 *
 * Проверяется прежде всего ЧЕСТНОСТЬ отката: подменить список того, чем человек
 * может пользоваться, и промолчать нельзя, а причин у подмены пять, и чинятся
 * они в разных местах.
 */

const platform = (overrides: Partial<Platform> = {}): Platform =>
  ({
    id: 'enterprise-platform',
    title: 'Контур компании',
    driver: 'enterprise-platform',
    baseUrl: 'https://api.example.ru',
    enabled: true,
    mode: 'best-effort',
    capabilities: [],
    agents: [],
    budgetSince: '',
    caCertPath: '',
    ...overrides,
  }) as Platform;

const health = (overrides: Partial<PlatformHealthRecord> = {}): PlatformHealthRecord => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.example.ru/v1/models',
  detail: '',
  models: [{ id: 'gpt-4o' }],
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt: '2026-09-10T10:00:00.000Z',
  lastOkAt: '2026-09-10T10:00:00.000Z',
  ...overrides,
});

describe('resolvePlatformSource: пять причин отката, и каждая названа', () => {
  it('контур выбран источником, но не назван', () => {
    const decision = resolvePlatformSource({
      platformId: '',
      platform: undefined,
      hasToken: false,
      health: undefined,
    });
    expect(decision).toEqual({ ok: false, fallback: 'no-platform' });
  });

  it('названный контур пропал из настроек', () => {
    const decision = resolvePlatformSource({
      platformId: 'gone',
      platform: undefined,
      hasToken: false,
      health: undefined,
    });
    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ fallback: 'platform-gone' });
  });

  it('контур выключен — и его имя едет вместе с причиной', () => {
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform({ enabled: false }),
      hasToken: true,
      health: health(),
    });
    // Имя нужно строке на экране: идентификатор человек не выбирал.
    expect(decision).toMatchObject({ fallback: 'platform-off' });
    expect(decision.ok === false && decision.platform?.title).toBe('Контур компании');
  });

  it('ключа нет — та же беда, что и выключенный: панель к контуру не пойдёт', () => {
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform(),
      hasToken: false,
      health: health(),
    });
    expect(decision).toMatchObject({ fallback: 'platform-off' });
  });

  it('контур ни разу не проверяли', () => {
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform(),
      hasToken: true,
      health: undefined,
    });
    expect(decision).toMatchObject({ fallback: 'never-checked' });
  });

  it('контур не отвечал ни разу — это не то же самое, что «не отвечает сейчас»', () => {
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform(),
      hasToken: true,
      health: health({ outcome: 'unreachable', lastOkAt: undefined, models: [] }),
    });
    expect(decision).toMatchObject({ fallback: 'never-answered' });
  });
});

describe('resolvePlatformSource: когда контур всё-таки источник', () => {
  it('неудачная проба при бывшем успехе работает по сохранённому списку', () => {
    // Это и есть офлайн каталога: список пережил обрыв вместе с датой успеха.
    const record = health({ outcome: 'unreachable', checkedAt: '2026-09-10T12:00:00.000Z' });
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform(),
      hasToken: true,
      health: record,
    });

    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.health.models).toHaveLength(1);
  });

  it('удачная проба без единой модели откатом НЕ считается', () => {
    // «Ключу не выдано ни одной модели» — это ответ контура, и подменять его
    // чужим списком значило бы скрыть настоящее положение дел с ключом.
    const decision = resolvePlatformSource({
      platformId: 'enterprise-platform',
      platform: platform(),
      hasToken: true,
      health: health({ models: [] }),
    });
    expect(decision.ok).toBe(true);
  });
});

describe('isPlatformCatalogStale: давность считается по успеху', () => {
  afterEach(() => vi.useRealTimers());

  it('свежий успех — не устарел, даже если проба только что провалилась', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T11:00:00.000Z'));

    const record = health({ outcome: 'unreachable', checkedAt: '2026-09-10T11:00:00.000Z' });
    expect(isPlatformCatalogStale(record, 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('успех недельной давности устарел, хотя проба была минуту назад', () => {
    // Неудачная проба списка не подтверждала — молодить его ею нельзя.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'));

    const record = health({ outcome: 'unreachable', checkedAt: '2026-09-17T09:59:00.000Z' });
    expect(isPlatformCatalogStale(record, 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('нечитаемая дата считается устаревшей, а не вечно свежей', () => {
    const record = health({ lastOkAt: 'позавчера', checkedAt: 'позавчера' });
    expect(isPlatformCatalogStale(record, 24 * 60 * 60 * 1000)).toBe(true);
  });
});

describe('platformModels: ответ контура в общем виде каталога', () => {
  it('семейства и даты выхода нет — автозамена дефолта опоры не получает', () => {
    // Вывести семейство из имени модели значило бы дать панели переставлять
    // дефолт по выдуманному родству (инвариант 13).
    const models = platformModels(health({ models: [{ id: 'claude-opus-4-8' }] }), 'enterprise-platform');

    expect(models[0]!.family).toBe('');
    expect(models[0]!.releaseDate).toBeUndefined();
  });

  it('вендор берётся у контура, а без него — сам контур', () => {
    const models = platformModels(
      health({ models: [{ id: 'a', ownedBy: 'yandex' }, { id: 'b' }] }),
      'enterprise-platform',
    );

    expect(models.map((m) => m.vendor)).toEqual(['yandex', 'enterprise-platform']);
  });

  it('объявленные флаги переносятся, включая объявленное «нет»', () => {
    const models = platformModels(
      health({ models: [{ id: 'a', vision: false, jsonMode: true, kind: 'chat' }] }),
      'enterprise-platform',
    );

    expect(models[0]).toMatchObject({ vision: false, jsonMode: true, kind: 'chat' });
    // Того, чего контур не объявил, в записи нет вовсе — не `false`.
    expect(models[0]!.functionCalling).toBeUndefined();
  });

  it('пропавшие показываются, но в конце списка', () => {
    const models = platformModels(
      health({
        models: [{ id: 'b' }],
        retired: [{ id: 'a', retired: true, lastSeenAt: '2026-09-09T10:00:00.000Z' }],
      }),
      'enterprise-platform',
    );

    expect(models.map((m) => m.id)).toEqual(['b', 'a']);
    expect(models[1]!.retired).toBe(true);
    expect(models[1]!.lastSeenAt).toBe('2026-09-09T10:00:00.000Z');
  });
});
