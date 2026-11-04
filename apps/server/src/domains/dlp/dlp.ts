import type { AppStore } from '../../lib/app-store/app-store.ts';
import type { DlpInfo, DlpPreviewResult, DlpRule } from '@agentdeck/contracts';
import type { DlpProxy } from './core-dlp.ts';
import { AliasVault, maskText } from '@agentdeck/dlp/mask';
import { builtinInfos } from '@agentdeck/dlp/default-rules';
import { resolveDlpUpstream as resolveUpstream } from '@agentdeck/dlp/proxy-config';
import { readRules } from '@agentdeck/dlp/rules-file';
import { coded, errorBody } from '../../lib/server-text/server-text.ts';
import { attachTextCodes } from '../../lib/server-texts/server-texts.ts';

/**
 * Защита данных — фасад раздела. Образцы, правила, маска, разбор форматов, журнал и выбор
 * адреса наверх живут в пакете `@agentdeck/dlp` (их зовёт и ядро); слушатель-прокси держит
 * хост звеньев ядра (C3c, `core-dlp.ts`). Здесь — то, что есть только у панели: запись правил,
 * проверка настроек перед включением и сборка ответа страницы.
 *
 * Адрес, куда пересылать, берётся либо прямой строкой, либо из профиля «своего
 * эндпоинта» (часть A): прокси и профиль складываются — CLI смотрит в прокси,
 * прокси в локальную модель, и наружу не уходит ни адрес, ни данные.
 */

export { createCoreDlpProxy, DlpStartError, type DlpProxy } from './core-dlp.ts';
export { readRules, parseRules, DlpRulesError } from '@agentdeck/dlp/rules-file';
export { saveRules, validateRules } from './rules-store.ts';
export { readJournal, clearJournal } from '@agentdeck/dlp/journal';

export class DlpConfigError extends Error {}

/** Что ядро применит при включении — проверено панелью до записи тумблера. */
export interface DlpRuntime {
  port: number;
  upstream: string;
  rules: DlpRule[];
  passUnknown: boolean;
  journal: boolean;
}

/**
 * Куда прокси пересылает запросы. Пусто и там и там — не поднимаемся вовсе:
 * догадаться про облако вендора нельзя, а поднявшийся «куда-нибудь» прокси
 * увёл бы запросы не туда, где их ждут. Правило — общее с ядром.
 */
export function resolveDlpUpstream(store: AppStore): string {
  const settings = store.getSettings();
  const resolved = resolveUpstream(settings.dlp, settings.endpointProfiles);
  if ('url' in resolved) return resolved.url;
  throw coded(
    new DlpConfigError(resolved.detail),
    resolved.code,
    resolved.value !== undefined ? { value: resolved.value } : undefined,
  );
}

/** Проверить настройки перед включением: адрес, правила, порт, политика неизвестного. */
export function buildDlpRuntime(store: AppStore, appDataDir: string): DlpRuntime {
  const settings = store.getSettings();
  const rules = readRules(appDataDir);

  // Пустой список правил — это НЕ защита. Поднимать прокси, который ничего не
  // ищет, значит выдавать за защиту обычную пересылку.
  if (rules.filter((rule) => rule.enabled).length === 0) {
    throw coded(new DlpConfigError('нет ни одного включённого правила'), 'dlp-no-rules');
  }

  return {
    port: settings.dlp.port,
    upstream: resolveDlpUpstream(store),
    rules,
    passUnknown: settings.dlp.passUnknown,
    journal: settings.dlp.journal,
  };
}

export function describeDlp(store: AppStore, appDataDir: string, proxy: DlpProxy): DlpInfo {
  const settings = store.getSettings();

  let rules: DlpRule[] = [];
  let rulesProblem: ReturnType<typeof errorBody> | undefined;
  try {
    rules = readRules(appDataDir);
  } catch (problem) {
    rulesProblem = errorBody(problem, 'error');
  }

  // Причина рядом с кодом: строку ядра (`serverText`) код находит разбором, ошибка правил несёт
  // свой (`coded`) — карточка показывает её на языке человека, а не русской строкой сервера.
  const status = proxy.status();
  return {
    settings: settings.dlp,
    rules,
    status: status.error ? attachTextCodes(status) : { ...status, ...rulesProblem },
    builtins: builtinInfos(),
  };
}

/**
 * Предпросмотр на пробном тексте: показать, что увидела бы модель. Словарь
 * меток здесь ОДНОРАЗОВЫЙ — предпросмотр не должен занимать номера, под
 * которыми потом пойдут настоящие данные.
 */
export function previewDlp(text: string, rules: readonly DlpRule[]): DlpPreviewResult {
  const result = maskText(text, rules, new AliasVault());
  return { masked: result.text, hits: result.hits, blocked: Boolean(result.blockedBy) };
}
