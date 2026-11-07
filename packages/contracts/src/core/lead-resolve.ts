import {
  LEAD_PROFILE_DEFAULT,
  LEAD_PROFILE_DEFAULTS,
  LEAD_ROLES,
  type LeadProfile,
  type LeadRole,
  type LeadSection,
  type LeadSettings,
  type LeadSettingsPatch,
  type LeadSource,
  type LeadWarning,
  type RoleRow,
} from './lead.ts';
import { SESSION_SLOTS_DEFAULT } from './records.ts';

/**
 * Действующие настройки ведущего (этап 11, D11, P144) — чистая функция, общая ядру и панели:
 * ядро решает по ней, экран запуска показывает по ней действующие ступени ролей (ответ оценки
 * ролей не несёт). Умолчания профиля → правка машины (`lead.defaults`) → правка проекта
 * (`lead.projects[repoKey]`) → политика машины. Профиль берётся с самого узкого уровня, где он
 * назван; нет нигде — «Сбалансировано». Поле правки заменяет поле целиком, строка роли — строку
 * роли. Профиль, названный проектом, — выбор уже́ правок машины: поля, которые профили задают
 * по-разному (роли, параллельность), берутся из него, а не из `lead.defaults`; общие для всех
 * профилей поля правка машины задаёт по-прежнему. Значение шире политики машины (параллельность
 * выше `queue.sessionSlots`) не отвергается, а срезается и называется.
 */
export type { LeadSource, LeadWarning };

type Field = Exclude<keyof LeadSettings, 'roles'>;
const FIELDS: readonly Field[] = [
  'profile',
  'parallelism',
  'promotion',
  'alwaysAsk',
  'classThresholds',
];

/** Поля, у которых профили расходятся: их задаёт выбранный профиль (считается по таблице). */
const PROFILE_MADE = new Set<Field | 'roles'>(
  (['roles', ...FIELDS.filter((f) => f !== 'profile')] as const).filter(
    (field) =>
      new Set(Object.values(LEAD_PROFILE_DEFAULTS).map((p) => JSON.stringify(p[field]))).size > 1,
  ),
);

export interface LeadSettingsInput {
  /** Раздел `lead` настройки ядра (уже разобранный читателем); нет — одни умолчания. */
  section: LeadSection | undefined;
  /** Ключ репозитория задачи; `null` — правки проекта не ищутся. */
  repoKey: string | null;
  /** Политика машины: `queue.sessionSlots`; нет — `SESSION_SLOTS_DEFAULT`. */
  machine: { sessionSlots?: number };
}

export interface EffectiveLeadSettings {
  /** Таблица ролей полная: строка на каждую роль. */
  settings: LeadSettings & { roles: Record<LeadRole, RoleRow> };
  sources: Record<Field, LeadSource>;
  roleSources: Record<LeadRole, LeadSource>;
  warnings: LeadWarning[];
}

export function resolveLeadSettings(input: LeadSettingsInput): EffectiveLeadSettings {
  const defaults = input.section?.defaults;
  const project = input.repoKey === null ? undefined : input.section?.projects?.[input.repoKey];
  const profile: LeadProfile = project?.profile ?? defaults?.profile ?? LEAD_PROFILE_DEFAULT;
  const base = LEAD_PROFILE_DEFAULTS[profile];
  const levels: [LeadSource, LeadSettingsPatch | undefined][] = [
    ['defaults', defaults],
    ['project', project],
  ];
  const projectPicked = project?.profile !== undefined;
  /** Правка машины поля, которое задаёт профиль, выбранный проектом, — не действует. */
  const overruled = (source: LeadSource, field: Field | 'roles') =>
    projectPicked && source === 'defaults' && PROFILE_MADE.has(field);

  const settings: LeadSettings = { ...base };
  const sources = Object.fromEntries(FIELDS.map((f) => [f, 'profile'])) as Record<
    Field,
    LeadSource
  >;
  for (const [source, patch] of levels) {
    if (!patch) continue;
    for (const field of FIELDS) {
      if (patch[field] === undefined || overruled(source, field)) continue;
      (settings as Record<Field, unknown>)[field] = patch[field];
      sources[field] = source;
    }
  }

  const roles = {} as Record<LeadRole, RoleRow>;
  const roleSources = {} as Record<LeadRole, LeadSource>;
  for (const role of LEAD_ROLES) {
    let row = base.roles?.[role] ?? { tier: 'ceiling' };
    let source: LeadSource = 'profile';
    for (const [level, patch] of levels) {
      const own = patch?.roles?.[role];
      if (own === undefined || overruled(level, 'roles')) continue;
      row = own;
      source = level;
    }
    roles[role] = row;
    roleSources[role] = source;
  }

  const warnings: LeadWarning[] = [];
  const slots = input.machine.sessionSlots ?? SESSION_SLOTS_DEFAULT;
  if (settings.parallelism > slots) {
    warnings.push({
      field: 'parallelism',
      asked: settings.parallelism,
      applied: slots,
      cap: 'queue.sessionSlots',
      source: sources.parallelism,
    });
    settings.parallelism = slots;
  }

  return { settings: { ...settings, roles }, sources, roleSources, warnings };
}
