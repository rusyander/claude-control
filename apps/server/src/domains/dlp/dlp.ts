import type { AppStore } from '../../lib/app-store/app-store.ts';
import type { DlpInfo, DlpPreviewResult, DlpRule } from '@agentdeck/contracts';
import type { DlpProxy, DlpRuntime } from './DlpProxy.ts';
import { AliasVault, maskText } from './mask.ts';
import { builtinInfos } from './default-rules.ts';
import { readRules } from './rules-store.ts';
import { coded } from '../../lib/server-text/server-text.ts';

/**
 * Защита данных — фасад раздела. Разбор форматов и сам слушатель живут в
 * `dlp/`, здесь — сборка настроек в рабочую конфигурацию и ответ панели.
 *
 * Адрес, куда пересылать, берётся либо прямой строкой, либо из профиля «своего
 * эндпоинта» (часть A): прокси и профиль складываются — CLI смотрит в прокси,
 * прокси в локальную модель, и наружу не уходит ни адрес, ни данные.
 */

export { DlpProxy } from './DlpProxy.ts';
export type { DlpRuntime } from './DlpProxy.ts';
export { readRules, saveRules, parseRules, validateRules, DlpRulesError } from './rules-store.ts';
export { readJournal, clearJournal } from './journal.ts';
export { AliasVault, maskText } from './mask.ts';
export { scanText } from './rules.ts';
export { builtinInfos, builtinRuleSet, maskRulesFor } from './default-rules.ts';
export { apiKindForPath } from './api-shapes.ts';
export { joinUpstream } from './DlpProxy.ts';

export class DlpConfigError extends Error {}

/**
 * Куда прокси пересылает запросы. Пусто и там и там — не поднимаемся вовсе:
 * догадаться про облако вендора нельзя, а поднявшийся «куда-нибудь» прокси
 * увёл бы запросы не туда, где их ждут.
 */
export function resolveDlpUpstream(store: AppStore): string {
  const settings = store.getSettings();
  const direct = settings.dlp.upstreamUrl.trim();
  if (direct) return assertHttpUrl(direct);

  const profileId = settings.dlp.upstreamProfileId;
  const profile = settings.endpointProfiles.find((item) => item.id === profileId);
  if (profile?.baseUrl) return assertHttpUrl(profile.baseUrl);

  throw coded(
    new DlpConfigError('не задан адрес, куда пересылать запросы'),
    'dlp-upstream-missing',
  );
}

function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw coded(new DlpConfigError(`адрес «${value}» не разбирается`), 'dlp-upstream-unparsed', {
      value,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw coded(
      new DlpConfigError('адрес должен начинаться с http:// или https://'),
      'dlp-upstream-scheme',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/** Собрать конфигурацию запуска: адрес, правила, порт, политика неизвестного. */
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
    language: settings.language,
    appDataDir,
  };
}

export function describeDlp(store: AppStore, appDataDir: string, proxy: DlpProxy): DlpInfo {
  const settings = store.getSettings();

  let rules: DlpRule[] = [];
  let error: string | undefined;
  try {
    rules = readRules(appDataDir);
  } catch (problem) {
    error = problem instanceof Error ? problem.message : String(problem);
  }

  const status = proxy.status();
  return {
    settings: settings.dlp,
    rules,
    status: { ...status, error: status.error ?? error },
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
