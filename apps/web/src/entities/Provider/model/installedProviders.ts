import type { ProviderDetectResponse, ProviderDetection } from '@agentdeck/contracts';

/** Провайдеры с реально установленным CLI — их перечисляет онбординг. */
export function installedProviders(data: ProviderDetectResponse | undefined): ProviderDetection[] {
  return (data?.providers ?? []).filter((item) => item.cliInstalled);
}
