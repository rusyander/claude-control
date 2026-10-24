import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { economyRunEnv } from './economy-run.ts';
import {
  GOOSE_COMPACT_THRESHOLD_ENV,
  GOOSE_CONTEXT_LIMIT_ENV,
  GOOSE_TOOL_RESPONSE_ENV,
  gooseCatalogWindow,
  gooseEconomyEnv,
  gooseToolResponseLimit,
} from './goose.ts';

/**
 * @covers goose.ts
 * @scenario рычаги группы Goose — переменными окружения запуска (живые пробы goose
 *   1.54.0): доля сжатия от окна, которое знает Goose (окружение, config.yaml, окно
 *   локальной модели или облачной по каталогу моделей панели — тогда и само окно), потолок ответа инструмента в знаках —
 *   больший из двух рычагов; срок кэша не пишется (проба: запрос не меняется).
 */

const BASE = { env: {}, appData: '/data' };
// Окружение сервера подменено пустым: тест не зависит от `GOOSE_*` машины, где идёт.
const noConfig = { readConfig: () => ({}), processEnv: {} };
const levers = (bashOutputChars: number, readOutputTokens: number) => ({
  ...GROUP_ECONOMY_DEFAULTS,
  bashOutputChars,
  readOutputTokens,
});

describe('economy-run goose', () => {
  it('env per lever', () => {
    const env = gooseEconomyEnv(
      {
        ...BASE,
        env: { [GOOSE_CONTEXT_LIMIT_ENV]: '400000' },
        economy: { ...levers(8_000, 10_000), cacheTtl: '1h' },
        compactWindow: 160_000,
      },
      noConfig,
    );
    // 160k из 400k = 0.4; потолок — max(8000, 10000 × 4) = 40000 знаков; срока кэша нет.
    expect(env).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.4',
      [GOOSE_TOOL_RESPONSE_ENV]: '40000',
    });
  });

  it('window from config.yaml when env has none; env wins over config', () => {
    const fromConfig = gooseEconomyEnv(
      { ...BASE, compactWindow: 100_000 },
      { readConfig: () => ({ GOOSE_CONTEXT_LIMIT: 300_000 }), processEnv: {} },
    );
    expect(fromConfig).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.3333' });
    const envWins = gooseEconomyEnv(
      { ...BASE, env: { [GOOSE_CONTEXT_LIMIT_ENV]: '200000' }, compactWindow: 100_000 },
      { readConfig: () => ({ GOOSE_CONTEXT_LIMIT: 300_000 }), processEnv: {} },
    );
    expect(envWins).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5' });
  });

  it('local model window is handed to goose together with the fraction', () => {
    const env = gooseEconomyEnv(
      { ...BASE, compactWindow: 100_000, localContextWindow: 128_000 },
      noConfig,
    );
    expect(env).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.7813',
      [GOOSE_CONTEXT_LIMIT_ENV]: '128000',
    });
  });

  it('no threshold when the window is unknown or the group window is not smaller', () => {
    expect(gooseEconomyEnv({ ...BASE, compactWindow: 160_000 }, noConfig)).toBeUndefined();
    expect(
      gooseEconomyEnv(
        { ...BASE, env: { [GOOSE_CONTEXT_LIMIT_ENV]: '128000' }, compactWindow: 160_000 },
        noConfig,
      ),
    ).toBeUndefined();
    // Равное окно — доля 1, то есть «как без рычага»: ключ не пишется.
    expect(
      gooseEconomyEnv(
        { ...BASE, env: { [GOOSE_CONTEXT_LIMIT_ENV]: '160000' }, compactWindow: 160_000 },
        noConfig,
      ),
    ).toBeUndefined();
    // Чуть меньше окна — доля округлилась бы до 1: тоже не пишется.
    expect(
      gooseEconomyEnv(
        { ...BASE, env: { [GOOSE_CONTEXT_LIMIT_ENV]: '1000000' }, compactWindow: 999_990 },
        noConfig,
      ),
    ).toBeUndefined();
    expect(
      gooseEconomyEnv(
        { ...BASE, env: { [GOOSE_CONTEXT_LIMIT_ENV]: 'junk' }, compactWindow: 160_000 },
        { readConfig: () => ({ GOOSE_CONTEXT_LIMIT: 'also junk' }), processEnv: {} },
      ),
    ).toBeUndefined();
    expect(gooseEconomyEnv({ ...BASE, localContextWindow: 128_000 }, noConfig)).toBeUndefined();
  });

  it('tool response limit in chars = max(bash, read × 4); zero on either — no key', () => {
    expect(gooseToolResponseLimit(levers(8_000, 1_000))).toBe(8_000);
    expect(gooseToolResponseLimit(levers(4_000, 2_500))).toBe(10_000);
    expect(gooseToolResponseLimit(levers(0, 10_000))).toBeUndefined();
    expect(gooseToolResponseLimit(levers(8_000, 0))).toBeUndefined();
    expect(gooseToolResponseLimit(undefined)).toBeUndefined();
  });

  it('dispatcher routes the goose channel; no levers — nothing to change', () => {
    expect(
      economyRunEnv('goose', {
        ...BASE,
        env: { [GOOSE_CONTEXT_LIMIT_ENV]: '400000' },
        economy: levers(8_000, 10_000),
      }),
    ).toEqual({ [GOOSE_TOOL_RESPONSE_ENV]: '40000' });
    expect(
      gooseEconomyEnv({ ...BASE, economy: levers(0, 0), compactWindow: 0 }, noConfig),
    ).toBeUndefined();
  });
});

/**
 * Облачная модель без `GOOSE_CONTEXT_LIMIT` — обычный случай (ревью D, F1): окно
 * берётся из каталога моделей панели по модели хода (`GOOSE_MODEL`), вендор — по
 * провайдеру Goose (`GOOSE_PROVIDER`) или приставке `вендор/модель`.
 */
describe('economy-run goose catalog window', () => {
  let appData: string;
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-goose-economy-'));
  });
  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
  });
  const seedCatalog = (models: { id: string; vendor: string; contextLimit?: number }[]): void => {
    writeFileSync(
      join(appData, 'models-cache.json'),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        url: 'https://models.dev/api.json',
        models: models.map((m) => ({ ...m, name: m.id, family: m.id })),
        knownIds: [],
        newIds: [],
      }),
    );
  };
  const catalog = (): void =>
    seedCatalog([
      { id: 'claude-sonnet-4-5', vendor: 'anthropic', contextLimit: 200_000 },
      // Тот же id у другого вендора — другое окно: вендор выбирается по провайдеру Goose.
      { id: 'claude-sonnet-4-5', vendor: 'opencode', contextLimit: 1_000_000 },
      { id: 'gpt-5', vendor: 'openai', contextLimit: 400_000 },
      { id: 'no-limit', vendor: 'openai' },
    ]);
  const ANTHROPIC = { GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-sonnet-4-5' };

  it('cloud model from GOOSE_MODEL: threshold and the catalog window', () => {
    catalog();
    const env = gooseEconomyEnv({ env: ANTHROPIC, appData, compactWindow: 160_000 }, noConfig);
    // 160k из 200k = 0.8; окно уходит вместе с долей, чтобы Goose считал от того же числа.
    expect(env).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.8',
      [GOOSE_CONTEXT_LIMIT_ENV]: '200000',
    });
  });

  it('model and provider: run env > server env > config.yaml; chat model ignored', () => {
    catalog();
    const readConfig = () => ({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'gpt-5' });
    const fromConfig = { readConfig, processEnv: {} };
    expect(gooseEconomyEnv({ env: {}, appData, compactWindow: 100_000 }, fromConfig)).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.25',
      [GOOSE_CONTEXT_LIMIT_ENV]: '400000',
    });
    // Окружение сервера (его унаследует Goose) главнее config.yaml, как у самого Goose.
    const serverEnv = { readConfig, processEnv: ANTHROPIC };
    expect(gooseEconomyEnv({ env: {}, appData, compactWindow: 100_000 }, serverEnv)).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5',
      [GOOSE_CONTEXT_LIMIT_ENV]: '200000',
    });
    // Окружение прогона (так панель ведёт Goose в контур) главнее окружения сервера.
    expect(
      gooseEconomyEnv(
        {
          env: { GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'gpt-5' },
          appData,
          compactWindow: 100_000,
        },
        serverEnv,
      ),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.25', [GOOSE_CONTEXT_LIMIT_ENV]: '400000' });
    // Модель шапки разговора Goose не получает (флага модели нет) — окно не по ней.
    expect(
      gooseEconomyEnv({ env: {}, appData, compactWindow: 100_000, model: 'gpt-5' }, serverEnv),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5', [GOOSE_CONTEXT_LIMIT_ENV]: '200000' });
  });

  it('vendor/model ids resolve by the prefix vendor (openrouter style)', () => {
    catalog();
    expect(gooseCatalogWindow(appData, 'openrouter', 'anthropic/claude-sonnet-4.5')).toBe(200_000);
    expect(gooseCatalogWindow(appData, undefined, 'openai/gpt-5')).toBe(400_000);
    expect(gooseCatalogWindow(appData, 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
  });

  it('human GOOSE_CONTEXT_LIMIT overrides the catalog and is not re-emitted', () => {
    catalog();
    expect(
      gooseEconomyEnv(
        {
          env: { ...ANTHROPIC, [GOOSE_CONTEXT_LIMIT_ENV]: '320000' },
          appData,
          compactWindow: 160_000,
        },
        noConfig,
      ),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5' });
    // Тот же выбор человека в окружении сервера — тоже главнее каталога.
    expect(
      gooseEconomyEnv(
        { env: ANTHROPIC, appData, compactWindow: 160_000 },
        { readConfig: () => ({}), processEnv: { [GOOSE_CONTEXT_LIMIT_ENV]: '640000' } },
      ),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.25' });
  });

  it('contour model window (route.modelContext): after the human key, before the catalog', () => {
    catalog();
    // Контур ведёт Goose своей моделью (`GOOSE_MODEL` прогона) и объявил её окно.
    const contour = { env: ANTHROPIC, appData, compactWindow: 160_000, modelContext: 320_000 };
    expect(gooseEconomyEnv(contour, noConfig)).toEqual({
      [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5',
      [GOOSE_CONTEXT_LIMIT_ENV]: '320000',
    });
    // Каталог модели не знает — окно контура всё равно известно.
    expect(
      gooseEconomyEnv(
        { ...contour, env: { GOOSE_PROVIDER: 'databricks', GOOSE_MODEL: 'route-model' } },
        noConfig,
      ),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.5', [GOOSE_CONTEXT_LIMIT_ENV]: '320000' });
    // Выбор человека (`GOOSE_CONTEXT_LIMIT`) главнее окна контура и не повторяется.
    expect(
      gooseEconomyEnv(
        { ...contour, env: { ...ANTHROPIC, [GOOSE_CONTEXT_LIMIT_ENV]: '640000' } },
        noConfig,
      ),
    ).toEqual({ [GOOSE_COMPACT_THRESHOLD_ENV]: '0.25' });
  });

  it('unknown window — no key', () => {
    const run = (env: NodeJS.ProcessEnv, compactWindow = 100_000) =>
      gooseEconomyEnv({ env, appData, compactWindow }, noConfig);
    // Каталога ещё нет вовсе.
    expect(run(ANTHROPIC)).toBeUndefined();
    catalog();
    expect(run({ GOOSE_PROVIDER: 'anthropic' })).toBeUndefined();
    expect(run({ GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-unknown' })).toBeUndefined();
    expect(run({ GOOSE_PROVIDER: 'databricks', GOOSE_MODEL: 'claude-sonnet-4-5' })).toBeUndefined();
    expect(run({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'no-limit' })).toBeUndefined();
    // Окно группы не меньше окна модели — доля ≥ 1, ключа нет.
    expect(run(ANTHROPIC, 200_000)).toBeUndefined();
  });
});
