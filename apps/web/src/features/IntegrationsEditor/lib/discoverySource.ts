import type { TFunction } from 'i18next';
import type { DiscoveredIntegration } from '@agentdeck/contracts';

/** Где описан найденный сервер: общий файл или проект — человеку важно, чей это доступ. */
export function discoverySource(item: DiscoveredIntegration, t: TFunction): string {
  if (item.source === 'user') return t('integrations.discover.source.user');
  const project = item.project ?? '';
  return item.source === 'project'
    ? t('integrations.discover.source.project', { project })
    : t('integrations.discover.source.mcpJson', { project });
}
