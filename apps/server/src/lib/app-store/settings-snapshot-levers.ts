import type { AppSettings } from '@agentdeck/contracts';
import {
  SPLIT_DEFAULTS_REVISION,
  type StoredSplitDefaults,
} from '@agentdeck/contracts/split-groups';
import { SPLIT_SETTINGS_DEFAULT, type StoredSplitSettings } from '@agentdeck/contracts/task-split';
import type { AppState } from './app-store.types.ts';

/**
 * Что из настроек снимка для git остаётся на машине (решение владельца 24.10).
 *
 * Снимок приходит из git, а записать его мог любой, у кого есть доступ к
 * репозиторию, — и агент другой машины тоже. Рычаги решений («можно без
 * человека») поэтому не едут ни в одну сторону: снимок их не пишет, а
 * принесённый их не применяет, даже если его писала прежняя версия панели.
 * Человек ставит их на каждой машине сам.
 *
 * Каждое поле названо: `portable` — едет, `machine` — принадлежит машине (свой
 * каталог, свой адрес удалённого доступа), `lever` — рычаг решения. Новое поле
 * без отметки не соберётся: рычаг не уедет молча.
 */
const SETTINGS_KEYS = {
  theme: 'portable',
  language: 'portable',
  accent: 'portable',
  provider: 'portable',
  onboardingDone: 'portable',
  claudeDirOverride: 'machine',
  revealSecretsByDefault: 'portable',
  backupBeforeWrite: 'portable',
  backupKeep: 'portable',
  watchFiles: 'portable',
  largeText: 'portable',
  reduceMotion: 'portable',
  highContrast: 'portable',
  editor: 'portable',
  costUnit: 'portable',
  mcpNetworkTimeoutMs: 'portable',
  mcpAutoCheck: 'portable',
  chatModel: 'portable',
  chatEffort: 'portable',
  taskSplitInitiative: 'portable',
  handoffInitiative: 'portable',
  handoffContextLimit: 'portable',
  // Автопродолжение во всех разговорах: цепочка идёт без кнопки человека.
  handoffAutoDefault: 'lever',
  deliverToMr: 'portable',
  autoApproveRules: 'lever',
  chatAutoMode: 'lever',
  chatLeanTools: 'portable',
  // Сроки отложенных вопросов D-n: ноль — карточка прав не откладывается никогда.
  deferAfterMinutes: 'lever',
  deferredTtlDays: 'lever',
  groupEconomy: 'portable',
  groupWatch: 'portable',
  modelPricing: 'portable',
  encryptSecretBackups: 'portable',
  autoUpdateModels: 'portable',
  modelSource: 'portable',
  modelSourcePlatform: 'portable',
  previewProviderWrites: 'portable',
  endpointProfiles: 'portable',
  platforms: 'portable',
  activePlatformId: 'portable',
  platformProbeMinutes: 'portable',
  platformGateway: 'portable',
  assistantEndpointId: 'portable',
  dlp: 'portable',
  // Маршрут проверки промптов журнал отдаёт только человеку (`human:prompt-gate`).
  promptGate: 'lever',
  remoteAccess: 'machine',
  integrations: 'portable',
} as const satisfies Record<keyof AppSettings, 'portable' | 'machine' | 'lever'>;

/** Настройки, которые снимок не пишет и не применяет: машинные и рычаги. */
export const LOCAL_SETTINGS = (Object.keys(SETTINGS_KEYS) as (keyof AppSettings)[]).filter(
  (key) => SETTINGS_KEYS[key] !== 'portable',
);

/**
 * Общие правила групп: разрешения и развилки — рычаги, числа — нет. Ревизия
 * говорит, от какой коробки считаны разрешения (`split-settings.ts`, F-33), и
 * без разрешений ей не о чем говорить — она остаётся с ними.
 */
const SPLIT_DEFAULTS_LEVERS = [
  'permissions',
  'groupQuestions',
  'revision',
] as const satisfies readonly (keyof StoredSplitDefaults)[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function defaultsWithoutLevers(value: unknown): StoredSplitDefaults {
  const out: Record<string, unknown> = isRecord(value) ? { ...value } : {};
  for (const key of SPLIT_DEFAULTS_LEVERS) delete out[key];
  return out as StoredSplitDefaults;
}

/** Записи проектов без строк разрешений; ставшая умолчанием запись уходит, как в `setSplitSettings`. */
function projectsWithoutLevers(value: unknown): Record<string, StoredSplitSettings> {
  const out: Record<string, StoredSplitSettings> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const neutral: Record<string, unknown> = { ...entry };
    delete neutral.permissions;
    const deliver = typeof neutral.deliver === 'boolean' ? neutral.deliver : undefined;
    if (deliver === SPLIT_SETTINGS_DEFAULT.deliver && neutral.parallel === undefined) continue;
    out[key] = neutral as unknown as StoredSplitSettings;
  }
  return out;
}

/** Переносимая часть без рычагов групп: `picked` — то, что уходит в снимок. */
export function dropSplitLevers(picked: Record<string, unknown>, state: AppState): void {
  if (state.splitDefaults !== undefined) {
    picked.splitDefaults = defaultsWithoutLevers(state.splitDefaults);
  }
  if (state.splitSettings !== undefined) {
    picked.splitSettings = projectsWithoutLevers(state.splitSettings);
  }
}

/**
 * Числа групп — из снимка, разрешения и развилки — здешние. Записи у машины не
 * было — у неё действовала коробка этой версии, и запись с одними числами
 * получает её ревизию: без ревизии она читалась бы прежней (F-33), и «история
 * git» тихо ушла бы человеку.
 */
export function keepLocalSplitLevers(
  next: Record<string, unknown>,
  local: AppState,
  restored: Partial<AppState>,
): void {
  if (restored.splitDefaults !== undefined) {
    const merged: Record<string, unknown> = { ...defaultsWithoutLevers(restored.splitDefaults) };
    const own = local.splitDefaults as Record<string, unknown> | undefined;
    if (own) {
      for (const key of SPLIT_DEFAULTS_LEVERS) if (own[key] !== undefined) merged[key] = own[key];
    } else if (Object.keys(merged).length > 0) {
      merged.revision = SPLIT_DEFAULTS_REVISION;
    }
    next.splitDefaults = Object.keys(merged).length > 0 ? merged : undefined;
  }
  if (restored.splitSettings !== undefined) {
    const merged = projectsWithoutLevers(restored.splitSettings);
    for (const [key, entry] of Object.entries(local.splitSettings ?? {})) {
      if (!entry.permissions || Object.keys(entry.permissions).length === 0) continue;
      merged[key] = {
        ...(merged[key] ?? { deliver: SPLIT_SETTINGS_DEFAULT.deliver }),
        permissions: entry.permissions,
      };
    }
    next.splitSettings = merged;
  }
}
