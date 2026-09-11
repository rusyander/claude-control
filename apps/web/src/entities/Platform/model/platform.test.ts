import { describe, it, expect } from 'vitest';
import type {
  Platform,
  PlatformApplyTarget,
  PlatformBudgetState,
  PlatformStatus,
} from '@agentdeck/contracts';
import {
  isPlatformValid,
  newPlatform,
  platformBudgetAlarming,
  platformCardState,
  platformIdFromTitle,
  sortApplyTargets,
  validatePlatform,
} from './platform';

/**
 * Черновик контура и его проверки на стороне клиента.
 *
 * Здесь заперты три свойства. Новый контур выключен — иначе он применился бы до
 * первой пробы. Идентификатор из имени годится в адрес шлюза либо не годится
 * вовсе (пустая строка), но никогда не «почти годится»: слэш в нём разъехался
 * бы адресом. И бюджет ноль означает «не следить», а не «исчерпан».
 */

const platformOf = (patch: Partial<Platform> = {}): Platform => ({
  ...newPlatform('enterprise-platform', 'EnterprisePlatform · dev'),
  ...patch,
});

const targetOf = (patch: Partial<PlatformApplyTarget> = {}): PlatformApplyTarget => ({
  targetId: 'claude',
  title: 'Claude Code',
  supported: true,
  filePath: '/home/u/.claude/settings.json',
  plan: [],
  conflicts: [],
  applied: false,
  ...patch,
});

describe('новый контур', () => {
  it('выключен и никому не применён', () => {
    expect(newPlatform('enterprise-platform', 'EnterprisePlatform · dev')).toEqual({
      id: 'enterprise-platform',
      title: 'EnterprisePlatform · dev',
      driver: 'enterprise-platform',
      baseUrl: '',
      enabled: false,
      mode: 'required',
      budgetUsd: 0,
      capabilities: [],
      targets: [],
      projectPaths: [],
      // Т3: новый контур подключён к ассистенту самой панели и больше ни к
      // кому. Ни один прогон и ни один файл CLI на него не уходит, пока
      // человек не отметит потребителя сам.
      consumers: ['assistant'],
      agents: [],
      budgetSince: '',
      // Т5, решение В1: прослойка инструментов и короткий промпт контура —
      // включёнными, иначе агент через контур «работает как чат».
      toolShim: true,
      contourPrompt: true,
      caCertPath: '',
    });
  });
});

describe('идентификатор из имени', () => {
  it('схлопывает всё, что в адресе значит другое', () => {
    expect(platformIdFromTitle('EnterprisePlatform · dev')).toBe('enterprise-platform-dev');
    expect(platformIdFromTitle('EnterprisePlatform/prod 2')).toBe('enterprise-platform-prod-2');
  });

  it('имя без латиницы даёт пустую строку, а не мусор', () => {
    // Пустое поле человек заполнит сам; идентификатор из одних дефисов схема
    // отвергла бы уже на сохранении, и объяснять это было бы поздно.
    expect(platformIdFromTitle('Контур')).toBe('');
    expect(platformIdFromTitle('   ')).toBe('');
  });
});

describe('проверка черновика', () => {
  it('пустое имя, пустой адрес и негодный идентификатор названы по полям', () => {
    expect(validatePlatform(platformOf({ id: 'плохой id', title: '', baseUrl: '' }))).toEqual({
      title: 'required',
      id: 'pattern',
      baseUrl: 'required',
    });
  });

  it('чужая схема адреса отвергается кнопкой, а не сервером', () => {
    expect(validatePlatform(platformOf({ baseUrl: 'ftp://api.example.ru' })).baseUrl).toBe('url');
    expect(validatePlatform(platformOf({ baseUrl: 'не адрес' })).baseUrl).toBe('url');
    expect(validatePlatform(platformOf({ baseUrl: ' https://api.example.ru ' }))).toEqual({});
  });

  // Найдено враждебным ревью Т8: по виду дата проходила, а дня такого нет —
  // дни расхода сравниваются строкой, и период молча оставался пустым. Человек
  // видел бы «расход ≈ 0.00 из 100 $» ровно там, где тратится.
  it('несуществующий день отвергается, а не отрезает весь расход молча', () => {
    expect(validatePlatform(platformOf({ budgetSince: '2026-13-45' })).budgetSince).toBe('pattern');
    expect(validatePlatform(platformOf({ budgetSince: '2026-02-31' })).budgetSince).toBe('pattern');
    expect(validatePlatform(platformOf({ budgetSince: '01.09.2026' })).budgetSince).toBe('pattern');
    expect(validatePlatform(platformOf({ budgetSince: '2026-09-01' })).budgetSince).toBeUndefined();
    // Пусто — «с начала учёта», это не ошибка.
    expect(validatePlatform(platformOf({ budgetSince: '' })).budgetSince).toBeUndefined();
  });

  it('кнопка сохранения смотрит на ту же проверку, а не на свою', () => {
    // Иначе «Сохранить» гасла и загоралась по своим правилам, а поля объясняли
    // человеку что-то другое.
    expect(isPlatformValid(platformOf({ baseUrl: 'https://api.example.ru' }))).toBe(true);
    expect(isPlatformValid(platformOf({ baseUrl: '' }))).toBe(false);
  });
});

describe('порядок целей', () => {
  it('ассистент первый, прочерки последние, внутри группы порядок реестра', () => {
    const sorted = sortApplyTargets([
      targetOf({ targetId: 'goose', title: 'Goose', supported: false }),
      targetOf({ targetId: 'claude', title: 'Claude Code' }),
      targetOf({ targetId: 'assistant', title: 'Ассистент панели' }),
      targetOf({ targetId: 'codex', title: 'Codex' }),
      targetOf({ targetId: 'kimi', title: 'Kimi', supported: false }),
    ]);
    expect(sorted.map((item) => item.targetId)).toEqual([
      'assistant',
      'claude',
      'codex',
      'goose',
      'kimi',
    ]);
  });
});

describe('тревога по бюджету', () => {
  const budgetOf = (patch: Partial<PlatformBudgetState>): PlatformBudgetState => ({
    spentUsd: 0,
    budgetUsd: 0,
    share: 0,
    tracked: false,
    overEstimate: false,
    nearLimit: false,
    exhausted: false,
    ...patch,
  });

  it('отказ контура тревожен всегда — даже когда бюджет не введён', () => {
    expect(platformBudgetAlarming(budgetOf({ exhausted: true }))).toBe(true);
  });

  it('наша оценка тревожна, когда дошла до введённой цифры', () => {
    expect(platformBudgetAlarming(budgetOf({ tracked: true, overEstimate: true }))).toBe(true);
    // Порог внимания — ещё не тревога: полоса красится, плитка обзора молчит.
    expect(platformBudgetAlarming(budgetOf({ tracked: true, nearLimit: true }))).toBe(false);
  });

  it('без бюджета и без отказа тревожиться не о чем', () => {
    expect(platformBudgetAlarming(budgetOf({ spentUsd: 62 }))).toBe(false);
  });
});

describe('состояние карточки', () => {
  // Активный контур: сервер держит пару «активен ↔ тумблер» согласованной
  // (инвариант 1), и карточка рисуется по ней же.
  const statusOf = (patch: Partial<PlatformStatus>): PlatformStatus => ({
    platform: platformOf({ enabled: true }),
    hasToken: true,
    maskedToken: 'sk-…4f21',
    active: true,
    budget: {
      spentUsd: 0,
      budgetUsd: 0,
      share: 0,
      tracked: false,
      overEstimate: false,
      nearLimit: false,
      exhausted: false,
    },
    periodSpend: {
      day: '',
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      money: { usd: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: [] },
    },
    ...patch,
  });

  const probe = (outcome: 'ok' | 'unauthorized' | 'unreachable' | 'not-api' | 'not-ready') => ({
    outcome,
    reachable: outcome !== 'unreachable',
    url: 'https://api.example.ru/v1/models',
    detail: 'причина словами',
    models: [],
    capabilities: [],
    limits: {},
    notes: [],
    compromises: [],
    checkedAt: '2026-09-10T10:00:00.000Z',
  });

  it('неактивный контур не притворяется проверенным', () => {
    expect(
      platformCardState(statusOf({ active: false, platform: platformOf({ enabled: false }) })),
    ).toBe('disabled');
  });

  it('признак один — активность: разъехавшаяся пара читается по ней', () => {
    // Такую пару приносят чужие писатели настроек — снимок и архив переноса, —
    // и до сведения панель показывала бы «на связи» с кнопкой «сделать
    // активным» тому контуру, который шлюз уже обслуживает.
    expect(
      platformCardState(
        statusOf({ active: false, platform: platformOf({ enabled: true }), health: probe('ok') }),
      ),
    ).toBe('disabled');
  });

  it('«не проверяли» отделено от «не отвечает»', () => {
    expect(platformCardState(statusOf({}))).toBe('unchecked');
    expect(platformCardState(statusOf({ health: probe('unreachable') }))).toBe('unreachable');
    // Адрес админки вместо адреса API — тоже «не отвечает» для карточки, но
    // причину человек читает из самой пробы, а не из состояния.
    expect(platformCardState(statusOf({ health: probe('not-api') }))).toBe('unreachable');
  });

  it('отклонённый ключ — своё состояние: чинится в админке, а не адресом', () => {
    expect(platformCardState(statusOf({ health: probe('unauthorized') }))).toBe('unauthorized');
    expect(platformCardState(statusOf({ health: probe('ok') }))).toBe('ok');
  });
});
