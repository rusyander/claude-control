import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DeliveryProfile,
  SplitSettingsView,
  StoredSplitSettings,
} from '@agentdeck/contracts/task-split';
import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  SPLIT_DEFAULTS_BUILTIN,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import { chatDeliveryPrompt } from '@agentdeck/contracts/task-split';
import { bootstrapPlanFor, isHeavyPlan } from './bootstrap.ts';
import { layoutForCwd } from './copy-readiness.ts';
import { gitSync } from './exec.ts';
import { pickRemote } from './parse.ts';

/**
 * Доставка до MR на проекте: что панель выводит сама, без настройки человеком.
 *
 * Всё здесь — чтение основной копии: удалённый репозиторий (без него MR
 * некуда), проектный навык доставки (его имя уходит агенту, чтобы он не искал)
 * и тяжесть подготовки копии (от неё — сколько групп разом по умолчанию).
 */

/** Навык доставки в каталоге навыков проекта: имя содержит «delivery». */
export function findDeliverySkill(projectDir: string): string | undefined {
  try {
    return readdirSync(join(projectDir, '.claude', 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /delivery/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()[0];
  } catch {
    return undefined;
  }
}

export function hasRemote(projectDir: string): boolean {
  const out = gitSync(projectDir, ['remote']);
  return out !== undefined && pickRemote(out) !== undefined;
}

export function readDeliveryProfile(
  projectDir: string,
  input: { enabled: boolean; bootstrap?: string; heavy?: SplitDefaults['heavy'] },
): DeliveryProfile {
  const plan = bootstrapPlanFor(projectDir, input.bootstrap);
  const skill = findDeliverySkill(projectDir);
  return {
    enabled: input.enabled,
    repo: gitSync(projectDir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true',
    remote: hasRemote(projectDir),
    ...(skill ? { skill } : {}),
    ...(plan ? { bootstrap: plan.summary } : {}),
    bootstrapConfigured: Boolean(input.bootstrap?.trim()),
    heavy: isHeavyPlan(plan, input.heavy),
  };
}

/**
 * Групп разом: заданное на проекте, иначе общий потолок вкладки «Группы» по
 * тяжести подготовки копии.
 */
export function effectiveParallel(
  stored: StoredSplitSettings,
  heavy: boolean,
  defaults: Pick<SplitDefaults, 'parallelLight' | 'parallelHeavy'> = SPLIT_DEFAULTS_BUILTIN,
): number {
  return stored.parallel ?? (heavy ? defaults.parallelHeavy : defaults.parallelLight);
}

export function splitSettingsView(
  stored: StoredSplitSettings,
  profile: DeliveryProfile,
  defaults: SplitDefaults = SPLIT_DEFAULTS_BUILTIN,
): SplitSettingsView {
  const own = stored.permissions ?? {};
  return {
    deliver: stored.deliver,
    parallel: effectiveParallel(stored, profile.heavy, defaults),
    parallelAuto: stored.parallel === undefined,
    profile,
    permissions: resolveGroupPermissions(defaults.permissions, own),
    permissionsOwn: GROUP_REQUEST_IDS.filter((id) => own[id] !== undefined),
  };
}

/**
 * Доставка действует на деле: главный выключатель, настройка проекта и
 * удалённый репозиторий. Без удалённого навык встал бы на пуше — обещать
 * агенту MR там, где его некуда открыть, значит получить остановку в конце.
 */
export function deliveryActive(
  stored: StoredSplitSettings,
  profile: Pick<DeliveryProfile, 'enabled' | 'remote'>,
): boolean {
  return profile.enabled && stored.deliver && profile.remote;
}

/** Что нужно от хранилища панели — структурно, без зависимости домена от него. */
export interface DeliverySource {
  getSettings(): { deliverToMr: boolean };
  getWorktreeMirror(path: string): { bootstrap?: string };
  getSplitSettings(path: string): StoredSplitSettings;
  /** Общие правила групп; не задано — коробка (двойники тестов без вкладки). */
  getSplitDefaults?(): SplitDefaults;
}

/** Всё о доставке проекта разом: запись, выведенный профиль и итог. */
export function resolveProjectDelivery(
  source: DeliverySource,
  projectDir: string,
): { view: SplitSettingsView; active: boolean } {
  const stored = source.getSplitSettings(projectDir);
  const defaults = source.getSplitDefaults?.() ?? SPLIT_DEFAULTS_BUILTIN;
  const bootstrap = source.getWorktreeMirror(projectDir).bootstrap;
  const profile = readDeliveryProfile(projectDir, {
    enabled: source.getSettings().deliverToMr,
    ...(bootstrap !== undefined ? { bootstrap } : {}),
    heavy: defaults.heavy,
  });
  return {
    view: splitSettingsView(stored, profile, defaults),
    active: deliveryActive(stored, profile),
  };
}

/**
 * Строка доставки для обычного чата с рабочим каталогом `cwd`, либо ничего.
 * Чат в копии относится к проекту своей основной копии: настройка и навык —
 * оттуда, как у разделения.
 */
export function chatDeliveryFor(
  source: DeliverySource,
  cwd: string,
  options: { foreign?: boolean } = {},
): string | undefined {
  const projectDir = layoutForCwd(cwd).mainDir ?? cwd;
  if (!resolveProjectDelivery(source, projectDir).active) return undefined;
  const skill = findDeliverySkill(projectDir);
  return chatDeliveryPrompt({
    ...(skill ? { skill } : {}),
    ...(options.foreign ? { foreign: true } : {}),
  });
}
