import { z } from 'zod';
import type {
  Group,
  McpServer,
  McpServerDraft,
  PermissionRule,
  Project,
} from '@agentdeck/contracts';
import type { PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import {
  groupKeyOf,
  pairsOf,
  type ProjectGroupChoiceView,
} from '@agentdeck/contracts/group-sources';
import { unifiedDiff } from '../../domains/config-preview/unified-diff.ts';
import { maskSecretsInText, SECRET_MASK } from '../../lib/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import {
  card,
  encode,
  literalSecrets,
  OFFSET_DESCRIPTION,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
  textWindow,
  unmasked,
} from './action-kit.ts';
import {
  emptySecretFields,
  maskArgs,
  maskMcpServer,
  resolvePermissionId,
} from './actions-config-secrets.ts';
import { mcpDraft, mcpInput, permissionsPage, type McpInput } from './actions-config.ts';
import { pageFor, projectOf, projectPage, projectRef, samePath } from './project-target.ts';
import { dataField, textField } from './texts.ts';

/**
 * Действия над конфигурацией ОДНОГО проекта (U4a): его файл инструкций,
 * `.mcp.json`, права `.claude/settings*.json` и выбор стороны пары групп.
 * Исполняются проектными маршрутами окна (`/api/projects/:id/...`,
 * `/api/projects/group-choice`) — те же проверки, резервная копия и гейт
 * провайдера. Проектные файлы лежат в репозитории проекта, поэтому карточка —
 * дифф того, что уйдёт в файл, а секреты модель не видит и не присылает теми же
 * правилами, что и у пользовательского уровня (`actions-config.ts`).
 */

// --- Файл инструкций ---

interface ProjectRulesFile {
  content: string;
  fileName: string;
  filePath: string;
}

const rulesUrl = (project: Project) => `/api/projects/${encode(project.id)}/rules`;

const readRules = (inject: InjectRoute, project: Project) =>
  readRoute<ProjectRulesFile>(inject, rulesUrl(project));

const readProjectClaudeMd = definePanelAction({
  name: 'read_project_claude_md',
  section: 'projects',
  risk: 'read',
  description:
    'Read the instructions file of one project (CLAUDE.md, or AGENTS.md when that is what the CLI reads there) ' +
    'in windows of ~15000 chars; pass nextOffset to continue. Secret values are masked.',
  input: z.object({
    project: projectRef,
    offset: z.number().int().nonnegative().default(0).describe(OFFSET_DESCRIPTION),
  }),
  route: async (input, inject) => ({
    method: 'GET',
    url: rulesUrl(await projectOf(inject, input)),
  }),
  shape: (input, body) => {
    const file = body as ProjectRulesFile;
    return {
      fileName: file.fileName,
      filePath: file.filePath,
      ...textWindow(maskSecretsInText(file.content), input.offset),
    };
  },
  summary: 'journal-project-claude-md-read',
});

/** Новый текст: без литералов секретов, маски из чтения — секретами с диска. */
async function rulesContent(inject: InjectRoute, project: Project, content: string) {
  if (literalSecrets({ content }).length > 0) throw new Error(`content: ${SECRET_REFUSAL}`);
  if (!content.includes(SECRET_MASK)) return content;
  return unmasked('content', (await readRules(inject, project)).content, content);
}

const saveProjectClaudeMd = definePanelAction({
  name: 'save_project_claude_md',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-claude-md-save',
  description:
    'Replace the WHOLE instructions file of one project with `content` (read_project_claude_md first, send the ' +
    'full new text). The file lives in the project repository. Needs confirmation; the card shows the diff.',
  input: z.object({ project: projectRef, content: z.string().max(400_000) }),
  route: async (input, inject) => {
    const project = await projectOf(inject, input);
    return {
      method: 'PUT',
      url: rulesUrl(project),
      body: { content: await rulesContent(inject, project, input.content) },
    };
  },
  fingerprint: async (input, inject) => {
    const project = await projectOf(inject, input);
    const saved = await readRules(inject, project);
    return fingerprintOf({ path: saved.filePath, content: saved.content });
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const saved = await readRules(inject, project);
    const next = await rulesContent(inject, project, input.content);
    const diff = unifiedDiff(saved.fileName, saved.content, next);
    if (!diff.truncated && diff.diff === '') {
      throw new Error('Nothing would change: the file already matches the request.');
    }
    return {
      ...card('summary-project-claude-md-save', { project: project.name }),
      fields: [dataField('label-file', `${saved.filePath} (+${diff.added} −${diff.removed})`)],
      ...(diff.truncated
        ? {
            truncated: true,
            diff: `--- a/${saved.fileName}\n+++ b/${saved.fileName}\n(правка слишком велика для построчного диффа)`,
          }
        : { diff: diff.diff }),
    } satisfies PanelActionPreview;
  },
  page: (input) => pageFor(input),
});

// --- MCP проекта ---

const mcpUrl = (project: Project) => `/api/projects/${encode(project.id)}/mcp`;

const readProjectMcp = (inject: InjectRoute, project: Project) =>
  readRoute<McpServer[]>(inject, mcpUrl(project));

const mcpList = (project: Project) => ({ url: mcpUrl(project), action: 'list_project_mcp' });

const listProjectMcp = definePanelAction({
  name: 'list_project_mcp',
  section: 'projects',
  risk: 'read',
  description:
    'List MCP servers of one project (.mcp.json in its root). Secret values are masked (••••••); ${VAR} references stay.',
  input: z.object({ project: projectRef }),
  route: async (input, inject) => ({
    method: 'GET',
    url: mcpUrl(await projectOf(inject, input)),
  }),
  shape: (_input, body) => ({ servers: (body as McpServer[]).map(maskMcpServer) }),
  summary: 'journal-project-mcp-list',
});

const projectMcpInput = mcpInput.safeExtend({ project: projectRef });
type ProjectMcpInput = McpInput & { project: string };

/** Черновик для глаз: секретные значения и аргументы-секреты — маской. */
const shownDraft = (draft: McpServerDraft) => ({
  name: draft.name,
  transport: draft.transport,
  ...(draft.command ? { command: draft.command } : {}),
  args: maskArgs(draft.args),
  ...(draft.url ? { url: draft.url } : {}),
  env: draft.env,
  headers: draft.headers,
});

const shownServer = (server: McpServer | undefined) =>
  server
    ? shownDraft({
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.env,
        headers: server.headers,
        groupIds: server.groupIds,
      })
    : undefined;

async function projectDraft(input: ProjectMcpInput, inject: InjectRoute) {
  const project = await projectOf(inject, input);
  const { project: _ref, ...server } = input;
  const draft = await mcpDraft(server, inject, mcpList(project));
  return { project, draft };
}

/** Какой черновик ушёл в запись — для шага секрета (он синхронный). */
const writtenDrafts = new WeakMap<object, { project: Project; draft: McpServerDraft }>();

const saveProjectMcpServer = definePanelAction({
  name: 'save_project_mcp_server',
  section: 'projects',
  // Команда stdio исполнится потом, при каждом старте CLI в проекте, без
  // карточки, — как команда dev-сервера и бутстрапа копий: danger (ревью m5).
  risk: 'danger',
  title: 'journal-project-mcp-save',
  description:
    'Create or edit an MCP server in one project’s .mcp.json (shared with everyone who clones the repo). ' +
    'Never send secret values: leave secret env/header values "" or ${VAR}; the human enters them. Needs confirmation.',
  input: projectMcpInput,
  route: async (input, inject) => {
    const written = await projectDraft(input, inject);
    writtenDrafts.set(input, written);
    const url = mcpUrl(written.project);
    return input.id === undefined
      ? { method: 'POST', url, body: written.draft }
      : { method: 'PUT', url: `${url}/${encode(input.id)}`, body: written.draft };
  },
  fingerprint: async (input, inject) => {
    const { project, draft } = await projectDraft(input, inject);
    return fingerprintOf({ draft, servers: await readProjectMcp(inject, project) });
  },
  preview: async (input, inject) => {
    const { project, draft } = await projectDraft(input, inject);
    const current =
      input.id === undefined
        ? undefined
        : (await readProjectMcp(inject, project)).find((item) => item.id === input.id);
    const waiting = emptySecretFields(draft);
    return stateCard(
      `.mcp.json: mcpServers/${draft.name}`,
      shownServer(current),
      shownDraft(draft),
      input.id === undefined
        ? card('summary-project-mcp-add', { name: input.name, project: project.name })
        : card('summary-project-mcp-edit', { name: input.id, project: project.name }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        dataField('label-transport', draft.transport),
        ...(draft.command
          ? [
              dataField(
                'label-command',
                maskSecretsInText([draft.command, ...maskArgs(draft.args)].join(' ')),
              ),
            ]
          : []),
        ...(draft.url ? [dataField('label-address', maskSecretsInText(draft.url))] : []),
        ...(waiting.length > 0 ? [dataField('label-secrets-by-you', waiting.join(', '))] : []),
      ],
    );
  },
  shape: (input) => ({ saved: input.name }),
  secretStep: (input) => {
    const written = writtenDrafts.get(input as object);
    return written && emptySecretFields(written.draft).length > 0
      ? projectPage(written.project)
      : undefined;
  },
  page: (input) => pageFor(input),
});

async function findProjectMcp(inject: InjectRoute, input: { project: string; id: string }) {
  const project = await projectOf(inject, input);
  const server = (await readProjectMcp(inject, project)).find((item) => item.id === input.id);
  if (!server) {
    throw new Error(
      `MCP server «${input.id}» is not in project «${project.name}». Call list_project_mcp.`,
    );
  }
  return { project, server };
}

const deleteProjectMcpServer = definePanelAction({
  name: 'delete_project_mcp_server',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-mcp-delete',
  description: 'Delete an MCP server from one project’s .mcp.json. Needs confirmation.',
  input: z.object({ project: projectRef, id: z.string().min(1) }),
  route: async (input, inject) => {
    const { project } = await findProjectMcp(inject, input);
    return { method: 'DELETE', url: `${mcpUrl(project)}/${encode(input.id)}` };
  },
  fingerprint: async (input, inject) => fingerprintOf((await findProjectMcp(inject, input)).server),
  preview: async (input, inject) => {
    const { project, server } = await findProjectMcp(inject, input);
    return stateCard(
      `.mcp.json: mcpServers/${server.name}`,
      shownServer(server),
      {},
      card('summary-project-mcp-delete', { name: server.name, project: project.name }),
      [dataField('label-project', `${project.name} — ${project.path}`)],
    );
  },
  page: (input) => pageFor(input),
});

const toggleProjectMcpServer = definePanelAction({
  name: 'toggle_project_mcp_server',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-mcp-toggle',
  description:
    'Turn an MCP server of one project on or off (moves it between the enabled and disabled lists of .mcp.json). Needs confirmation.',
  input: z.object({ project: projectRef, id: z.string().min(1), enabled: z.boolean() }),
  route: async (input, inject) => {
    const { project } = await findProjectMcp(inject, input);
    return {
      method: 'POST',
      url: `${mcpUrl(project)}/${encode(input.id)}/enabled`,
      body: { isEnabled: input.enabled },
    };
  },
  fingerprint: async (input, inject) => fingerprintOf((await findProjectMcp(inject, input)).server),
  preview: async (input, inject) => {
    const { project, server } = await findProjectMcp(inject, input);
    if (server.isEnabled === input.enabled) {
      throw new Error('Nothing would change: the server is already in that state.');
    }
    return stateCard(
      `.mcp.json: mcpServers/${server.name}`,
      { name: server.name, isEnabled: server.isEnabled },
      { name: server.name, isEnabled: input.enabled },
      card(input.enabled ? 'summary-project-mcp-enable' : 'summary-project-mcp-disable', {
        name: server.name,
        project: project.name,
      }),
      [dataField('label-project', `${project.name} — ${project.path}`)],
    );
  },
  page: (input) => pageFor(input),
});

// --- Права проекта ---

const permissionsUrl = (project: Project) => `/api/projects/${encode(project.id)}/permissions`;

const readProjectPermissions = (inject: InjectRoute, project: Project) =>
  readRoute<PermissionRule[]>(inject, permissionsUrl(project));

const listProjectPermissions = definePanelAction({
  name: 'list_project_permissions',
  section: 'projects',
  risk: 'read',
  description:
    'List permission rules of one project (.claude/settings.json; ids with "local:" live in settings.local.json) ' +
    'with counts per decision. Paged: follow nextOffset. Filter by decision and/or a pattern substring.',
  input: z.object({
    project: projectRef,
    decision: z.enum(['allow', 'ask', 'deny']).optional(),
    query: z.string().max(200).optional().describe('Case-insensitive substring of the pattern'),
    offset: z.number().int().min(0).default(0).describe(OFFSET_DESCRIPTION),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  route: async (input, inject) => ({
    method: 'GET',
    url: permissionsUrl(await projectOf(inject, input)),
  }),
  shape: (input, body) => permissionsPage(body as PermissionRule[], input),
  summary: 'journal-project-permissions-list',
});

const decisionValue = (decision: PermissionRule['decision']) =>
  textField('label-project-decision', `value-project-decision-${decision}`);

/** Шаблон права с живым секретом не принимается: его вводит человек. */
function checkedPattern(pattern: string): string {
  if (literalSecrets({ pattern }).length > 0) throw new Error(`pattern: ${SECRET_REFUSAL}`);
  return pattern;
}

/** Право проекта по id из `list_project_permissions` (возможно, непрозрачному). */
async function findProjectPermission(inject: InjectRoute, input: { project: string; id: string }) {
  const sent = input.id;
  const project = await projectOf(inject, input);
  const rules = await readProjectPermissions(inject, project);
  const id = resolvePermissionId(
    sent,
    rules.map((rule) => rule.id),
    fingerprintOf,
  );
  const rule = id === undefined ? undefined : rules.find((item) => item.id === id);
  if (!rule) {
    throw new Error(
      `Permission rule «${sent}» is not in project «${project.name}». Call list_project_permissions.`,
    );
  }
  return { project, rule, rules };
}

const shownRule = (rule: { decision: string; pattern: string }) => ({
  decision: rule.decision,
  pattern: maskSecretsInText(rule.pattern),
});

const decisionInput = z.enum(['allow', 'ask', 'deny']);
const patternInput = z.string().trim().min(1).max(500);

const addProjectPermission = definePanelAction({
  name: 'add_project_permission',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-permission-add',
  description:
    'Add a permission rule to one project’s .claude/settings.json, e.g. decision "allow", pattern "Bash(pnpm test:*)". Needs confirmation.',
  input: z.object({ project: projectRef, decision: decisionInput, pattern: patternInput }),
  route: async (input, inject) => ({
    method: 'POST',
    url: permissionsUrl(await projectOf(inject, input)),
    body: { decision: input.decision, pattern: checkedPattern(input.pattern), groupIds: [] },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(await readProjectPermissions(inject, await projectOf(inject, input))),
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const pattern = checkedPattern(input.pattern);
    const rules = await readProjectPermissions(inject, project);
    if (rules.some((rule) => rule.id === `${input.decision}:${pattern}`)) {
      throw new Error('Nothing would change: this rule is already in the project.');
    }
    return stateCard(
      `.claude/settings.json: permissions/${input.decision}`,
      undefined,
      shownRule({ decision: input.decision, pattern }),
      card('summary-project-permission-add', {
        pattern: maskSecretsInText(pattern),
        project: project.name,
      }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        decisionValue(input.decision),
      ],
    );
  },
  page: (input) => pageFor(input),
});

const editProjectPermission = definePanelAction({
  name: 'edit_project_permission',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-permission-edit',
  description:
    'Change the decision and/or pattern of one project permission rule by id from list_project_permissions. Needs confirmation.',
  input: z.object({
    project: projectRef,
    id: z.string().min(1),
    decision: decisionInput,
    pattern: patternInput,
  }),
  route: async (input, inject) => {
    const { project, rule } = await findProjectPermission(inject, input);
    return {
      method: 'PUT',
      url: `${permissionsUrl(project)}/${encode(rule.id)}`,
      body: {
        decision: input.decision,
        pattern: unmasked('pattern', rule.pattern, checkedPattern(input.pattern)),
        groupIds: rule.groupIds,
      },
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf((await findProjectPermission(inject, input)).rule),
  preview: async (input, inject) => {
    const { project, rule } = await findProjectPermission(inject, input);
    const pattern = unmasked('pattern', rule.pattern, checkedPattern(input.pattern));
    return stateCard(
      `.claude/${rule.source === 'settings-local' ? 'settings.local.json' : 'settings.json'}: permissions`,
      shownRule(rule),
      shownRule({ decision: input.decision, pattern }),
      card('summary-project-permission-edit', {
        pattern: maskSecretsInText(pattern),
        project: project.name,
      }),
      [
        dataField('label-project', `${project.name} — ${project.path}`),
        decisionValue(input.decision),
      ],
    );
  },
  page: (input) => pageFor(input),
});

const removeProjectPermission = definePanelAction({
  name: 'remove_project_permission',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-permission-remove',
  description:
    'Remove one project permission rule by id from list_project_permissions. Needs confirmation.',
  input: z.object({ project: projectRef, id: z.string().min(1) }),
  route: async (input, inject) => {
    const { project, rule } = await findProjectPermission(inject, input);
    return { method: 'DELETE', url: `${permissionsUrl(project)}/${encode(rule.id)}` };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf((await findProjectPermission(inject, input)).rule),
  preview: async (input, inject) => {
    const { project, rule } = await findProjectPermission(inject, input);
    return stateCard(
      `.claude/${rule.source === 'settings-local' ? 'settings.local.json' : 'settings.json'}: permissions`,
      shownRule(rule),
      {},
      card('summary-project-permission-remove', {
        rule: maskSecretsInText(rule.id),
        project: project.name,
      }),
      [dataField('label-project', `${project.name} — ${project.path}`)],
    );
  },
  page: (input) => pageFor(input),
});

// --- Выбор стороны пары групп ---

const groupKeyInput = z
  .string()
  .regex(/^(global|project):.+$/, 'global:<group id> or project:<group id>');

const choiceUrl = (project: Project, group?: string) =>
  `/api/projects/group-choice?path=${encode(project.path)}${group ? `&group=${encode(group)}` : ''}`;

const readProjectGroupChoice = definePanelAction({
  name: 'read_project_group_choice',
  section: 'projects',
  risk: 'read',
  description:
    'Which side of each group pair is active in one project: a project group or its global copy. ' +
    'choices maps project group id → active key (global:<id> | project:<id>); empty = project groups everywhere.',
  input: z.object({
    project: projectRef,
    group: z.string().trim().min(1).optional().describe('Group id or key of one pair; omit = all'),
  }),
  route: async (input, inject) => ({
    method: 'GET',
    url: choiceUrl(await projectOf(inject, input), input.group),
  }),
  summary: 'journal-project-group-choice',
});

/**
 * Пара проекта, стороной которой назван ключ, или отказ до карточки: маршрут
 * ответил бы 404/409 уже после клика человека.
 */
async function pairOf(inject: InjectRoute, project: Project, key: string) {
  const groups = await readRoute<Group[]>(inject, '/api/groups');
  const pair = pairsOf(groups, (path) => samePath(path, project.path)).find(
    (item) => groupKeyOf(item.project) === key || (item.global && groupKeyOf(item.global) === key),
  );
  if (!pair) {
    throw new Error(
      `«${key}» is not a side of any group pair in project «${project.name}». ` +
        'Call read_project_group_choice and list_groups.',
    );
  }
  const side = groupKeyOf(pair.project) === key ? pair.project : (pair.global ?? pair.project);
  return { pair, name: `${side.name} (${key})` };
}

const setProjectGroupChoice = definePanelAction({
  name: 'set_project_group_choice',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-group-choice-set',
  description:
    'Choose which side of a group pair is active in one project: groupKey "global:<id>" or "project:<id>" ' +
    '(ids from read_project_group_choice / list_groups); null returns every pair to its project group. Needs confirmation.',
  input: z.object({ project: projectRef, groupKey: groupKeyInput.nullable() }),
  route: async (input, inject) => ({
    method: 'PUT',
    url: '/api/projects/group-choice',
    body: { path: (await projectOf(inject, input)).path, groupKey: input.groupKey },
  }),
  fingerprint: async (input, inject) => {
    const project = await projectOf(inject, input);
    return fingerprintOf(await readRoute<ProjectGroupChoiceView>(inject, choiceUrl(project)));
  },
  preview: async (input, inject) => {
    const project = await projectOf(inject, input);
    const before = await readRoute<ProjectGroupChoiceView>(inject, choiceUrl(project));
    const label = `group-choice: ${project.path}`;
    const fields = [dataField('label-project', `${project.name} — ${project.path}`)];
    if (input.groupKey === null) {
      if (Object.keys(before.choices).length === 0) {
        throw new Error('Nothing would change: every pair already uses its project group.');
      }
      return stateCard(
        label,
        before.choices,
        {},
        card('summary-project-group-choice-reset', { project: project.name }),
        fields,
      );
    }
    const current = await readRoute<ProjectGroupChoiceView>(
      inject,
      choiceUrl(project, input.groupKey),
    );
    const { pair, name } = await pairOf(inject, project, input.groupKey);
    const active = current.groupKey ?? groupKeyOf(pair.project);
    if (active === input.groupKey) {
      throw new Error('Nothing would change: that group is already the active one.');
    }
    return stateCard(
      label,
      { active },
      { active: input.groupKey },
      card('summary-project-group-choice', { group: name, project: project.name }),
      [...fields, dataField('label-group', name)],
    );
  },
  page: (input) => pageFor(input),
});

/** Действия конфигурации проекта в порядке показа: чтения, затем правки. */
export const PROJECT_CONFIG_ACTIONS: readonly AnyPanelAction[] = [
  readProjectClaudeMd,
  listProjectMcp,
  listProjectPermissions,
  readProjectGroupChoice,
  saveProjectClaudeMd,
  saveProjectMcpServer,
  deleteProjectMcpServer,
  toggleProjectMcpServer,
  addProjectPermission,
  editProjectPermission,
  removeProjectPermission,
  setProjectGroupChoice,
];
