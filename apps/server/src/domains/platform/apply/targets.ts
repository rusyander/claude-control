import type {
  EndpointApiKind,
  EndpointProfile,
  PlatformTargetReason,
  PlatformVarPlan,
} from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import { listProviders } from '../../../providers/registry.ts';
import type {
  ConfigProvider,
  ProviderEndpointFile,
  ProviderEndpointVars,
} from '../../../providers/types.ts';
import { buildEndpointPlan, resolveEndpointVars } from '../../endpoints/endpoint-plan.ts';
import { resolveProviderEnvTargetFor } from '../../provider-env.ts';
import { gatewayUrlFor, PLACEHOLDER_KEY } from './profile.ts';

/**
 * Куда контур переносится и почему у части CLI стоит прочерк.
 *
 * Ответ на «куда» берётся ТОЛЬКО из реестра провайдеров — то есть из
 * документации самих CLI (`endpointConfig` для переменных окружения,
 * `endpointFile` для codex и continue). Панель не угадывает ни имени
 * переменной, ни структуры чужого конфига: молча не сработавшая настройка хуже
 * честного прочерка, потому что человек считает работу сделанной.
 *
 * Прочерков четыре вида, и они разные для человека:
 * - `no_env_section` — писать некуда вовсе (goose, kimi, cursor, opencode);
 * - `no_documented_base_url` — файл есть, задокументированного имени нет;
 * - `gateway_dialect` — адрес задать МОЖНО, но CLI говорит на диалекте, которого
 *   шлюз не понимает. Это про gemini: его `google` шлюз не переводит (Т2 знает
 *   anthropic и openai), и записать ему адрес значило бы получить 404 на первом
 *   же запросе вместо ответа;
 * - `gateway_down` — контур выключен или шлюз не поднят; считается выше.
 */

/** Как пишется адрес у этой цели. */
export type ContourWrite =
  /** Ассистент самой панели: ни одного файла CLI, только настройка панели. */
  | { kind: 'assistant' }
  /** Раздел переменных окружения CLI — тем же кодом, что и обычный профиль. */
  | {
      kind: 'endpoint-env';
      providerId: string;
      apiKind: EndpointApiKind;
      filePath: string;
      vars: ProviderEndpointVars;
    }
  /** Кусок конфигурации: `model_providers` у codex, `apiBase` у continue. */
  | {
      kind: 'endpoint-file';
      providerId: string;
      apiKind: EndpointApiKind;
      filePath: string;
      file: ProviderEndpointFile;
    };

export interface ContourTarget {
  targetId: string;
  title: string;
  write?: ContourWrite;
  reason?: PlatformTargetReason;
  filePath: string;
  /** Что окажется в файле. У ассистента пусто: он живёт в настройках панели. */
  plan: PlatformVarPlan[];
}

export interface ContourTargetPaths {
  claudeSettings: string;
  override?: string;
}

/**
 * Имя записи контура в чужом конфиге (codex `[model_providers.<name>]`,
 * continue — имя модели). Из идентификатора контура, у которого набор символов
 * уже сужен схемой, поэтому кавычек и точек здесь взяться неоткуда.
 */
export function contourEntryName(platformId: string): string {
  return `contour-${platformId}`;
}

/**
 * Диалект, на котором ЭТОТ CLI пойдёт в шлюз. Предпочитается openai-совместимый:
 * он родной для контура, и перевод в конвейере шлюза не понадобится вовсе.
 * Диалект, которого шлюз не знает, целью не становится.
 */
export function pickApiKind(provider: ConfigProvider): EndpointApiKind | undefined {
  const config = provider.endpointConfig;
  if (config?.['openai-compat']) return 'openai-compat';
  if (config?.anthropic) return 'anthropic';
  return undefined;
}

/**
 * Профиль, которым цель применяется. От хранимого управляемого профиля
 * отличается двумя полями: диалектом (у каждого CLI свой) и галочкой «писать
 * токен» — в файл уходит ЗАГЛУШКА, а не ключ, и без галочки её не написать.
 */
export function targetProfile(
  managed: EndpointProfile,
  platformId: string,
  gatewayPort: number,
  apiKind: EndpointApiKind,
): EndpointProfile {
  return {
    ...managed,
    apiKind,
    baseUrl: gatewayUrlFor(gatewayPort, platformId, apiKind),
    writeToken: true,
  };
}

/** План записи для env-цели — тем же построителем, каким его потом пишут. */
export function envPlanFor(
  profile: EndpointProfile,
  vars: ProviderEndpointVars,
): PlatformVarPlan[] {
  return buildEndpointPlan(profile, vars, PLACEHOLDER_KEY, false).map((item) => ({
    key: item.key,
    value: item.value,
    // Секрета здесь нет: `secret` у построителя означает «переменная ключа», а
    // значением в неё идёт заглушка, и человеку важно видеть её целиком.
    ...(item.secret ? { placeholder: true } : {}),
  }));
}

/** План записи для файловой цели: показываются те же ключи, что лягут в файл. */
export function filePlanFor(
  file: ProviderEndpointFile,
  platformId: string,
  gatewayPort: number,
  model: string,
): PlatformVarPlan[] {
  const name = contourEntryName(platformId);
  const baseUrl = gatewayUrlFor(gatewayPort, platformId, file.apiKind);

  if (file.format === 'codex-toml') {
    return [
      { key: `model_providers.${name}.base_url`, value: baseUrl },
      { key: `model_providers.${name}.wire_api`, value: 'chat' },
      { key: `model_providers.${name}.env_key`, value: 'CONTOUR_API_KEY' },
      // Провайдер, которого никто не выбрал, — мёртвая запись: корневой ключ и
      // есть то, ради чего таблица пишется.
      { key: 'model_provider', value: name },
    ];
  }

  return [
    { key: `models[${name}].apiBase`, value: baseUrl },
    { key: `models[${name}].provider`, value: 'openai' },
    ...(model ? [{ key: `models[${name}].model`, value: model }] : []),
    { key: `models[${name}].apiKey`, value: PLACEHOLDER_KEY, placeholder: true },
  ];
}

/**
 * Все цели контура в порядке показа: ассистент панели первым — это
 * единственный сценарий, который работает полностью (у CLI через контур нет
 * своих инструментов), и предлагать его последним было бы враньём о ценности.
 */
export function describeContourTargets(
  managed: EndpointProfile,
  platformId: string,
  gatewayPort: number,
  paths: ContourTargetPaths,
): ContourTarget[] {
  const targets: ContourTarget[] = [
    {
      targetId: PLATFORM_ASSISTANT_TARGET,
      title: 'Ассистент панели',
      write: { kind: 'assistant' },
      filePath: '',
      plan: [],
    },
  ];

  // compromise: no-client-tools — чем дойдут инструменты цели-CLI, решает не цель, а
  // маршрут контура (`toolRouteOf`, едет в плане): у платформа компании без прослойки агент
  // работает как чат, совместимому шлюзу инструменты уходят полем.
  for (const provider of listProviders()) {
    const apiKind = pickApiKind(provider);

    if (apiKind) {
      const profile = targetProfile(managed, platformId, gatewayPort, apiKind);
      const filePath =
        provider.id === 'claude'
          ? paths.claudeSettings
          : resolveProviderEnvTargetFor(provider, paths.override)?.filePath;
      const vars = provider.endpointConfig?.[apiKind];
      if (!filePath || !vars) {
        // Имена переменных есть, а файла нет: в реестре такого сочетания быть не
        // должно, но угадывать путь нельзя — fail-closed.
        targets.push(unsupported(provider, 'no_env_section'));
        continue;
      }
      targets.push({
        targetId: provider.id,
        title: provider.name,
        write: { kind: 'endpoint-env', providerId: provider.id, apiKind, filePath, vars },
        filePath,
        plan: envPlanFor(profile, vars),
      });
      continue;
    }

    const file = provider.endpointFile;
    if (file) {
      const filePath = file.path(paths.override);
      targets.push({
        targetId: provider.id,
        title: provider.name,
        write: {
          kind: 'endpoint-file',
          providerId: provider.id,
          apiKind: file.apiKind,
          filePath,
          file,
        },
        filePath,
        plan: filePlanFor(file, platformId, gatewayPort, managed.model),
      });
      continue;
    }

    // Диалект, которого шлюз не знает, отличается от «писать некуда»: у gemini
    // переменная адреса есть и задокументирована, беда не в ней.
    if (provider.endpointConfig) {
      targets.push(unsupported(provider, 'gateway_dialect'));
      continue;
    }

    // `api_kind_mismatch` сюда не доходит: сравнивать не с чем — у провайдера
    // нет ни одной задокументированной переменной адреса.
    const resolved = resolveEndpointVars(provider, 'openai-compat');
    const reason = 'reason' in resolved ? resolved.reason : 'no_documented_base_url';
    targets.push(
      unsupported(
        provider,
        reason === 'no_env_section' ? 'no_env_section' : 'no_documented_base_url',
      ),
    );
  }

  return targets;
}

// compromise: cli-no-endpoint — четверо из десяти CLI адрес шлюза принять не
// могут вовсе, и панель не угадывает за них ни имени переменной, ни структуры
// чужого конфига: прочерк с названной причиной честнее настройки, которая молча
// не работает.
function unsupported(provider: ConfigProvider, reason: PlatformTargetReason): ContourTarget {
  return {
    targetId: provider.id,
    title: provider.name,
    reason,
    filePath: '',
    plan: [],
  };
}
