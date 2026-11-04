import { statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ModelPricing,
  PlatformModelInfo,
  PlatformSpendRecord,
  PricingEntry,
} from '@agentdeck/contracts';
import { declaredPricing, type BudgetPlatform } from '@agentdeck/pricing/contour-spend';
import type { PricingLookup } from '@agentdeck/pricing/pricing';
import { readJsonFile } from '../gateway/json-file.ts';

/**
 * Что учёт контуров читает из файлов панели (только чтение, как правила маски `rulesFrom`):
 * какие контуры есть (`settings.platforms`), свои цены человека (`settings.modelPricing`),
 * цены каталога контура из последней пробы (`platformHealth[id].models[].price`) и прайс,
 * который панель обновляет (`pricing-cache.json`). Так деньги считаются по тем же ценам, что
 * считала панель, а звено не ждёт, пока ядро их пришлёт.
 *
 * Файл перечитывается, только когда сменилось время его записи: ответ модели не платит
 * разбором `state.json` за каждый запрос.
 */

export interface PanelContours {
  /** Контур записан в панели. Нет каталога панели — любой (тест, ядро без панели). */
  known(platformId: string): boolean;
  /** Цены для денег этого контура: свои человека → каталог контура → прайс панели. */
  lookup(platformId: string): PricingLookup;
  /** Бюджет контура, как его ввёл человек; нет контура или каталога панели — `undefined`. */
  budget(platformId: string): ContourBudget | undefined;
  /** Дни расхода, которые вела панель до C3b (`platformSpend`), — только живых контуров. */
  legacySpend(): Record<string, PlatformSpendRecord>;
}

export interface ContourBudget extends BudgetPlatform {
  title: string;
}

interface PlatformShape {
  id?: unknown;
  title?: unknown;
  budgetUsd?: unknown;
  budgetSince?: unknown;
}

interface StateShape {
  platformSpend?: Record<string, unknown>;
  settings?: { platforms?: PlatformShape[]; modelPricing?: Record<string, ModelPricing> };
  platformHealth?: Record<string, { models?: unknown }>;
}

interface Cached<T> {
  mtimeMs: number;
  value: T;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function modelsOf(raw: unknown): PlatformModelInfo[] {
  if (!Array.isArray(raw)) return [];
  // Старые записи пробы хранят строки, а не объекты (`platform-health.ts` панели): у них цены нет.
  return raw.filter(
    (item): item is PlatformModelInfo =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { id?: unknown }).id === 'string',
  );
}

export function panelContours(panelAppData: string | undefined): PanelContours {
  if (!panelAppData)
    return {
      known: () => true,
      lookup: () => ({}),
      budget: () => undefined,
      legacySpend: () => ({}),
    };
  const stateFile = join(panelAppData, 'state.json');
  const priceFile = join(panelAppData, 'pricing-cache.json');
  let state: Cached<StateShape> | undefined;
  let prices: Cached<PricingEntry[] | undefined> | undefined;

  const readState = (): StateShape => {
    const at = mtimeOf(stateFile);
    if (state?.mtimeMs !== at) {
      let value: StateShape;
      try {
        value = readJsonFile<StateShape>(stateFile, {});
      } catch {
        // Панель пишет файл в эту секунду или он битый — прошлое прочтение лучше пустого.
        value = state?.value ?? {};
      }
      state = { mtimeMs: at, value };
    }
    return state.value;
  };
  const readPrices = (): PricingEntry[] | undefined => {
    const at = mtimeOf(priceFile);
    if (prices?.mtimeMs !== at) {
      let value: PricingEntry[] | undefined;
      try {
        const cached = readJsonFile<{ entries?: PricingEntry[] } | undefined>(priceFile, undefined);
        value = cached?.entries?.length ? cached.entries : undefined;
      } catch {
        value = undefined;
      }
      prices = { mtimeMs: at, value };
    }
    return prices.value;
  };

  return {
    known(platformId) {
      const platforms = readState().settings?.platforms;
      return Array.isArray(platforms) && platforms.some((item) => item?.id === platformId);
    },
    lookup(platformId) {
      const read = readState();
      const entries = readPrices();
      return {
        overrides: read.settings?.modelPricing ?? {},
        declared: declaredPricing(modelsOf(read.platformHealth?.[platformId]?.models)),
        ...(entries ? { entries } : {}),
      };
    },
    budget(platformId) {
      const found = readState().settings?.platforms?.find((item) => item?.id === platformId);
      if (!found) return undefined;
      // Те же значения по умолчанию, что у схемы контура: ноль — не следить, пусто — с начала.
      const budgetUsd =
        typeof found.budgetUsd === 'number' && found.budgetUsd > 0 ? found.budgetUsd : 0;
      return {
        id: platformId,
        title: typeof found.title === 'string' && found.title ? found.title : platformId,
        budgetUsd,
        budgetSince: typeof found.budgetSince === 'string' ? found.budgetSince : '',
      };
    },
    legacySpend() {
      const read = readState();
      const ids = new Set((read.settings?.platforms ?? []).map((item) => item?.id));
      const out: Record<string, PlatformSpendRecord> = {};
      for (const [id, raw] of Object.entries(read.platformSpend ?? {})) {
        const record = raw as Partial<PlatformSpendRecord> | null;
        // Запись без дней — не запись учёта (битая или чужая форма): переносить нечего.
        if (!ids.has(id) || !record || !Array.isArray(record.days)) continue;
        out[id] = structuredClone({ ...record, platformId: id, days: record.days });
      }
      return out;
    },
  };
}
