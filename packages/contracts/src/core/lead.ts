import { z } from 'zod';
import { registryId } from './ids.ts';
import {
  LEAD_PROFILES,
  MODEL_TIERS,
  TASK_CLASSES,
  type LeadProfile,
  type TaskClass,
} from './scenario.ts';

/**
 * Ведущий задачи (этап 11, P135-P145): класс задачи, роли и их ступени, профиль ведения, карта
 * разведки. Модуль только читает `scenario.ts` и `ids.ts`: его читают `model-tools.ts` (карта
 * разведки, роль куска плана), `journal-data.ts` и `config.ts`, обратной ссылки быть не должно.
 * Ни одной модели здесь нет (P108): ступень — относительно лестницы переходника, модель — только
 * явный выбор человека.
 */

export { TASK_CLASSES, type TaskClass };

const line = (max: number) => z.string().min(1).max(max);
const nonNeg = z.number().int().nonnegative();
const pos = z.number().int().positive();

// ── класс задачи ──────────────────────────────────────────────────────────────────────────

/**
 * Записанные признаки, из которых класс считается чистой функцией (P135, без regex). `checkCovered`
 * `null` — покрытие проверками не прочитано (неизвестно, а не «нет»).
 */
export const classSignalsSchema = z.strictObject({
  files: nonNeg,
  units: nonNeg,
  crossUnitDeps: nonNeg,
  checkCovered: z.boolean().nullable(),
  /** Имена сработавших правил риска (маска пути + причина из разрешённой строки). */
  risk: z.array(line(100)).max(20),
  /** Пунктов источника (несколько задач трекера, пункты группы). */
  items: pos,
});
export type ClassSignals = z.infer<typeof classSignalsSchema>;

/** Кто поднял класс выше чистого расчёта: нет проверки — на класс вверх, модель — только вверх. */
export const CLASS_RAISE_CAUSES = ['no-check', 'model', 'human'] as const;
export type ClassRaiseCause = (typeof CLASS_RAISE_CAUSES)[number];

/**
 * Решение класса `classify` (модуль `conductor/classify`): итог `class`; `fromSignals` — чистый
 * расчёт по порогам; каждый подъём назван причиной. Понижает класс только человек (`human`).
 */
export interface TaskClassDecision {
  class: TaskClass;
  fromSignals: TaskClass;
  signals: ClassSignals;
  raised: { cause: ClassRaiseCause; from: TaskClass; to: TaskClass }[];
  /**
   * Модель предложила класс НИЖЕ расчёта — отказано (W2-8 `refusedLower`): что она предлагала.
   * `null` — модель ниже расчёта не предлагала. Понижает только человек.
   */
  refusedLower: { proposed: TaskClass } | null;
  reasons: string[];
}

/**
 * Границы класса (D5, W2-8): S — файлов ≤ `S.files` и единиц ≤ `S.units` (плюс покрыто проверкой и
 * без риска), M — ≤ `M.*` (и покрыто), XL — пунктов ≥ `XL.items` ИЛИ единиц ≥ `XL.units` со связями
 * между ними, иначе L. У L своей границы нет: L — всё, что выше M и не XL.
 */
const classBound = z.strictObject({ files: pos, units: pos });
export const classThresholdsSchema = z
  .strictObject({
    S: classBound,
    M: classBound,
    XL: z.strictObject({ items: z.number().int().min(2), units: pos }),
  })
  .refine((t) => t.S.files <= t.M.files && t.S.units <= t.M.units && t.M.units < t.XL.units, {
    message: 'class thresholds must grow from S to M, and XL units must exceed M units',
  });
export type ClassThresholds = z.infer<typeof classThresholdsSchema>;

export const CLASS_THRESHOLDS_DEFAULT: ClassThresholds = {
  S: { files: 3, units: 1 },
  M: { files: 10, units: 2 },
  XL: { items: 2, units: 5 },
};

// ── роли и ступени ────────────────────────────────────────────────────────────────────────

export const LEAD_ROLES = [
  'intake',
  'recon',
  'plan',
  'implement',
  'mechanical',
  'review',
  'integrate',
] as const;
export type LeadRole = (typeof LEAD_ROLES)[number];

/** Усилие, которое ядро не выбирает никогда (03:143): только правка человека в самом CLI. */
export const LEAD_EFFORT_NEVER = 'max';

/**
 * Строка роли (D7): ступень лестницы, а не модель. Усилие — непрозрачный id реестра, кроме `max`;
 * модель — только явный выбор человека. Ревьюер не слабее автора — это судит `economy/tier` по
 * лестнице, а не схема.
 */
export const roleRowSchema = z.strictObject({
  tier: z.enum(MODEL_TIERS),
  effort: registryId
    .refine((effort) => effort !== LEAD_EFFORT_NEVER, { message: 'effort max is never chosen' })
    .optional(),
  model: line(200).optional(),
});
export type RoleRow = z.infer<typeof roleRowSchema>;

export const roleTableSchema = z.partialRecord(z.enum(LEAD_ROLES), roleRowSchema);
export type RoleTable = z.infer<typeof roleTableSchema>;

// ── профиль ведения ───────────────────────────────────────────────────────────────────────

// Список живёт в `scenario.ts` (шаг сценария ограничивается профилем, `onlyProfile`); отсюда — тот же.
export { LEAD_PROFILES, type LeadProfile };
export const LEAD_PROFILE_DEFAULT: LeadProfile = 'balanced';

/** Предел параллельных сеансов задач; машина сужает его `queue.sessionSlots` (P141). */
export const LEAD_PARALLELISM_MAX = 6;
/** Кольцо первых проходов ключа обучения (P140). */
export const FIRST_PASS_RING_MAX = 20;

/** Что ведущий спрашивает всегда, даже когда мог бы решить сам (D25). */
export const LEAD_ALWAYS_ASK = ['intake', 'classify', 'split'] as const;
export type LeadAlwaysAsk = (typeof LEAD_ALWAYS_ASK)[number];

export const promotionSchema = z
  .strictObject({
    /** Доля первых проходов, ниже которой ключ поднимается на ступень. */
    threshold: z.number().gt(0).max(1),
    window: z.number().int().min(1).max(FIRST_PASS_RING_MAX),
    minSamples: pos,
  })
  .refine((p) => p.minSamples <= p.window, {
    path: ['minSamples'],
    message: 'minSamples must fit in the window',
  });
export type Promotion = z.infer<typeof promotionSchema>;

export const PROMOTION_DEFAULT: Promotion = { threshold: 0.85, window: 20, minSamples: 8 };

/** Бюджета задачи здесь нет намеренно (F3): расход судит наблюдатель, а не потолок. */
export const leadSettingsSchema = z.strictObject({
  profile: z.enum(LEAD_PROFILES),
  roles: roleTableSchema.optional(),
  parallelism: z.number().int().min(1).max(LEAD_PARALLELISM_MAX),
  promotion: promotionSchema,
  alwaysAsk: z
    .array(z.enum(LEAD_ALWAYS_ASK))
    .max(LEAD_ALWAYS_ASK.length)
    .refine((asks) => new Set(asks).size === asks.length, {
      message: 'alwaysAsk is a subset: no repeats',
    }),
  classThresholds: classThresholdsSchema,
});
export type LeadSettings = z.infer<typeof leadSettingsSchema>;

/** С какого уровня поле действующих настроек (`economy/lead-settings`). */
export type LeadSource = 'profile' | 'defaults' | 'project';

/**
 * Расширение шире политики машины срезано и названо (P144): что просили, что действует, чем
 * срезано и с какого уровня просьба. Его несут действующие настройки и ответ оценки.
 */
export interface LeadWarning {
  field: 'parallelism';
  asked: number;
  applied: number;
  cap: 'queue.sessionSlots';
  source: LeadSource;
}

/** Правка поверх профиля: любое поле, вложенный объект — целиком (строка роли — тоже целиком). */
export const leadSettingsPatchSchema = leadSettingsSchema.partial();
export type LeadSettingsPatch = z.infer<typeof leadSettingsPatchSchema>;

/** Раздел `lead` настройки ядра (D11): умолчания машины и правки по проектам (ключ репозитория). */
export const leadSectionSchema = z.strictObject({
  defaults: leadSettingsPatchSchema.optional(),
  projects: z.record(line(1000), leadSettingsPatchSchema).optional(),
});
export type LeadSection = z.infer<typeof leadSectionSchema>;

const ceilingAt = (effort: string): RoleRow => ({ tier: 'ceiling', effort });

/**
 * Умолчания профилей (D7): ступени относительны лестнице переходника, усилия — данные реестра.
 * «Сбалансировано» — умолчание; «Максимум качества» поднимает план и разведку и даёт ревью xhigh.
 */
export const LEAD_PROFILE_DEFAULTS: Readonly<Record<LeadProfile, LeadSettings>> = {
  economy: {
    profile: 'economy',
    roles: {
      intake: ceilingAt('medium'),
      recon: ceilingAt('medium'),
      plan: ceilingAt('medium'),
      implement: ceilingAt('medium'),
      mechanical: { tier: 'lower-if-mechanical', effort: 'medium' },
      review: ceilingAt('medium'),
      integrate: ceilingAt('medium'),
    },
    parallelism: 2,
    promotion: PROMOTION_DEFAULT,
    alwaysAsk: [],
    classThresholds: CLASS_THRESHOLDS_DEFAULT,
  },
  balanced: {
    profile: 'balanced',
    roles: {
      intake: ceilingAt('high'),
      recon: ceilingAt('high'),
      plan: ceilingAt('high'),
      implement: ceilingAt('high'),
      mechanical: { tier: 'lower-if-mechanical', effort: 'high' },
      review: ceilingAt('high'),
      integrate: ceilingAt('high'),
    },
    parallelism: 4,
    promotion: PROMOTION_DEFAULT,
    alwaysAsk: [],
    classThresholds: CLASS_THRESHOLDS_DEFAULT,
  },
  'max-quality': {
    profile: 'max-quality',
    roles: {
      intake: ceilingAt('high'),
      recon: { tier: 'raise-for-planning' },
      plan: { tier: 'raise-for-planning' },
      implement: ceilingAt('high'),
      mechanical: ceilingAt('high'),
      review: ceilingAt('xhigh'),
      integrate: ceilingAt('high'),
    },
    parallelism: 6,
    promotion: PROMOTION_DEFAULT,
    alwaysAsk: [],
    classThresholds: CLASS_THRESHOLDS_DEFAULT,
  },
};

// ── карта разведки ────────────────────────────────────────────────────────────────────────

/** Итог шага разведки (P136): не больше 20 строк, файлы с причиной, тела файлов нет. */
export const RECON_MAP_LINES_MAX = 20;
export const reconMapSchema = z.strictObject({
  lines: z.array(line(300)).min(1).max(RECON_MAP_LINES_MAX),
  files: z.array(z.strictObject({ path: line(500), why: line(300) })).max(60),
  tests: z.array(line(500)).max(60),
  owners: z.array(line(200)).max(20),
});
export type ReconMap = z.infer<typeof reconMapSchema>;
