import type {
  ProviderCheckLevel,
  ProviderCheckResult,
  ProviderCheckStep,
} from '@claude-control/contracts';
import { getProvider } from '../../providers/registry.ts';
import { checkAssistant } from './steps-assistant.ts';
import { checkCli, checkConfig } from './steps-environment.ts';
import { checkEnv, checkInstructions, checkMcp, checkPermissions } from './steps-write-cycle.ts';
import type { ProviderCheckDeps } from './types.ts';

/**
 * Уровень доверия по шагам.
 *
 * `fail` где угодно — провал. `warn` (нет CLI, конфига ещё нет) — «частично»:
 * работает, но не всё. Пропуск НЕ считается провалом: у провайдера может просто
 * не быть раздела (у Claude MCP и права живут на своих богатых маршрутах), и
 * требовать от него несуществующий круг записи было бы неправдой.
 *
 * А вот ассистент обязан ответить: «проверено» означает «панель сходила до
 * модели этого CLI здесь и получила ответ». Отключил запуск — уровень честно
 * остаётся частичным.
 */
export function levelOf(steps: ProviderCheckStep[]): ProviderCheckLevel {
  if (steps.some((item) => item.status === 'fail')) return 'failed';
  if (steps.some((item) => item.status === 'warn')) return 'partial';
  const assistant = steps.find((item) => item.id === 'assistant');
  return assistant?.status === 'pass' ? 'verified' : 'partial';
}

/** Прогнать проверку одного провайдера. Настоящие файлы пользователя не пишутся. */
export async function checkProvider(
  providerId: string,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckResult> {
  const provider = getProvider(providerId);
  const now = deps.now?.() ?? new Date();

  const steps: ProviderCheckStep[] = [
    checkCli(provider, deps),
    checkConfig(provider, deps),
    checkMcp(provider.id, deps),
    checkPermissions(provider.id, deps),
    checkEnv(provider.id, deps),
    checkInstructions(provider, deps),
    await checkAssistant(provider, deps),
  ];

  return {
    provider: provider.id,
    providerName: provider.name,
    at: now.toISOString(),
    level: levelOf(steps),
    steps,
  };
}
