import type { ProviderRunnerInfo } from '@agentdeck/contracts';

/**
 * Что сказать человеку, когда у ассистента нет пути (`mode: 'none'`):
 * - `key` — вставить API-ключ (или войти в CLI, если он запускается);
 * - `cliOnly` — своего API нет, но CLI запускается сам (Continue): ключ не
 *   поможет, поможет установленный CLI;
 * - `unsupported` — ни API, ни скриптуемого CLI: только другой провайдер.
 * `hidden` — путь есть, модалки нет.
 */
export type GateKind = 'hidden' | 'key' | 'cliOnly' | 'unsupported';

export function gateKind(
  runner: Pick<ProviderRunnerInfo, 'mode' | 'reason' | 'apiKind' | 'cliRunnable'> | undefined,
): GateKind {
  if (!runner || runner.mode !== 'none') return 'hidden';
  if (runner.apiKind === 'none') return runner.cliRunnable ? 'cliOnly' : 'unsupported';
  return runner.reason === 'unsupported' ? 'unsupported' : 'key';
}
