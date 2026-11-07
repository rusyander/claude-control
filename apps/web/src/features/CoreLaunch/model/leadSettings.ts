import type { ConfigView, CoreConfig } from '@agentdeck/contracts/core/config';
import {
  LEAD_ALWAYS_ASK,
  LEAD_EFFORT_NEVER,
  LEAD_PARALLELISM_MAX,
  LEAD_PROFILE_DEFAULTS,
  LEAD_ROLES,
  leadSettingsPatchSchema,
  type LeadAlwaysAsk,
  type LeadProfile,
  type LeadRole,
  type LeadSection,
  type LeadSettingsPatch,
  type Promotion,
  type RoleRow,
} from '@agentdeck/contracts/core/lead';
import {
  resolveLeadSettings,
  type EffectiveLeadSettings,
} from '@agentdeck/contracts/core/lead-resolve';
import { SESSION_SLOTS_DEFAULT } from '@agentdeck/contracts/core/records';
import { MODEL_TIERS } from '@agentdeck/contracts/core/scenario';
import { EFFORT_LEVELS, MODEL_OPTIONS } from '@shared/lib/chat-model';

/**
 * Настройки ведущего на экране запуска (этап 11, D11, P144, W3-16): правка уровня — умолчаний
 * машины (`lead.defaults`) или проекта (`lead.projects[repoKey]`) — поверх профиля. Действующие
 * значения считает тот же резолвер, что у ядра (`contracts/core/lead-resolve`), поэтому экран
 * показывает ровно то, по чему ядро решит. Запись — весь раздел `lead` одной `set-config` с
 * отпечатком: чужая запись между чтением и сохранением даёт 409, а не затирание.
 */

/** Область правки: `''` — умолчания машины, иначе ключ репозитория проекта. */
export type LeadScope = string;
export const MACHINE_SCOPE: LeadScope = '';

/** Усилия, которые экран предлагает: реестр без «по умолчанию» и без `max` (ядро его не выбирает). */
export const LEAD_EFFORTS: readonly string[] = EFFORT_LEVELS.filter(
  (e) => e !== '' && e !== LEAD_EFFORT_NEVER,
);
/** Ступени лестницы переходника. */
export const LEAD_TIERS = MODEL_TIERS;
/** Модель — только явный выбор человека; пусто — модель ступени. */
export const LEAD_MODELS: readonly string[] = MODEL_OPTIONS.filter((m) => m !== '');

export const sessionSlotsOf = (view: ConfigView | undefined): number =>
  view?.doc.queue?.sessionSlots ?? SESSION_SLOTS_DEFAULT;

/** Правка выбранного уровня, как она записана в настройке; нет — пустая. */
export function patchOf(view: ConfigView | undefined, scope: LeadScope): LeadSettingsPatch {
  const lead = view?.doc.lead;
  const patch = scope === MACHINE_SCOPE ? lead?.defaults : lead?.projects?.[scope];
  return patch ? structuredClone(patch) : {};
}

/** Раздел `lead` с правкой уровня на месте прежней; пустая правка — уровня нет. */
export function sectionWith(
  section: LeadSection | undefined,
  scope: LeadScope,
  patch: LeadSettingsPatch,
): LeadSection | undefined {
  const empty = Object.keys(patch).length === 0;
  const next: LeadSection = { ...(section ?? {}) };
  if (scope === MACHINE_SCOPE) {
    if (empty) delete next.defaults;
    else next.defaults = patch;
  } else {
    const projects = { ...(next.projects ?? {}) };
    if (empty) delete projects[scope];
    else projects[scope] = patch;
    if (Object.keys(projects).length > 0) next.projects = projects;
    else delete next.projects;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Действующие настройки с черновиком уровня: то, что ядро применит к задаче этой области. */
export function effectiveWith(
  view: ConfigView | undefined,
  scope: LeadScope,
  patch: LeadSettingsPatch,
): EffectiveLeadSettings {
  return resolveLeadSettings({
    section: sectionWith(view?.doc.lead, scope, patch),
    repoKey: scope === MACHINE_SCOPE ? null : scope,
    machine: { sessionSlots: sessionSlotsOf(view) },
  });
}

/** Действующие настройки задачи проекта по записанной настройке (ступени ролей на оценке). */
export function effectiveOf(
  view: ConfigView | undefined,
  repoKey: string | null,
): EffectiveLeadSettings {
  return resolveLeadSettings({
    section: view?.doc.lead,
    repoKey,
    machine: { sessionSlots: sessionSlotsOf(view) },
  });
}

/**
 * Строки ролей для оценки: действующие по настройке, если профиль совпал с названным ядром; иначе
 * (ключ проекта ещё не пришёл из ленты) — умолчания профиля, который назвало ядро.
 */
export function estimateRoles(
  view: ConfigView | undefined,
  repoKey: string | null,
  profile: LeadProfile,
): Record<LeadRole, RoleRow> {
  const effective = effectiveOf(view, repoKey);
  if (effective.settings.profile === profile) return effective.settings.roles;
  const roles = LEAD_PROFILE_DEFAULTS[profile].roles ?? {};
  return Object.fromEntries(
    LEAD_ROLES.map((role) => [role, roles[role] ?? { tier: 'ceiling' }]),
  ) as Record<LeadRole, RoleRow>;
}

/** Профиль выбран — только поле профиля; явные правки уровня (роли, параллельность) остаются. */
export const withProfile = (patch: LeadSettingsPatch, profile: LeadProfile): LeadSettingsPatch => ({
  ...patch,
  profile,
});

/** Параллельность — целое 1…6; пусто или не число — правки нет (действует профиль). */
export function withParallelism(patch: LeadSettingsPatch, raw: string): LeadSettingsPatch {
  const next = { ...patch };
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) delete next.parallelism;
  else next.parallelism = Math.min(LEAD_PARALLELISM_MAX, Math.max(1, Math.round(n)));
  return next;
}

/**
 * Правка строки роли: строка заменяется целиком (так её читает ядро), поэтому новая строка
 * собирается из действующей плюс изменённое поле. Пустое усилие — без усилия (умолчание CLI),
 * пустая модель — модель ступени. `max` не записывается никогда.
 */
export function withRoleField(
  patch: LeadSettingsPatch,
  current: RoleRow,
  role: LeadRole,
  field: 'tier' | 'effort' | 'model',
  value: string,
): LeadSettingsPatch {
  const row: RoleRow = { ...current };
  if (field === 'tier') {
    row.tier = value as RoleRow['tier'];
  } else {
    const optional: 'effort' | 'model' = field;
    if (value === '' || (optional === 'effort' && value === LEAD_EFFORT_NEVER))
      delete row[optional];
    else row[optional] = value;
  }
  return { ...patch, roles: { ...(patch.roles ?? {}), [role]: row } };
}

/** Строка роли снова по профилю (и по уровню машины для проекта). */
export function withoutRole(patch: LeadSettingsPatch, role: LeadRole): LeadSettingsPatch {
  const roles = { ...(patch.roles ?? {}) };
  delete roles[role];
  const next: LeadSettingsPatch = { ...patch, roles };
  if (Object.keys(roles).length === 0) delete next.roles;
  return next;
}

export function withPromotion(
  patch: LeadSettingsPatch,
  current: Promotion,
  field: keyof Promotion,
  raw: string,
): LeadSettingsPatch {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return patch;
  return { ...patch, promotion: { ...current, [field]: n } };
}

export function withAlwaysAsk(
  patch: LeadSettingsPatch,
  current: readonly LeadAlwaysAsk[],
  ask: LeadAlwaysAsk,
  on: boolean,
): LeadSettingsPatch {
  const set = new Set(current);
  if (on) set.add(ask);
  else set.delete(ask);
  return { ...patch, alwaysAsk: LEAD_ALWAYS_ASK.filter((a) => set.has(a)) };
}

/** Правка уровня негодна схемой ядра — пути полей, которые назовёт экран. */
export function patchProblems(patch: LeadSettingsPatch): string[] {
  const parsed = leadSettingsPatchSchema.safeParse(patch);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.') || 'lead');
}

/** Документ настройки с правкой уровня: прочие разделы и уровни не трогаются. */
export function withLead(
  view: ConfigView,
  scope: LeadScope,
  patch: LeadSettingsPatch,
): { doc: CoreConfig; baseDigest: string } {
  const lead = sectionWith(view.doc.lead, scope, patch);
  const doc: CoreConfig = { ...view.doc };
  if (lead) doc.lead = lead;
  else delete doc.lead;
  return { doc, baseDigest: view.digest };
}

/** Черновик отличается от записанного уровня — кнопка сохранения активна. */
export const leadChanged = (
  view: ConfigView | undefined,
  scope: LeadScope,
  patch: LeadSettingsPatch,
): boolean => !!view && JSON.stringify(patchOf(view, scope)) !== JSON.stringify(patch);

/** Области выбора: машина, проекты с правкой, проекты, которые экран уже видел (оценка). */
export function scopeKeys(view: ConfigView | undefined, seen: readonly string[]): string[] {
  const keys = new Set([...Object.keys(view?.doc.lead?.projects ?? {}), ...seen]);
  keys.delete(MACHINE_SCOPE);
  return [...keys].sort();
}
