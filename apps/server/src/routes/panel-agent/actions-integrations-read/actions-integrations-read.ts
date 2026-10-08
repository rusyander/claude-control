import { resolve } from 'node:path';
import { z } from 'zod';
import type { PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import type {
  ConfluencePage,
  ConfluenceSpace,
  IntegrationLink,
  IntegrationLinks,
  JiraIssue,
  JiraProject,
} from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, encode, readRoute, textWindow } from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';
import { maskResult } from '../result-net/result-net.ts';
import { assertRegistered, registeredOnly } from '../registered-folder/registered-folder.ts';
import { unifiedDiff } from '../../../domains/config-preview/unified-diff.ts';

/**
 * Интеграции сверх настройки подключений (`actions-app.ts`): ЧТЕНИЕ Jira и
 * Confluence, привязки проекта к задаче и странице, переходник MCP Atlassian.
 *
 * Записи во внешние системы (завести дефект, комментарий, статус, страница)
 * здесь нет намеренно: исходящая запись — решение человека (список «только
 * человек», D2). Всё прочитанное проходит `maskResult` (правила сетки ответа):
 * в описании задачи и теле страницы люди оставляют ключи, и модель их видеть не
 * должна. `maskDeep` здесь не годится — он прятал `key: 'PRJ'` и
 * `jiraIssueKey: 'PRJ-7'` по имени поля, и модель теряла ключ задачи.
 */

const JIRA = '/api/integrations/jira';
const CONFLUENCE = '/api/integrations/confluence';
const LINKS_URL = '/api/integrations/links';

const limitSchema = z.number().int().min(1).max(50).default(20);

const issueRow = (issue: JiraIssue) => ({
  key: issue.key,
  summary: issue.summary,
  status: issue.status,
  ...(issue.statusCategory ? { statusCategory: issue.statusCategory } : {}),
  type: issue.type,
  ...(issue.assignee ? { assignee: issue.assignee } : {}),
  ...(issue.updatedAt ? { updatedAt: issue.updatedAt } : {}),
  url: issue.url,
});

const jiraProjects = definePanelAction({
  name: 'jira_projects',
  section: 'integrations',
  risk: 'read',
  description: 'Jira projects visible to the saved connection: key and name. Read-only.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: `${JIRA}/projects` }),
  shape: (_input, body) =>
    maskResult({
      projects: (body as JiraProject[]).map((project) => ({
        key: project.key,
        name: project.name,
      })),
    }),
  summary: 'journal-jira-projects',
});

const jiraSearch = definePanelAction({
  name: 'jira_search',
  section: 'integrations',
  risk: 'read',
  description:
    'Search Jira issues by text (q) or by JQL (jql): key, summary, status, type, assignee, url. ' +
    'Read-only; creating or changing issues stays with the human.',
  input: z
    .object({
      q: z.string().trim().min(1).optional().describe('Free text'),
      jql: z.string().trim().min(1).optional().describe('JQL query'),
      limit: limitSchema,
    })
    .refine((input) => Boolean(input.q || input.jql), { message: 'Give q or jql' }),
  route: (input) => {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.q) query.set('q', input.q);
    if (input.jql) query.set('jql', input.jql);
    return { method: 'GET', url: `${JIRA}/search?${query.toString()}` };
  },
  shape: (_input, body) => maskResult({ issues: (body as JiraIssue[]).map(issueRow) }),
  summary: 'journal-jira-search',
});

const jiraIssue = definePanelAction({
  name: 'jira_issue',
  section: 'integrations',
  risk: 'read',
  description:
    'Read one Jira issue by key (PROJ-123): fields and the description text (windowed: pass ' +
    'nextOffset as offset to read on). Read-only.',
  input: z.object({
    key: z.string().trim().min(1).max(64).describe('Issue key, e.g. PROJ-123'),
    offset: z.number().int().min(0).default(0),
  }),
  route: (input) => ({ method: 'GET', url: `${JIRA}/issue/${encode(input.key)}` }),
  shape: (input, body) => {
    const issue = body as JiraIssue;
    return maskResult({
      ...issueRow(issue),
      description: textWindow(issue.description ?? '', input.offset),
    });
  },
  summary: 'journal-jira-issue',
});

const confluenceSpaces = definePanelAction({
  name: 'confluence_spaces',
  section: 'integrations',
  risk: 'read',
  description: 'Confluence spaces visible to the saved connection: key and name. Read-only.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: `${CONFLUENCE}/spaces` }),
  shape: (_input, body) =>
    maskResult({
      spaces: (body as ConfluenceSpace[]).map((space) => ({ key: space.key, name: space.name })),
    }),
  summary: 'journal-confluence-spaces',
});

const pageRow = (page: ConfluencePage) => ({
  id: page.id,
  title: page.title,
  space: page.spaceKey,
  url: page.url,
  ...(page.version === undefined ? {} : { version: page.version }),
});

const confluenceSearch = definePanelAction({
  name: 'confluence_search',
  section: 'integrations',
  risk: 'read',
  description: 'Search Confluence pages by text: id, title, space, url. Read-only.',
  input: z.object({ q: z.string().trim().min(1).describe('Text to find'), limit: limitSchema }),
  route: (input) => ({
    method: 'GET',
    url: `${CONFLUENCE}/search?${new URLSearchParams({ q: input.q, limit: String(input.limit) }).toString()}`,
  }),
  shape: (_input, body) => maskResult({ pages: (body as ConfluencePage[]).map(pageRow) }),
  summary: 'journal-confluence-search',
});

const confluencePage = definePanelAction({
  name: 'confluence_page',
  section: 'integrations',
  risk: 'read',
  description:
    'Read one Confluence page by id: title, space, url and its text (windowed: pass nextOffset ' +
    'as offset to read on). Read-only; publishing stays with the human.',
  input: z.object({
    id: z.string().trim().min(1).max(64).describe('Page id from confluence_search'),
    offset: z.number().int().min(0).default(0),
  }),
  route: (input) => ({ method: 'GET', url: `${CONFLUENCE}/page/${encode(input.id)}` }),
  shape: (input, body) => {
    const page = body as ConfluencePage;
    return maskResult({ ...pageRow(page), body: textWindow(page.body ?? '', input.offset) });
  },
  summary: 'journal-confluence-page',
});

const pathSchema = z.string().trim().min(1).describe('Absolute project directory');
const groupSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('Test group id; omit for the whole project');

const linksUrl = (path: string) => `${LINKS_URL}?path=${encode(path)}`;
const readLinks = (inject: InjectRoute, path: string) =>
  readRoute<IntegrationLinks>(inject, linksUrl(path));

/** Привязка названной группы или проекта — то, что правит запись. */
const linkOf = (links: IntegrationLinks, groupId: string | undefined): IntegrationLink =>
  (groupId ? links.groups[groupId] : links.project) ?? {};

const listIntegrationLinks = definePanelAction({
  name: 'list_integration_links',
  section: 'integrations',
  risk: 'read',
  description:
    'What a tested project is linked to: Jira project/issue, Confluence page, forge repo and a ' +
    'note — for the project and per test group. Read-only.',
  input: z.object({ path: pathSchema }),
  // Карточки у чтения нет — проект проверяется здесь (см. `registeredOnly`).
  route: async (input, inject) => {
    await assertRegistered(inject, input.path);
    return { method: 'GET', url: linksUrl(input.path) };
  },
  shape: (_input, body) => maskResult(body),
  summary: 'journal-list-integration-links',
});

const linkField = z.string().trim().min(1).max(200).optional();

const linkInput = z.object({
  path: pathSchema,
  groupId: groupSchema,
  jiraProjectKey: linkField.describe('Jira project for new defects'),
  jiraIssueKey: linkField.describe('Issue the work belongs to'),
  jiraIssueTitle: linkField,
  confluencePageId: linkField.describe('Page with requirements / for the report'),
  confluencePageTitle: linkField,
  forgeRepo: linkField.describe('Forge repository when origin does not name it'),
  note: z.string().trim().min(1).max(500).optional(),
});
type LinkInput = z.infer<typeof linkInput>;

/** Привязка после правки: названные поля поверх сохранённых. */
function nextLink(current: IntegrationLink, input: LinkInput): IntegrationLink {
  const { path: _path, groupId: _group, ...fields } = input;
  const named = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as IntegrationLink;
  return { ...current, ...named };
}

/**
 * Подписи строк диффа: `unifiedDiff` пропускает каждую строку через детектор
 * секретов, а тот прячет значение после имени `…Key` (`"jiraIssueKey": "PRJ-7"`
 * → маска). В карточке — те же поля под именами без `Key`.
 */
const CARD_NAMES: Partial<Record<keyof IntegrationLink, string>> = {
  jiraProjectKey: 'jiraProject',
  jiraIssueKey: 'jiraIssue',
};

const linkJson = (link: IntegrationLink): string => {
  if (Object.keys(link).length === 0) return '';
  const masked = maskResult(link) as Record<string, unknown>;
  const named = Object.fromEntries(
    Object.entries(masked).map(([name, value]) => [
      CARD_NAMES[name as keyof IntegrationLink] ?? name,
      value,
    ]),
  );
  return `${JSON.stringify(named, null, 2)}\n`;
};

/**
 * Карточка привязки: дифф «было → станет» по правилам сетки ответа, а не
 * `stateCard` — тот маскирует `jiraIssueKey` по имени, и человек подтверждал бы
 * привязку к задаче, которой в карточке не видно.
 */
function linkCard(
  before: IntegrationLink,
  after: IntegrationLink,
  summary: ReturnType<typeof card>,
  fields: PanelActionPreview['fields'],
): PanelActionPreview {
  const diff = unifiedDiff('integration-link', linkJson(before), linkJson(after));
  if (!diff.truncated && diff.diff === '') {
    throw new Error('Nothing would change: the current state already matches the request.');
  }
  return {
    ...summary,
    fields,
    ...(diff.truncated
      ? {
          truncated: true,
          diff: '--- a/integration-link\n+++ b/integration-link\n(правка слишком велика для построчного диффа)',
        }
      : { diff: diff.diff }),
  };
}

const projectName = (path: string) => resolve(path).split(/[\\/]/).filter(Boolean).pop() ?? path;

const saveIntegrationLink = definePanelAction({
  name: 'save_integration_link',
  section: 'integrations',
  risk: 'change',
  title: 'journal-save-integration-link',
  description:
    'Link a tested project (or one of its test groups) to a Jira issue/project, a Confluence page, ' +
    'a forge repo, a note. Named fields change, the rest stays. Local note only — nothing is ' +
    'written to Jira or Confluence. Needs the human’s confirmation.',
  input: linkInput,
  route: async (input, inject) => ({
    method: 'PUT',
    url: LINKS_URL,
    body: {
      path: input.path,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      link: nextLink(linkOf(await readLinks(inject, input.path), input.groupId), input),
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(linkOf(await readLinks(inject, input.path), input.groupId)),
  preview: async (input, inject) => {
    const current = linkOf(await readLinks(inject, input.path), input.groupId);
    return linkCard(
      current,
      nextLink(current, input),
      card('summary-save-integration-link', { project: projectName(input.path) }),
      [
        input.groupId
          ? dataField('label-link-scope', input.groupId)
          : textField('label-link-scope', 'value-link-project'),
      ],
    );
  },
  shape: (input, body) => maskResult(linkOf(body as IntegrationLinks, input.groupId)),
});

const removeIntegrationLink = definePanelAction({
  name: 'remove_integration_link',
  section: 'integrations',
  risk: 'danger',
  title: 'journal-remove-integration-link',
  description:
    'Remove the link of a tested project (or of one test group). Nothing in Jira or Confluence ' +
    'changes. Needs the human’s confirmation.',
  input: z.object({ path: pathSchema, groupId: groupSchema }),
  route: (input) => ({
    method: 'DELETE',
    url: LINKS_URL,
    body: { path: input.path, ...(input.groupId ? { groupId: input.groupId } : {}) },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(linkOf(await readLinks(inject, input.path), input.groupId)),
  preview: async (input, inject) => {
    const current = linkOf(await readLinks(inject, input.path), input.groupId);
    if (Object.keys(current).length === 0) {
      throw new Error('Nothing would change: there is no link there.');
    }
    return linkCard(
      current,
      {},
      card('summary-remove-integration-link', { project: projectName(input.path) }),
      [
        input.groupId
          ? dataField('label-link-scope', input.groupId)
          : textField('label-link-scope', 'value-link-project'),
      ],
    );
  },
  shape: () => ({ removed: true }),
});

const MCP_URL = '/api/integrations/mcp/connect';

interface McpState {
  name: string;
  connected: boolean;
  removed?: boolean;
}

// Только отключение. Подключённый MCP Atlassian даёт любому агенту писать в Jira и
// Confluence без карточки — это согласие человека (владелец, 28.09), кнопка на странице
// «Интеграции», а не действие модели.
const atlassianMcp = definePanelAction({
  name: 'atlassian_mcp_disconnect',
  section: 'integrations',
  risk: 'change',
  title: 'journal-atlassian-mcp',
  description:
    'Disconnect the Jira and Confluence MCP server from the CLI config. Connecting it is the ' +
    'human’s own act (the “Connect Atlassian MCP” button on the Integrations page): once ' +
    'connected, any agent writes to Jira and Confluence without a card. Needs the human’s ' +
    'confirmation.',
  input: z.object({}),
  route: () => ({ method: 'DELETE', url: MCP_URL }),
  fingerprint: async (_input, inject) => fingerprintOf(await readRoute<McpState>(inject, MCP_URL)),
  preview: async (_input, inject) => {
    const state = await readRoute<McpState>(inject, MCP_URL);
    if (!state.connected)
      throw new Error('Nothing would change: the Atlassian MCP server is not connected.');
    return {
      ...card('summary-atlassian-mcp-disconnect'),
      fields: [
        dataField('label-mcp-server', state.name),
        textField('label-what-happens', 'value-mcp-disconnect-effect'),
      ],
    };
  },
  shape: (_input, body) => {
    const state = body as McpState;
    return {
      name: state.name,
      connected: state.connected,
      ...(state.removed === undefined ? {} : { removed: state.removed }),
    };
  },
});

/** Интеграции сверх настройки подключений: в порядке показа. */
export const INTEGRATIONS_READ_ACTIONS: readonly AnyPanelAction[] = [
  jiraProjects,
  jiraSearch,
  jiraIssue,
  confluenceSpaces,
  confluenceSearch,
  confluencePage,
  listIntegrationLinks,
  // Привязки — у тестируемого проекта панели: чужая папка — отказ до карточки.
  registeredOnly(saveIntegrationLink, { field: 'path' }),
  registeredOnly(removeIntegrationLink, { field: 'path' }),
  atlassianMcp,
];
