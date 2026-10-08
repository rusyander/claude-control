import type { DiscoverySourceResult } from '@agentdeck/contracts';

/**
 * Журнал обнаружения: сначала то, что требует внимания (ошибки, затем идущие),
 * остальное — свёрнутым хвостом. Порядок внутри групп — как пришёл с сервера.
 */
export function splitDiscoveryLog(sources: readonly DiscoverySourceResult[]): {
  attention: DiscoverySourceResult[];
  rest: DiscoverySourceResult[];
} {
  const failed = sources.filter((source) => source.state === 'failed');
  const running = sources.filter((source) => source.state === 'running');
  const rest = sources.filter((source) => source.state !== 'failed' && source.state !== 'running');
  return { attention: [...failed, ...running], rest };
}
