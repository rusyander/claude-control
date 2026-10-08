import type {
  EndpointApiKind,
  EndpointProfile,
  PlatformTargetReason,
  PlatformVarPlan,
} from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import { PLATFORM_TERMINAL_CONSUMER } from '@agentdeck/contracts/platform-consumers';
import { listProviders } from '../../../providers/registry.ts';
import type {
  ConfigProvider,
  ProviderEndpointFile,
  ProviderEndpointVars,
} from '../../../providers/types/types.ts';
import { buildEndpointPlan, resolveEndpointVars } from '../../endpoints/endpoint-plan.ts';
import { resolveProviderEnvTargetFor } from '../../provider-env/provider-env.ts';
import { gatewayUrlFor, PLACEHOLDER_KEY, type GatewayUrlRoute } from './profile.ts';
import { GATEWAY_ROUTES } from '../gateway/pipeline/pipeline.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';

/**
 * Обслуживает ли шлюз ту ручку, которой пойдёт CLI.
 *
 * Считается ИЗ САМОГО списка маршрутов шлюза, а не из второго перечня рядом:
 * появится `/v1/responses` — codex поднимется из прочерков сам, ни одной правки
 * здесь не понадобится. Отдельный список, наоборот, разошёлся бы молча, и
 * панель снова предложила бы цель, которой шлюз не отвечает.
 */
function gatewayServes(wireApi: ProviderEndpointFile['wireApi']): boolean {
  const suffix = wireApi === 'chat' ? '/chat/completions' : '/responses';
  return GATEWAY_ROUTES.some((route) => route.endsWith(suffix));
}

/**
 * Куда контур переносится и почему у части CLI стоит прочерк.
 *
 * Ответ на «куда» берётся ТОЛЬКО из реестра провайдеров — то есть из
 * документации самих CLI (`endpointConfig` для переменных окружения,
 * `endpointFile` для codex и continue). Панель не угадывает ни имени
 * переменной, ни структуры чужого конфига: молча не сработавшая настройка хуже
 * честного прочерка, потому что человек считает работу сделанной.
 *
 * Прочерков пять видов, и они разные для человека:
 * - `no_env_section` — писать некуда вовсе (goose, kimi, cursor, opencode);
 * - `no_documented_base_url` — файл есть, задокументированного имени нет;
 * - `gateway_dialect` — адрес задать МОЖНО, но CLI говорит на диалекте, которого
 *   шлюз не понимает: записать ему адрес значило бы получить 404 на первом же
 *   запросе вместо ответа. Сейчас таких CLI нет — с 07.10.2026 шлюз переводит и
 *   `google` (Gemini); причина остаётся для диалекта, который появится завтра;
 * - `cli_config_bypass` — адрес задать можно, но конфиг человека не даст CLI его
 *   прочесть (Gemini со входом не ключом API);
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
  // Диалект Gemini шлюз переводит на краю (`google-bridge.ts`).
  if (config?.google) return 'google';
  return undefined;
}

/**
 * Отметка раздела у всего, что пишется в файлы CLI: этот адрес читает и ручной
 * запуск в консоли, то есть раздел «Терминал» (баг 11а). Снятая галочка
 * закрывает его в шлюзе сразу, не дожидаясь, пока файлы перепишут.
 */
export const TERMINAL_ROUTE: GatewayUrlRoute = { section: PLATFORM_TERMINAL_CONSUMER };

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
  /** Раздел и метка прогона — см. `GatewayUrlRoute`. */
  route: GatewayUrlRoute = {},
): EndpointProfile {
  return {
    ...managed,
    apiKind,
    baseUrl: gatewayUrlFor(gatewayPort, platformId, apiKind, route),
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
  const baseUrl = gatewayUrlFor(gatewayPort, platformId, file.apiKind, TERMINAL_ROUTE);

  if (file.format === 'codex-toml') {
    return [
      { key: `model_providers.${name}.base_url`, value: baseUrl },
      // Ручка — та, которую принимает сам CLI (`endpointFile.wireApi`), а не
      // та, которую удобно шлюзу: конфиг с чужой ручкой codex не загружает
      // целиком. Шлюз обслуживает `/responses` с MAP D (`responses-bridge.ts`).
      { key: `model_providers.${name}.wire_api`, value: file.wireApi },
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
      title: serverText('contour-target-assistant'),
      write: { kind: 'assistant' },
      filePath: '',
      plan: [],
    },
  ];

  // compromise: no-client-tools — чем дойдут инструменты цели-CLI, решает не цель, а
  // маршрут контура (`toolRouteOf`, едет в плане): у платформы компании без прослойки агент
  // работает как чат, совместимому шлюзу инструменты уходят полем.
  for (const provider of listProviders()) {
    const apiKind = pickApiKind(provider);

    if (apiKind) {
      const profile = targetProfile(managed, platformId, gatewayPort, apiKind, TERMINAL_ROUTE);
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
      // Конфиг человека не даст CLI прочесть адрес (Gemini: вход не ключом API):
      // записанная переменная молча не подействовала бы, а без способа входа
      // gemini с ней не стартует вовсе — терминальный CLI сломался бы целиком.
      if (vars.bypass?.()) {
        targets.push(unsupported(provider, 'cli_config_bypass'));
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
      // Ручка, которой CLI пойдёт по адресу, шлюзу неизвестна — цель становится
      // прочерком ДО записи. Разница не формальная: конфиг codex с ручкой,
      // которую он не принимает, не загружается целиком, и человек получает
      // мёртвый CLI вместо неработающего контура (живая проба 22.09.2026).
      if (!gatewayServes(file.wireApi)) {
        targets.push(unsupported(provider, 'gateway_dialect'));
        continue;
      }
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
