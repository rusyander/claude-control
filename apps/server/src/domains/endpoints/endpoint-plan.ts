import type {
  EndpointApiKind,
  EndpointProfile,
  EndpointTarget,
  EndpointUnsupportedReason,
  EndpointVarPlan,
} from '@claude-control/contracts';
import { listProviders } from '../../providers/registry.ts';
import type { ConfigProvider, ProviderEndpointVars } from '../../providers/types.ts';
import { maskKey } from '../../lib/provider-keys.ts';
import { resolveProviderEnvTargetFor } from '../provider-env.ts';

/**
 * Что именно панель напишет в конфигурацию CLI, чтобы он ходил в свой эндпоинт,
 * и почему для части CLI ответ — «ничего».
 *
 * Здесь нет ни сети, ни записи: только резолв имён переменных из реестра
 * провайдеров и сборка плана. План — то же самое, что и предпросмотр: список
 * пар «переменная → значение», в котором значение токена уже замаскировано.
 */

/** Куда пишется env этого провайдера — файл CLI либо settings.json Claude. */
export interface EndpointWriteTarget {
  provider: ConfigProvider;
  vars: ProviderEndpointVars;
  filePath: string;
  /**
   * Claude пишет переменные в блок `env` файла settings.json собственными
   * средствами (`domains/env.ts`), у остальных это универсальный env-раздел
   * (`domains/provider-env.ts`). Ветка выбирается ЗДЕСЬ один раз, чтобы
   * применение не разбиралось в этом повторно.
   */
  kind: 'claude-settings' | 'provider-env';
}

/**
 * Имена переменных этого CLI под вид API профиля — или `undefined` вместе с
 * причиной отказа. Причина машиночитаемая: текст пишет клиент, на своём языке.
 */
export function resolveEndpointVars(
  provider: ConfigProvider,
  apiKind: EndpointApiKind,
): { vars: ProviderEndpointVars } | { reason: EndpointUnsupportedReason } {
  const config = provider.endpointConfig;
  if (!config) {
    // Различаем два разных «нет»: писать некуда вовсе или писать есть куда, но
    // задокументированного имени переменной адреса у CLI не существует. Для
    // человека это разные новости: во втором случае адрес задаётся в конфиге
    // руками, и панель говорит об этом прямо, а не прячется за общим «нельзя».
    return {
      reason: provider.capabilities.env === 'ready' ? 'no_documented_base_url' : 'no_env_section',
    };
  }
  const vars = config[apiKind];
  if (!vars) return { reason: 'api_kind_mismatch' };
  return { vars };
}

/** Виды API, которые CLI принимает через окружение (для подсказок интерфейса). */
export function endpointApiKindsOf(provider: ConfigProvider): EndpointApiKind[] {
  return Object.keys(provider.endpointConfig ?? {}) as EndpointApiKind[];
}

/**
 * Цель записи для провайдера и вида API — или `undefined`, если профиль сюда не
 * переносится. Claude идёт своей веткой (settings.json), остальные —
 * универсальным env-разделом; у кого нет ни того, ни другого, цели нет.
 */
export function resolveEndpointWriteTarget(
  provider: ConfigProvider,
  apiKind: EndpointApiKind,
  claudeSettingsPath: string,
  override?: string,
): EndpointWriteTarget | undefined {
  const resolved = resolveEndpointVars(provider, apiKind);
  if (!('vars' in resolved)) return undefined;

  if (provider.id === 'claude') {
    return { provider, vars: resolved.vars, filePath: claudeSettingsPath, kind: 'claude-settings' };
  }

  const envTarget = resolveProviderEnvTargetFor(provider, override);
  if (!envTarget) return undefined;
  return {
    provider,
    vars: resolved.vars,
    filePath: envTarget.filePath,
    kind: 'provider-env',
  };
}

/**
 * План записи: адрес всегда, модель — если профиль её называет И у CLI есть для
 * неё переменная, токен — только по галочке `writeToken` и только когда токен
 * вообще сохранён.
 *
 * `maskToken` решает, чем в плане окажется значение токена. Наружу (в ответы
 * API) уходит МАСКА; настоящее значение собирается тем же кодом только в момент
 * записи в файл — иначе план и запись разошлись бы, и предпросмотр перестал бы
 * что-либо гарантировать.
 */
export function buildEndpointPlan(
  profile: EndpointProfile,
  vars: ProviderEndpointVars,
  token: string | undefined,
  maskToken: boolean,
): EndpointVarPlan[] {
  const plan: EndpointVarPlan[] = [
    { key: vars.baseUrlEnv, value: profile.baseUrl.trim(), secret: false },
  ];

  const model = profile.model.trim();
  if (model && vars.modelEnv) plan.push({ key: vars.modelEnv, value: model, secret: false });

  if (profile.writeToken && vars.credentialEnv && token) {
    plan.push({
      key: vars.credentialEnv,
      value: maskToken ? maskKey(token) : token,
      secret: true,
    });
  }

  return plan;
}

/**
 * Готовность КАЖДОГО известного CLI принять этот профиль — список для раздела
 * настроек. Значение токена сюда не попадает даже замаскированным у тех, кто
 * его не пишет: план показывает ровно то, что уйдёт в файл.
 */
export function describeEndpointTargets(
  profile: EndpointProfile,
  token: string | undefined,
  claudeSettingsPath: string,
  override?: string,
): EndpointTarget[] {
  return listProviders().map((provider) => {
    const apiKinds = endpointApiKindsOf(provider);
    const resolved = resolveEndpointVars(provider, profile.apiKind);

    if (!('vars' in resolved)) {
      return {
        providerId: provider.id,
        providerName: provider.name,
        supported: false,
        reason: resolved.reason,
        apiKinds,
        plan: [],
        filePath: '',
      };
    }

    const target = resolveEndpointWriteTarget(
      provider,
      profile.apiKind,
      claudeSettingsPath,
      override,
    );
    // Имена переменных есть, а файла нет — такого сочетания в реестре быть не
    // должно (env объявлен ready у всех четырёх), но угадывать путь нельзя:
    // fail-closed, показываем как неподдержанный.
    if (!target) {
      return {
        providerId: provider.id,
        providerName: provider.name,
        supported: false,
        reason: 'no_env_section',
        apiKinds,
        plan: [],
        filePath: '',
      };
    }

    return {
      providerId: provider.id,
      providerName: provider.name,
      supported: true,
      apiKinds,
      plan: buildEndpointPlan(profile, resolved.vars, token, true),
      filePath: target.filePath,
    };
  });
}
