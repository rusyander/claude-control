/**
 * Фасад модели провайдера конфигурации: путь `providers/types.ts` остаётся
 * публичным для всего сервера и тестов, а тело разъехалось по `types/`:
 * `capabilities.ts` — карта возможностей, `assistant.ts` — запуск CLI и
 * модельное API, `instructions.ts` — три модели раздела инструкций,
 * `sections.ts` — расположение и форматы глобальных разделов, `provider.ts` —
 * проектный уровень и сам `ConfigProvider`.
 */

export {
  CAPABILITIES,
  buildCapabilities,
  uniformCapabilities,
  type Capability,
  type CapabilityMap,
  type CapabilityStatus,
  type ProviderStatus,
} from './types/capabilities.ts';

export type {
  AssistantApiKind,
  ProviderAssistant,
  ProviderCli,
  ProviderEndpointApiKind,
  ProviderEndpointConfig,
  ProviderEndpointVars,
} from './types/assistant.ts';

export type {
  ProviderInstructionsListLocation,
  ProviderInstructionsRulesLocation,
} from './types/instructions.ts';

export type {
  ProviderCommandsConfigLocation,
  ProviderEnvConfigLocation,
  ProviderHooksConfigLocation,
  ProviderMcpConfigLocation,
  ProviderPermissionsConfigLocation,
  ProviderPluginsConfigLocation,
  ProviderSkillsConfigLocation,
} from './types/sections.ts';

export type { ConfigProvider, ProviderProjectConfigLocation } from './types/provider.ts';
