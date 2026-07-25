import { join } from 'node:path';
import type { ModelInfo } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';
import { fetchModels, MODELS_URL, sortModels } from './model-source.ts';

/** Сутки: модели выходят не чаще, а список нужен при каждом открытии настроек. */
export const MODELS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CACHE_FILE = 'models-cache.json';

/** Что лежит в кэше между запусками. */
interface ModelCacheFile {
  fetchedAt: string;
  url: string;
  models: ModelInfo[];
  /** Все идентификаторы, которые панель когда-либо видела, — основа «новинок». */
  knownIds: string[];
  /** Что появилось при последнем удачном обновлении. */
  newIds: string[];
}

/** Текущее состояние каталога для маршрутов. */
export interface ModelSnapshot {
  models: ModelInfo[];
  fetchedAt?: string;
  newIds: string[];
  url: string;
}

/**
 * Каталог моделей: кэш на диске, при устаревании — попытка обновиться.
 *
 * Сеть здесь необязательна. Неудача не бросает исключение и не стирает кэш:
 * панель продолжает показывать последний известный список и честно говорит,
 * какой он давности. Пустой кэш и отсутствие сети — тоже нормальный исход:
 * тогда выбор модели остаётся ручным, как был до этой функциональности.
 */
export class ModelCatalogStore {
  private readonly cacheFile: string;
  private cache: ModelCacheFile | undefined;
  /** Идущая загрузка — чтобы параллельные запросы не дёргали сеть по разу каждый. */
  private inFlight: Promise<ModelSnapshot> | undefined;

  constructor(appDataDir: string) {
    // Node в режиме strip-only не поддерживает parameter properties.
    this.cacheFile = join(appDataDir, CACHE_FILE);
    this.cache = this.readCache();
  }

  private readCache(): ModelCacheFile | undefined {
    const cached = readJsonFile<ModelCacheFile | undefined>(this.cacheFile, undefined);
    if (!cached?.models?.length || !cached.fetchedAt) return undefined;
    return {
      ...cached,
      knownIds: cached.knownIds ?? [],
      newIds: cached.newIds ?? [],
      url: cached.url ?? MODELS_URL,
    };
  }

  /** Что сейчас известно — без обращения к сети. */
  current(vendors: string[]): ModelSnapshot {
    const models = this.cache ? this.cache.models.filter((m) => vendors.includes(m.vendor)) : [];
    const ids = new Set(models.map((model) => model.id));

    return {
      models: sortModels(models),
      fetchedAt: this.cache?.fetchedAt,
      newIds: (this.cache?.newIds ?? []).filter((id) => ids.has(id)),
      url: this.cache?.url ?? MODELS_URL,
    };
  }

  isStale(maxAgeMs = MODELS_MAX_AGE_MS): boolean {
    if (!this.cache) return true;
    return Date.now() - Date.parse(this.cache.fetchedAt) > maxAgeMs;
  }

  /**
   * Обновить, если пора. `force` — по кнопке в настройках. Возвращает актуальный
   * каталог в любом случае, даже когда обновиться не вышло.
   *
   * `vendors` — что нужно ЗАПРОСИТЬ. В кэш кладём объединение с уже известным:
   * пользователь переключает провайдера чаще, чем выходят модели, и терять
   * список прошлого провайдера на каждом переключении незачем.
   */
  async refresh(
    vendors: string[],
    options: { force?: boolean; maxAgeMs?: number } = {},
  ): Promise<ModelSnapshot> {
    if (vendors.length === 0) return this.current(vendors);
    if (!options.force && !this.isStale(options.maxAgeMs) && this.hasAll(vendors))
      return this.current(vendors);

    this.inFlight ??= this.load(this.wanted(vendors));
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
    return this.current(vendors);
  }

  /** Есть ли в кэше хоть одна модель каждого из запрошенных вендоров. */
  private hasAll(vendors: string[]): boolean {
    return vendors.every((vendor) => this.cache?.models.some((model) => model.vendor === vendor));
  }

  /** Запрошенные вендоры плюс те, что уже лежат в кэше. */
  private wanted(vendors: string[]): string[] {
    const all = new Set(vendors);
    for (const model of this.cache?.models ?? []) all.add(model.vendor);
    return [...all];
  }

  private async load(vendors: string[]): Promise<ModelSnapshot> {
    try {
      const fresh = await fetchModels(vendors);
      const known = new Set(this.cache?.knownIds ?? []);
      // На первом скачивании «новых» нет: новинка — это то, чего не было в
      // ПРОШЛЫЙ раз, а прошлого раза ещё не случалось.
      const newIds = this.cache ? fresh.filter((m) => !known.has(m.id)).map((m) => m.id) : [];

      for (const model of fresh) known.add(model.id);

      this.cache = {
        fetchedAt: new Date().toISOString(),
        url: MODELS_URL,
        models: fresh,
        knownIds: [...known],
        newIds,
      };
      writeJsonFile(this.cacheFile, this.cache);
    } catch {
      // Молча: отсутствие сети — обычное дело для локальной панели. Давность
      // источника видна в настройках.
    }
    return this.current(vendors);
  }
}
