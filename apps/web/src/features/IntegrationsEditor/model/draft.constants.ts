import type { IntegrationId } from '@agentdeck/contracts';
import type { IntegrationField } from './draft.types';

/** Поля каждого коннектора в том порядке, в каком их заполняют. */
const ATLASSIAN_FIELDS: readonly IntegrationField[] = [
  { key: 'baseUrl', kind: 'text', isRequired: true },
  { key: 'email', kind: 'text' },
  { key: 'deployment', kind: 'select', options: ['', 'cloud', 'server'] },
];

const FORGE_FIELDS: readonly IntegrationField[] = [
  { key: 'baseUrl', kind: 'text' },
  { key: 'repo', kind: 'text' },
];

/** Zephyr и Xray — облака с общим API: адреса у них нет, у Test IT он обязателен. */
const TMS_FIELDS: readonly IntegrationField[] = [
  { key: 'projectKey', kind: 'text', isRequired: true },
  { key: 'groupId', kind: 'text' },
];

/** Поля каждого коннектора в том порядке, в каком их заполняют. */
export const INTEGRATION_FIELDS: Record<IntegrationId, readonly IntegrationField[]> = {
  jira: ATLASSIAN_FIELDS,
  confluence: ATLASSIAN_FIELDS,
  gitlab: FORGE_FIELDS,
  github: FORGE_FIELDS,
  telegram: [{ key: 'chatId', kind: 'text', isRequired: true }],
  zephyr: TMS_FIELDS,
  xray: TMS_FIELDS,
  testit: [{ key: 'baseUrl', kind: 'text', isRequired: true }, ...TMS_FIELDS],
  ci: [
    { key: 'kind', kind: 'select', options: ['', 'github', 'gitlab'], isRequired: true },
    { key: 'repo', kind: 'text' },
    { key: 'workflow', kind: 'text' },
    { key: 'artifact', kind: 'text' },
  ],
  webhook: [{ key: 'url', kind: 'text', isRequired: true }],
};
