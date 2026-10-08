/**
 * Фасад модели провайдера конфигурации: путь `providers/types/types.ts` остаётся
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
} from './capabilities.ts';

export type {
  AssistantApiKind,
  OneShotRun,
  ProviderAssistant,
  ProviderCli,
  ProviderEndpointApiKind,
  ProviderEndpointConfig,
  ProviderEndpointFile,
  ProviderRunEndpoint,
  RunEndpointInput,
  ProviderEndpointVars,
  ProviderStdoutParser,
} from './assistant.ts';

export type {
  ProviderInstructionsListLocation,
  ProviderInstructionsRulesLocation,
  ProviderRulesConfigLocation,
} from './instructions.ts';

export type {
  ProviderCommandsConfigLocation,
  ProviderEnvConfigLocation,
  ProviderHooksConfigLocation,
  ProviderMcpConfigLocation,
  ProviderPermissionRuleGrammar,
  ProviderPermissionsConfigLocation,
  ProviderPluginsConfigLocation,
  ProviderSkillsConfigLocation,
} from './sections.ts';

export type {
  ConfigProvider,
  ProviderNativeMechanisms,
  ProviderProjectConfigLocation,
} from './provider.ts';
