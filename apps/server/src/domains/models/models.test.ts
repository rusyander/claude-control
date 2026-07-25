import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@claude-control/contracts';
import { parseModelCatalog, releaseKey, sortModels } from './model-source.ts';
import { ModelCatalogStore } from './model-store.ts';
import {
  findNewerModel,
  newestInFamily,
  planDefaultPromotion,
  resolveAssistantModel,
} from './model-defaults.ts';

/**
 * Каталог моделей: разбор источника, кэш и — главное — правила автозамены
 * модели по умолчанию. Именно они трогают настройки пользователя, поэтому
 * границы («только своё семейство», «только вперёд», «алиас не трогаем»)
 * проверяются пристально.
 */

const CATALOG = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        family: 'claude-opus',
        release_date: '2026-05-28',
        limit: { context: 1_000_000, output: 128_000 },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        family: 'claude-opus',
        release_date: '2026-07-24',
        // В настоящем каталоге это ОБЪЕКТ с описанием экспериментальных режимов,
        // а не признак «превью-модель»: панель его не читает и не показывает.
        experimental: { modes: { fast: { cost: { input: 10 } } } },
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        family: 'claude-sonnet',
        release_date: '2026-02-17',
        limit: { context: 200_000 },
      },
      // Мусорная запись: у неё нет идентификатора — в каталог попасть не должна.
      broken: { name: 'Без id' },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        family: 'gpt-mini',
        release_date: '2024-07-18',
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        family: 'gpt-mini',
        release_date: '2026-03-02',
      },
      'gpt-5.6': { id: 'gpt-5.6', name: 'GPT-5.6', family: 'gpt', release_date: '2026-06-01' },
    },
  },
  // Чужой вендор: запрашивать его никто не будет, в кэш он попасть не должен.
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    models: { 'command-r': { id: 'command-r', family: 'command' } },
  },
};

const anthropicModels = (): ModelInfo[] => parseModelCatalog(CATALOG, ['anthropic']);

describe('разбор каталога моделей', () => {
  it('берёт только запрошенных вендоров и пропускает записи без id', () => {
    const models = parseModelCatalog(CATALOG, ['anthropic']);

    expect(models.map((model) => model.id)).toEqual([
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
    expect(models.every((model) => model.vendor === 'anthropic')).toBe(true);
  });

  it('переносит только известные поля и не выдумывает недостающие', () => {
    const opus = anthropicModels().find((model) => model.id === 'claude-opus-5');

    expect(opus).toMatchObject({
      name: 'Claude Opus 5',
      family: 'claude-opus',
      releaseDate: '2026-07-24',
      reasoning: true,
      contextLimit: 1_000_000,
      outputLimit: 128_000,
    });
    const sonnet = anthropicModels().find((model) => model.id === 'claude-sonnet-4-6');
    expect(sonnet?.outputLimit).toBeUndefined();
    // Ключ `experimental` источника в модель не переносится вовсе: это описание
    // экспериментальных РЕЖИМОВ модели, а не пометка «не для повседневной работы».
    expect(opus).not.toHaveProperty('experimental');
  });

  it('мусор вместо документа не роняет разбор', () => {
    expect(parseModelCatalog(undefined, ['anthropic'])).toEqual([]);
    expect(parseModelCatalog('строка', ['anthropic'])).toEqual([]);
    expect(parseModelCatalog({ anthropic: { models: 5 } }, ['anthropic'])).toEqual([]);
  });

  it('неполную дату достраивает, отсутствующую отправляет в конец', () => {
    expect(releaseKey('2025-04')).toBe('2025-04-01');
    expect(releaseKey('2026-07-24')).toBe('2026-07-24');
    expect(releaseKey(undefined)).toBe('0000-00-00');

    const sorted = sortModels([
      { id: 'b', name: 'b', family: 'f', vendor: 'v' },
      { id: 'a', name: 'a', family: 'f', vendor: 'v', releaseDate: '2025-04' },
    ]);
    expect(sorted.map((model) => model.id)).toEqual(['a', 'b']);
  });
});

describe('автозамена модели по умолчанию', () => {
  it('поднимает пришпиленную модель до нового поколения того же семейства', () => {
    const promotion = planDefaultPromotion(
      anthropicModels(),
      'claude-opus-4-8',
      '2026-07-25T00:00:00Z',
    );

    expect(promotion).toEqual({
      from: 'claude-opus-4-8',
      to: 'claude-opus-5',
      toName: 'Claude Opus 5',
      at: '2026-07-25T00:00:00Z',
    });
  });

  it('не трогает алиас, пустое значение и незнакомую строку', () => {
    const models = anthropicModels();
    const at = '2026-07-25T00:00:00Z';

    expect(planDefaultPromotion(models, '', at)).toBeUndefined();
    expect(planDefaultPromotion(models, 'opus', at)).toBeUndefined();
    expect(planDefaultPromotion(models, 'своя-модель', at)).toBeUndefined();
  });

  it('не переводит между семействами и не откатывает назад', () => {
    const models = anthropicModels();

    // Sonnet новее не стал: opus в его семейство не переезжает.
    expect(findNewerModel(models, 'claude-sonnet-4-6')).toBeUndefined();
    // Самая свежая модель семейства уже стоит — менять нечего.
    expect(findNewerModel(models, 'claude-opus-5')).toBeUndefined();
  });

  it('семейство берётся целиком, самое свежее в нём — победитель', () => {
    const models = parseModelCatalog(CATALOG, ['openai']);

    expect(newestInFamily(models, 'gpt')?.id).toBe('gpt-5.6');
    expect(newestInFamily(models, 'gpt-mini')?.id).toBe('gpt-5.4-mini');
    // Незнакомого семейства в каталоге нет — подставлять нечего.
    expect(newestInFamily(models, 'gpt-nano')).toBeUndefined();
  });

  it('модель ассистента поднимается внутри семейства, иначе остаётся зашитой', () => {
    const models = parseModelCatalog(CATALOG, ['openai']);

    expect(resolveAssistantModel(models, 'gpt-4o-mini')).toBe('gpt-5.4-mini');
    // Каталога нет или модель в нём не найдена — работаем на зашитом значении.
    expect(resolveAssistantModel([], 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(resolveAssistantModel(models, 'claude-3-5-sonnet-latest')).toBe(
      'claude-3-5-sonnet-latest',
    );
  });
});

describe('кэш каталога', () => {
  let dir: string;

  const respond = (payload: unknown): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-models-'));
    respond(CATALOG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('скачивает, кладёт на диск и отдаёт только запрошенного вендора', async () => {
    const store = new ModelCatalogStore(dir);
    const snapshot = await store.refresh(['anthropic']);

    expect(snapshot.models.map((model) => model.id)).toContain('claude-opus-5');
    expect(snapshot.models.some((model) => model.vendor === 'cohere')).toBe(false);
    expect(snapshot.fetchedAt).toBeTruthy();

    const cached = JSON.parse(readFileSync(join(dir, 'models-cache.json'), 'utf8')) as {
      models: ModelInfo[];
    };
    expect(cached.models.length).toBeGreaterThan(0);
  });

  it('свежий кэш второй раз в сеть не ходит, кнопка «обновить» — ходит', async () => {
    const store = new ModelCatalogStore(dir);
    await store.refresh(['anthropic']);
    await store.refresh(['anthropic']);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    await store.refresh(['anthropic'], { force: true });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('новинками считает то, чего не было в прошлый раз, а не всё подряд', async () => {
    const store = new ModelCatalogStore(dir);
    // Первое скачивание: новинок нет — сравнивать не с чем.
    expect((await store.refresh(['anthropic'])).newIds).toEqual([]);

    const withNewModel = structuredClone(CATALOG) as typeof CATALOG;
    (withNewModel.anthropic.models as Record<string, unknown>)['claude-opus-6'] = {
      id: 'claude-opus-6',
      name: 'Claude Opus 6',
      family: 'claude-opus',
      release_date: '2026-09-01',
    };
    respond(withNewModel);

    const snapshot = await store.refresh(['anthropic'], { force: true });
    expect(snapshot.newIds).toEqual(['claude-opus-6']);
  });

  it('обрыв сети не стирает прошлый список и не бросает исключение', async () => {
    const store = new ModelCatalogStore(dir);
    await store.refresh(['anthropic']);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('сети нет');
      }),
    );

    const snapshot = await store.refresh(['anthropic'], { force: true });
    expect(snapshot.models.map((model) => model.id)).toContain('claude-opus-5');
  });

  it('кэш переживает перезапуск панели', async () => {
    await new ModelCatalogStore(dir).refresh(['anthropic']);

    const restarted = new ModelCatalogStore(dir);
    expect(restarted.current(['anthropic']).models.length).toBeGreaterThan(0);
    expect(restarted.isStale()).toBe(false);
  });
});
