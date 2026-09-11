import { describe, expect, it } from 'vitest';
import type { PlatformStatus } from '@agentdeck/contracts';
import { budgetPercent, platformProblem, platformTone } from './state';

/**
 * Состояние контура в кармане. Проверяется ПОРЯДОК ответов: у выключенного
 * контура с исчерпанным бюджетом человек должен прочитать про отказ, а не про
 * выключатель, который он и так видит в панели.
 */
const base: PlatformStatus = {
  platform: {
    id: 'enterprise-platform',
    title: 'EnterprisePlatform',
    driver: 'enterprise-platform',
    baseUrl: 'https://api.example.ru',
    enabled: true,
    mode: 'required',
    budgetUsd: 20,
    budgetSince: '',
    capabilities: [],
    targets: [],
    projectPaths: [],
    consumers: [],
    agents: [],
    caCertPath: '',
  },
  hasToken: true,
  maskedToken: 'sk-…4f21',
  active: false,
  budget: {
    spentUsd: 5,
    budgetUsd: 20,
    share: 0.25,
    tracked: true,
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
    money: { usd: 5, pricedTokens: 0, unpricedTokens: 0, unpricedModels: [] },
  },
  // Проба ЕСТЬ и она удачная: только такой контур телефон вправе назвать
  // работающим. Основа без пробы означала бы «работает» на пустом месте — и
  // ровно это здесь однажды и было записано в ожидание.
  health: health('ok'),
};

/** Итог пробы в той форме, в какой его отдаёт панель. */
function health(outcome: 'ok' | 'unreachable'): PlatformStatus['health'] {
  return {
    outcome,
    checkedAt: '2026-09-10T10:00:00.000Z',
    reachable: outcome === 'ok',
    url: 'https://api.example.ru/v1/models',
    detail: '',
    models: [],
    capabilities: [],
    limits: {},
    notes: [],
    compromises: [],
  };
}

describe('состояние контура на телефоне', () => {
  it('рабочий контур назван работающим', () => {
    expect(platformProblem(base)).toBe('ok');
  });

  it('отказ по бюджету обгоняет и выключатель, и отсутствие ключа', () => {
    const status: PlatformStatus = {
      ...base,
      hasToken: false,
      platform: { ...base.platform, enabled: false },
      budget: { ...base.budget, exhausted: true },
    };
    expect(platformProblem(status)).toBe('exhausted');
  });

  it('выключенный контур не называется «без ключа»', () => {
    expect(platformProblem({ ...base, platform: { ...base.platform, enabled: false } })).toBe(
      'off',
    );
  });

  it('включённый контур без ключа назван так, как есть', () => {
    expect(platformProblem({ ...base, hasToken: false })).toBe('noKey');
  });

  it('неудачная проба видна, удачная молчит', () => {
    expect(platformProblem({ ...base, health: health('unreachable') })).toBe('failed');
    expect(platformProblem({ ...base, health: health('ok') })).toBe('ok');
  });

  it('контур без пробы НЕ назван работающим', () => {
    // Свежая настройка, разворот архива, панель после чистки следа — панель ни
    // разу не ходила по этому адресу. Зелёное «работает» здесь было бы обещанием
    // на пустом месте, а телефон проверить не может: он только на чтение.
    const { health: _health, ...neverProbed } = base;
    expect(platformProblem(neverProbed)).toBe('unchecked');
    expect(platformTone('unchecked')).toBe('quiet');
    expect(platformTone('failed')).toBe('bad');
    expect(platformTone('ok')).toBe('ok');
  });

  it('доля бюджета не вылезает за 100 %, каким бы ни пришёл ответ', () => {
    expect(budgetPercent(base)).toBe(25);
    expect(budgetPercent({ ...base, budget: { ...base.budget, share: 1.7 } })).toBe(100);
    expect(budgetPercent({ ...base, budget: { ...base.budget, share: -1 } })).toBe(0);
  });
});
