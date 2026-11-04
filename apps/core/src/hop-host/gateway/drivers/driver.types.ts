import type { PlatformExhaustedScope } from '@agentdeck/contracts/platform';
import type { PlatformClientTools } from '@agentdeck/contracts/platform-presets';

/**
 * Профиль платформы для звена — узкий кусок манифеста драйвера панели
 * (`domains/platform/drivers/driver.ts`): только то, что спрашивает конвейер шлюза (судьба
 * полей, вендорные кадры, отказы, потолки). Пробы, матрица возможностей и ручки карточки
 * остаются у маршрута (зона R); звену их знать незачем.
 */

type DriverFieldFate = 'mapped' | 'renamed' | 'lossy' | 'dropped';

interface DriverFieldLoss {
  /** В каком диалекте назван `field`: строка общей таблицы перевода или поле OpenAI. */
  dialect: 'anthropic' | 'openai';
  field: string;
  fate: Exclude<DriverFieldFate, 'renamed'>;
  note: string;
}

interface DriverFieldRename {
  dialect: 'openai';
  field: string;
  fate: 'renamed';
  to: string;
  note: string;
}

export type DriverRequestField = DriverFieldLoss | DriverFieldRename;

export type VendorFrameKind =
  | 'status'
  | 'reasoning'
  | 'sanitized'
  | 'guardrails'
  | 'anonymization'
  | 'replacement'
  | 'tools-dropped';

export interface VendorFrame {
  kind: VendorFrameKind;
  field: string;
  stage?: string;
  verdict?: unknown;
  interrupted?: boolean;
  mapping?: Record<string, string>;
  text?: string;
}

export interface DriverStatusRow {
  /** Код, которым ответил контур. */
  upstream: number;
  /** Код, который увидит клиент: у 451 это 400 — его понимают все клиенты. */
  status: number;
  code: string;
  message: string;
  /** В теле лежит перечень сработавших проверок: читать его белым списком. */
  violations?: boolean;
}

/** Поле названия в элементе перечня нарушений. */
export interface DriverViolationName {
  field: string;
  label?: boolean;
}

/** Строка разбора отказа 402: что кончилось — ключ или уровень. */
export interface DriverBudgetRefusal {
  message: RegExp;
  scope: PlatformExhaustedScope;
}

export interface HopDriver {
  id: string;
  /** Как называть платформу в тексте отказа. */
  title: string;
  requestFields: DriverRequestField[];
  /** Модели, которым мост несёт пометки кэша промпта Anthropic. */
  cacheMarkModels?: RegExp;
  readFrame(payload: Record<string, unknown>): VendorFrame | undefined;
  vendorFields: readonly string[];
  statusRows: DriverStatusRow[];
  violationNames?: readonly DriverViolationName[];
  budgetRefusals?: readonly DriverBudgetRefusal[];
  placeholderPattern?: RegExp;
  nonStreamTimeoutSec?: number;
  responseCeilingSec?: number;
  /** Родная ручка Anthropic у платформы (путь внутри версии API). */
  anthropic?: { messages: string };
  /** Ручка картинок контура (путь внутри версии API, манифест `imagesApi`); нет — 404. */
  images?: { api: string };
  clientTools: PlatformClientTools;
  shimRequestFields?: Readonly<Record<string, unknown>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Карта подмены платформы: объект `{метка: значение}` или список `[{placeholder, value}]`.
 * Нестроковое значение — причина НЕ подставлять: `[object Object]` в аргументе хуже метки.
 */
export function readSubstitutionMap(value: unknown): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainRecord(item)) continue;
      const alias = item.placeholder;
      const original = item.value;
      if (typeof alias === 'string' && alias && typeof original === 'string') map[alias] = original;
    }
  } else if (isPlainRecord(value)) {
    for (const [alias, original] of Object.entries(value)) {
      if (typeof original === 'string' && alias) map[alias] = original;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}
