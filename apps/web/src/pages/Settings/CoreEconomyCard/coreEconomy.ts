import {
  CORE_ECONOMY_DEFAULTS,
  type ConfigView,
  type CoreConfig,
} from '@agentdeck/contracts/core/config';

/**
 * Рычаги экономии шагов задачи — раздел `economy` настройки ядра (`core/config.ts`). Ядро читает
 * его на каждом старте сессии шага (кроме чата): нет поля — умолчание (`CORE_ECONOMY_DEFAULTS`),
 * `0` / `false` — рычаг выключен явно, решает CLI. Порт карточки «Экономия групп разделения»
 * (этап 10, G15): те же рычаги, только хранит их ядро, а не настройки панели.
 */
export type CoreEconomySection = NonNullable<CoreConfig['economy']>;
export type CoreEconomyLever = keyof CoreEconomySection;

/** Что карточка показывает: каждое поле разрешено — `0` / `''` значат «решает CLI». */
export interface CoreEconomyValues {
  compactWindow: number;
  bashOutputChars: number;
  readOutputTokens: number;
  cacheTtl: '' | '5m' | '1h';
  detachIde: boolean;
  workHabits: boolean;
}

/** Умолчания карточки: у порога и срока кэша умолчания нет — решает CLI. */
export const CORE_ECONOMY_SHOWN_DEFAULTS: CoreEconomyValues = {
  compactWindow: 0,
  cacheTtl: '',
  ...CORE_ECONOMY_DEFAULTS,
};

export function coreEconomyOf(view: ConfigView | undefined): CoreEconomyValues {
  return { ...CORE_ECONOMY_SHOWN_DEFAULTS, ...view?.doc.economy };
}

/** Раздел не прошёл схему ядра — ядро его не применяет; причина для карточки. */
export function coreEconomyIssue(view: ConfigView | undefined): string | null {
  return view?.issues.find((issue) => issue.section === 'economy')?.reason ?? null;
}

/**
 * Новый документ настройки с одним изменённым рычагом. Значение, равное умолчанию, уходит из
 * раздела (умолчание остаётся за ядром: поднимут его — поднимется и здесь), пустой раздел уходит из
 * документа целиком. Документ — весь действующий, с отпечатком (`baseDigest`): чужая запись между
 * чтением и сохранением — 409, а не затирание.
 */
export function withEconomyLever<K extends keyof CoreEconomyValues>(
  view: ConfigView,
  lever: K,
  value: CoreEconomyValues[K],
): { doc: CoreConfig; baseDigest: string } {
  const doc: CoreConfig = { ...view.doc };
  const section: Record<string, unknown> = { ...(doc.economy ?? {}) };
  if (value === CORE_ECONOMY_SHOWN_DEFAULTS[lever]) delete section[lever];
  else section[lever] = value;
  if (Object.keys(section).length > 0) doc.economy = section as CoreEconomySection;
  else delete doc.economy;
  return { doc, baseDigest: view.digest };
}
