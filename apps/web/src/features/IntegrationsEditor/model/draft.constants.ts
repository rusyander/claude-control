import type { IntegrationId } from '@agentdeck/contracts';
import type { IntegrationField } from './draft.types';

/** Поля каждого коннектора в том порядке, в каком их заполняют. */
export const INTEGRATION_FIELDS: Record<IntegrationId, readonly IntegrationField[]> = {
  atlassian: [
    { key: 'baseUrl', kind: 'text', isRequired: true },
    { key: 'email', kind: 'text' },
    { key: 'deployment', kind: 'select', options: ['', 'cloud', 'server'] },
    { key: 'confluenceUrl', kind: 'text' },
  ],
  forge: [
    { key: 'kind', kind: 'select', options: ['', 'github', 'gitlab'], isRequired: true },
    { key: 'baseUrl', kind: 'text' },
    { key: 'repo', kind: 'text' },
  ],
  telegram: [{ key: 'chatId', kind: 'text', isRequired: true }],
  webhook: [{ key: 'url', kind: 'text', isRequired: true }],
  tms: [
    { key: 'kind', kind: 'select', options: ['', 'zephyr', 'xray', 'testit'], isRequired: true },
    { key: 'baseUrl', kind: 'text', requiredWhen: { key: 'kind', equals: ['testit'] } },
    { key: 'projectKey', kind: 'text', isRequired: true },
    { key: 'groupId', kind: 'text' },
  ],
  ci: [
    { key: 'kind', kind: 'select', options: ['', 'github', 'gitlab'], isRequired: true },
    { key: 'repo', kind: 'text' },
    { key: 'workflow', kind: 'text' },
    { key: 'artifact', kind: 'text' },
  ],
};
