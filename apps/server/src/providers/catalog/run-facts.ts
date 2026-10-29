import {
  bypassLabel,
  endpointApiKindOf,
  envRunChannel,
  envVarsChannels,
  fileChannel,
  wireApiOf,
} from '@agentdeck/providers/channels';
import { cliRunFacts } from '@agentdeck/providers/registry';
import type { ChannelBypass, CliRunFacts } from '@agentdeck/providers/types';
import type {
  ConfigProvider,
  ProviderAssistant,
  ProviderEndpointConfig,
  ProviderEndpointFile,
  ProviderEndpointVars,
  ProviderRunEndpoint,
} from '../types/types.ts';

/**
 * Мост от фактов запуска (`@agentdeck/providers`) к полям каталога панели. Значения — только
 * из пакета: каталог больше не объявляет имена бинарей, переменных, ключей и лестниц сам.
 * Всё, что читает диск (путь к конфигу, проверка обхода), остаётся здесь, в панели.
 */

/**
 * Мешает ли настройка конфига человека каналу (`true` — мешает). Читает конфиг CLI, поэтому
 * живёт в каталоге панели; имя настройки и нужное значение берутся из фактов.
 */
export type BypassCheck = (bypass: ChannelBypass) => boolean;

/** Факты CLI по id; id без фактов — ошибка сборки каталога, а не тихий пропуск. */
export function runFactsOf(id: string): CliRunFacts {
  const facts = cliRunFacts(id);
  // Сообщения инвариантов — по-английски: до человека они не доходят, роняют сборку каталога.
  if (!facts) throw new Error(`providers: no run facts for "${id}"`);
  return facts;
}

/** Модельное API вендора полями ассистента панели (без способов запуска — они у каталога). */
export function assistantApiOf(
  facts: CliRunFacts,
): Pick<ProviderAssistant, 'apiKind' | 'apiKeyEnvVars' | 'apiBaseUrl' | 'cliRunnable'> {
  const { kind, keyVars, baseUrl } = facts.vendorApi;
  return {
    apiKind: kind,
    apiKeyEnvVars: [...keyVars],
    ...(baseUrl === undefined ? {} : { apiBaseUrl: baseUrl }),
    cliRunnable: facts.cliRunnable,
  };
}

/**
 * Проверка обхода к каналу: заявлен обход — проверка обязательна, не заявлен — запрещена.
 * Иначе каталог молча потерял бы отказ или проверял бы то, чего факты не называют.
 */
function bypassReader(
  id: string,
  bypass: ChannelBypass | undefined,
  check: BypassCheck | undefined,
): (() => string | undefined) | undefined {
  if (!bypass && !check) return undefined;
  if (!bypass || !check) {
    throw new Error(`providers: "${id}" channel bypass and its check do not match`);
  }
  return () => (check(bypass) ? bypassLabel(bypass) : undefined);
}

/** Тройки переменных адреса по видам API, в порядке каналов фактов. */
export function endpointConfigOf(facts: CliRunFacts, check?: BypassCheck): ProviderEndpointConfig {
  const channels = envVarsChannels(facts);
  if (channels.length === 0) throw new Error(`providers: "${facts.id}" has no env vars channel`);
  const config: ProviderEndpointConfig = {};
  for (const channel of channels) {
    const bypass = bypassReader(facts.id, channel.bypass, check);
    const vars: ProviderEndpointVars = {
      baseUrlEnv: channel.baseUrlVar,
      ...(channel.modelVar === undefined ? {} : { modelEnv: channel.modelVar }),
      ...(channel.modelPrefix === undefined ? {} : { modelPrefix: channel.modelPrefix }),
      ...(channel.keyVar === undefined ? {} : { credentialEnv: channel.keyVar }),
      ...(bypass ? { bypass } : {}),
    };
    config[endpointApiKindOf(channel.dialect)] = vars;
  }
  return config;
}

/** Адрес куском собственного конфига CLI; путь к файлу знает только панель. */
export function endpointFileOf(
  facts: CliRunFacts,
  path: ProviderEndpointFile['path'],
): ProviderEndpointFile {
  const channel = fileChannel(facts);
  if (!channel) throw new Error(`providers: "${facts.id}" has no file channel`);
  return {
    format: channel.format,
    path,
    apiKind: endpointApiKindOf(channel.dialect),
    wireApi: wireApiOf(channel.dialect),
  };
}

/** Окружение одного прогона; панель умеет его только для совместимого с OpenAI диалекта. */
export function runEndpointOf(facts: CliRunFacts, check?: BypassCheck): ProviderRunEndpoint {
  const channel = envRunChannel(facts);
  if (!channel) throw new Error(`providers: "${facts.id}" has no run env channel`);
  const apiKind = endpointApiKindOf(channel.dialect);
  if (apiKind !== 'openai-compat') {
    throw new Error(`providers: "${facts.id}" run env channel is not OpenAI-compatible`);
  }
  const bypass = bypassReader(facts.id, channel.bypass, check);
  return { apiKind, env: channel.build, ...(bypass ? { bypass } : {}) };
}

/** Вендоры и лестница моделей — только те поля, что заданы в фактах. */
export function modelsOf(facts: CliRunFacts): Pick<ConfigProvider, 'modelVendors' | 'modelLadder'> {
  return {
    ...(facts.modelVendors ? { modelVendors: [...facts.modelVendors] } : {}),
    ...(facts.modelLadder ? { modelLadder: [...facts.modelLadder] } : {}),
  };
}
