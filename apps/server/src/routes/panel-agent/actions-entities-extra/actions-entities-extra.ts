import { z } from 'zod';
import type { EnvVar, Hook, McpServer, PermissionRule, Skill } from '@agentdeck/contracts';
import { unifiedDiff } from '../../../domains/config-preview/unified-diff.ts';
import { isLocalId, LOCAL_ID_PREFIX, stripLocalPrefix } from '../../../lib/settings-source.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import {
  card,
  encode,
  listPage,
  literalSecrets,
  maskDeep,
  OFFSET_DESCRIPTION,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
  textWindow,
  unmasked,
} from '../action-kit/action-kit.ts';
import { assertClaude } from '../actions-config/actions-config.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Сущности глубже списка: то, что на страницах скиллов, хуков, переменных,
 * прав и MCP делают кнопки строки — переименовать скилл, переставить хук,
 * перенести переменную или право в другой файл, поправить право на месте,
 * проверить связь с MCP-сервером и спросить его инструменты, а также файлы
 * структуры скилла (модули рядом с SKILL.md) и заготовки структуры.
 *
 * Исполнение — маршрутами окна; карточка считается из маршрутов чтения. Файлы
 * конфигурации — только Claude Code (`assertClaude`), как у остальных правок.
 */

const SETTINGS_FILE = {
  settings: 'settings.json',
  'settings-local': 'settings.local.json',
} as const;

const fileOfId = (id: string) => (isLocalId(id) ? 'settings.local.json' : 'settings.json');

// --- Скилл: имя ---

async function findSkill(inject: InjectRoute, id: string): Promise<Skill> {
  const skill = (await readRoute<Skill[]>(inject, '/api/skills')).find((item) => item.id === id);
  if (!skill) throw new Error(`Skill «${id}» not found. Call list_skills.`);
  return skill;
}

const renameSkill = definePanelAction({
  name: 'rename_skill',
  section: 'skills',
  risk: 'change',
  title: 'journal-rename-skill',
  description:
    'Rename a skill: its folder (= its id) gets the new name; its enabled/disabled mark and group ' +
    'memberships move with it. Needs confirmation.',
  input: z.object({
    id: z.string().min(1).describe('Current skill id from list_skills'),
    newId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      // Правило домена (`renameSkill`): имя — одна папка, без разделителей и точек-ссылок.
      .refine(
        (id) => !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('\0'),
        'A skill name is one folder: no slashes, not "." or ".."',
      )
      .describe('New folder name (kebab-case)'),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/skills/${encode(input.id)}/rename`,
    body: { newId: input.newId },
  }),
  fingerprint: async (input, inject) => {
    const skills = await readRoute<Skill[]>(inject, '/api/skills');
    return fingerprintOf({
      skill: skills.find((item) => item.id === input.id) ?? null,
      taken: skills.some((item) => item.id === input.newId),
    });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    const skill = await findSkill(inject, input.id);
    if (input.newId === input.id) throw new Error('Nothing would change: the name is the same.');
    const skills = await readRoute<Skill[]>(inject, '/api/skills');
    if (skills.some((item) => item.id === input.newId)) {
      throw new Error(`The name «${input.newId}» is taken by another skill.`);
    }
    return stateCard(
      'skills/',
      { folder: skill.id, groups: skill.groupIds },
      { folder: input.newId, groups: skill.groupIds },
      card('summary-rename-skill', { from: skill.id, to: input.newId }),
    );
  },
  page: (input) => ({ route: '/skills', focus: input.newId }),
});

// --- Хук: порядок ---

const hookLine = (hook: Hook) =>
  `${hook.matcher ? `[${hook.matcher}] ` : ''}${maskSecretsInText(hook.command)}`;

/**
 * Хуки, среди которых маршрут переставляет: то же событие, тот же файл, только
 * включённые — так соседа ищет `moveHook`. Карточка показывает ровно этот ряд.
 */
function hookLane(hooks: readonly Hook[], hook: Hook): Hook[] {
  return hooks.filter(
    (item) => item.event === hook.event && item.source === hook.source && item.isEnabled,
  );
}

async function hookAndLane(inject: InjectRoute, id: string) {
  const hooks = await readRoute<Hook[]>(inject, '/api/hooks');
  const hook = hooks.find((item) => item.id === id || item.legacyId === id);
  if (!hook) throw new Error(`Hook «${id}» not found. Call list_hooks.`);
  return { hook, lane: hookLane(hooks, hook) };
}

const moveHook = definePanelAction({
  name: 'move_hook',
  section: 'hooks',
  risk: 'change',
  title: 'journal-move-hook',
  description:
    'Move an enabled hook one place up or down among the enabled hooks of the SAME event in the ' +
    'same settings file — Claude Code runs them in this order. Needs confirmation.',
  input: z.object({
    id: z.string().min(1).describe('Hook id from list_hooks'),
    direction: z.enum(['up', 'down']),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/hooks/${encode(input.id)}/move`,
    body: { direction: input.direction },
  }),
  fingerprint: async (input, inject) => {
    const { lane } = await hookAndLane(inject, input.id);
    return fingerprintOf(lane.map((item) => item.id));
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    const { hook, lane } = await hookAndLane(inject, input.id);
    if (!hook.isEnabled) {
      throw new Error('The hook is disabled: only an enabled hook has a place in the run order.');
    }
    const at = lane.findIndex((item) => item.id === hook.id);
    const to = input.direction === 'up' ? at - 1 : at + 1;
    if (to < 0 || to >= lane.length) {
      throw new Error(
        `Nothing to move: the hook is already ${input.direction === 'up' ? 'first' : 'last'} ` +
          `among the enabled ${hook.event} hooks of ${hook.source ?? 'settings'}.`,
      );
    }
    const after = [...lane];
    [after[at], after[to]] = [after[to]!, after[at]!];
    return stateCard(
      `${hook.source === 'settings-local' ? 'settings.local.json' : 'settings.json'}: hooks/${hook.event}`,
      lane.map(hookLine),
      after.map(hookLine),
      card(input.direction === 'up' ? 'summary-move-hook-up' : 'summary-move-hook-down', {
        event: hook.event,
      }),
      [dataField('label-command', hookLine(hook))],
    );
  },
  page: (input) => ({ route: '/hooks', focus: input.id }),
});

// --- Переменная и право: файл ---

async function findEnv(inject: InjectRoute, key: string, source: string): Promise<EnvVar> {
  const vars = await readRoute<EnvVar[]>(inject, '/api/env');
  const found = vars.find((item) => item.key === key && item.source === source);
  if (!found) throw new Error(`Variable ${key} is not in ${source}. Call list_env.`);
  return found;
}

const moveEnv = definePanelAction({
  name: 'move_env',
  section: 'env',
  risk: 'change',
  title: 'journal-move-env',
  description:
    'Move an environment variable between settings.json (shared) and settings.local.json ' +
    '(personal). `source` = the file it is in NOW. Secrets in .mcp-secrets.env and group ' +
    'variables do not move. The value moves as it is, the agent never sees it. Needs confirmation.',
  input: z.object({
    key: z.string().min(1),
    source: z.enum(['settings', 'settings-local']).describe('Where the variable is now'),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/env/${encode(input.key)}/move`,
    body: { source: input.source },
  }),
  fingerprint: async (input, inject) => {
    const vars = await readRoute<EnvVar[]>(inject, '/api/env');
    return fingerprintOf(vars.filter((item) => item.key === input.key));
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    await findEnv(inject, input.key, input.source);
    const target = input.source === 'settings' ? 'settings-local' : 'settings';
    const vars = await readRoute<EnvVar[]>(inject, '/api/env');
    if (vars.some((item) => item.key === input.key && item.source === target)) {
      throw new Error(
        `${SETTINGS_FILE[target]} already has ${input.key}: the two values differ in meaning, ` +
          'so the panel does not overwrite one with the other. Ask the human which one to keep.',
      );
    }
    return {
      ...card('summary-move-env', { key: input.key, to: SETTINGS_FILE[target] }),
      fields: [
        dataField('label-key', input.key),
        dataField('label-file', SETTINGS_FILE[input.source]),
        dataField('label-target-file', SETTINGS_FILE[target]),
      ],
    };
  },
  page: (input) => ({ route: '/env', focus: input.key }),
});

async function findPermission(inject: InjectRoute, id: string): Promise<PermissionRule> {
  const rules = await readRoute<PermissionRule[]>(inject, '/api/permissions');
  const rule = rules.find((item) => item.id === id);
  if (!rule) throw new Error(`Permission «${id}» not found. Call list_permissions.`);
  return rule;
}

const movePermission = definePanelAction({
  name: 'move_permission',
  section: 'permissions',
  risk: 'change',
  title: 'journal-move-permission',
  description:
    'Move a permission rule to the other file: settings.json (shared) ↔ settings.local.json ' +
    '(personal; its id carries "local:"). Its group memberships and enabled mark move with it. ' +
    'Needs confirmation.',
  input: z.object({ id: z.string().min(1).describe('Permission id from list_permissions') }),
  route: (input) => ({ method: 'POST', url: `/api/permissions/${encode(input.id)}/move` }),
  fingerprint: async (input, inject) => {
    const rules = await readRoute<PermissionRule[]>(inject, '/api/permissions');
    const bare = stripLocalPrefix(input.id);
    return fingerprintOf(rules.filter((item) => stripLocalPrefix(item.id) === bare));
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    const rule = await findPermission(inject, input.id);
    const movedId = isLocalId(rule.id) ? stripLocalPrefix(rule.id) : `${LOCAL_ID_PREFIX}${rule.id}`;
    const rules = await readRoute<PermissionRule[]>(inject, '/api/permissions');
    if (rules.some((item) => item.id === movedId)) {
      throw new Error(`${fileOfId(movedId)} already has this rule: nothing to move.`);
    }
    return {
      ...card('summary-move-permission', { pattern: rule.pattern, to: fileOfId(movedId) }),
      fields: [
        dataField('label-file', fileOfId(rule.id)),
        dataField('label-target-file', fileOfId(movedId)),
      ],
    };
  },
  page: () => ({ route: '/permissions' }),
});

const editPermission = definePanelAction({
  name: 'edit_permission_rule',
  section: 'permissions',
  risk: 'change',
  title: 'journal-edit-permission',
  description:
    'Change a permission rule IN PLACE — its decision (allow/ask/deny) and/or pattern — keeping ' +
    'its file, position and group memberships (remove + add would lose them). Needs confirmation.',
  input: z.object({
    id: z.string().min(1).describe('Permission id from list_permissions'),
    decision: z.enum(['allow', 'ask', 'deny']),
    pattern: z.string().trim().min(1).max(2_000),
  }),
  route: async (input, inject) => {
    const rule = await findPermission(inject, input.id);
    return {
      method: 'PUT',
      url: `/api/permissions/${encode(input.id)}`,
      body: { decision: input.decision, pattern: input.pattern, groupIds: rule.groupIds },
    };
  },
  fingerprint: async (input, inject) => fingerprintOf(await findPermission(inject, input.id)),
  preview: async (input, inject) => {
    await assertClaude(inject);
    const rule = await findPermission(inject, input.id);
    const newId = `${isLocalId(rule.id) ? LOCAL_ID_PREFIX : ''}${input.decision}:${input.pattern}`;
    if (newId !== rule.id) {
      const rules = await readRoute<PermissionRule[]>(inject, '/api/permissions');
      if (rules.some((item) => item.id === newId)) {
        throw new Error('The same rule already exists in this file: remove this one instead.');
      }
    }
    return stateCard(
      `${fileOfId(rule.id)}: permissions`,
      { decision: rule.decision, pattern: rule.pattern },
      { decision: input.decision, pattern: input.pattern },
      card('summary-edit-permission', { pattern: rule.pattern }),
    );
  },
  page: () => ({ route: '/permissions' }),
});

// --- MCP: связь и инструменты ---

async function findMcp(inject: InjectRoute, id: string): Promise<McpServer> {
  const servers = await readRoute<McpServer[]>(inject, '/api/mcp');
  const server = servers.find((item) => item.id === id);
  if (!server) throw new Error(`MCP server «${id}» not found. Call list_mcp_servers.`);
  return server;
}

/** Чем сервер запускается или где живёт — без значений env и заголовков. */
const mcpLaunch = (server: McpServer) =>
  maskSecretsInText(
    server.transport === 'stdio'
      ? [server.command ?? '', ...server.args].join(' ').trim()
      : (server.url ?? ''),
  );

const mcpFingerprint = async (input: { id: string }, inject: InjectRoute) => {
  const server = await findMcp(inject, input.id);
  return fingerprintOf({
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
  });
};

const mcpCard = async (
  input: { id: string },
  inject: InjectRoute,
  code: 'summary-check-mcp-health' | 'summary-list-mcp-tools',
) => {
  const server = await findMcp(inject, input.id);
  return {
    ...card(code, { name: server.name }),
    fields: [
      dataField('label-transport', server.transport),
      dataField(
        server.transport === 'stdio' ? 'label-command' : 'label-address',
        mcpLaunch(server),
      ),
      textField('label-what-happens', 'value-happens-mcp-spawn'),
    ],
  };
};

const checkMcpHealth = definePanelAction({
  name: 'check_mcp_health',
  section: 'mcp',
  risk: 'change',
  title: 'journal-check-mcp-health',
  description:
    'Check that an MCP server answers: the panel starts it (stdio) or calls its URL and speaks ' +
    'MCP; the result (connected / failed + detail) is saved and shown on the MCP page. A stdio ' +
    'server runs its own command, hence the confirmation.',
  input: z.object({ id: z.string().min(1).describe('Server id from list_mcp_servers') }),
  route: (input) => ({ method: 'POST', url: `/api/mcp/${encode(input.id)}/health` }),
  fingerprint: mcpFingerprint,
  preview: (input, inject) => mcpCard(input, inject, 'summary-check-mcp-health'),
  shape: (_input, body) => maskDeep(body),
  page: (input) => ({ route: '/mcp', focus: input.id }),
});

const listMcpTools = definePanelAction({
  name: 'list_mcp_tools',
  section: 'mcp',
  risk: 'change',
  title: 'journal-list-mcp-tools',
  description:
    'Ask an MCP server for its tools (names and descriptions) — e.g. to suggest permission rules ' +
    'per tool. Starts the server like check_mcp_health, hence the confirmation. Paged.',
  input: z.object({
    id: z.string().min(1).describe('Server id from list_mcp_servers'),
    offset: z.number().int().min(0).optional().describe(OFFSET_DESCRIPTION),
  }),
  route: (input) => ({ method: 'POST', url: `/api/mcp/${encode(input.id)}/tools` }),
  fingerprint: mcpFingerprint,
  preview: (input, inject) => mcpCard(input, inject, 'summary-list-mcp-tools'),
  shape: (input, body) => {
    const tools = Array.isArray(body)
      ? body
      : ((body as { tools?: unknown[] } | undefined)?.tools ?? []);
    if (!Array.isArray(tools)) return maskDeep(body);
    const page = listPage(tools, input.offset ?? 0, 100);
    const error = (body as { error?: unknown } | undefined)?.error;
    return maskDeep({ ...page.meta, tools: page.slice, ...(error ? { error } : {}) });
  },
});

// --- Файлы структуры скилла и заготовки ---

const skillFilesUrl = (skill: string) => `/api/resources/skill/${encode(skill)}/files`;
const skillFileUrl = (skill: string, file: string) =>
  `/api/resources/skill/${encode(skill)}/file?file=${encode(file)}`;

interface SkillFiles {
  files: Array<{ path: string; isBinary?: boolean; sizeBytes?: number }>;
  isWritable: boolean;
  entryFile?: string;
}

interface SkillFileText {
  content: string;
  isBinary: boolean;
  contentCode?: string;
}

interface SkillTemplate {
  id: string;
  title: string;
  description: string;
  fileCount: number;
  paths: string[];
}

const skillInput = z.string().min(1).describe('Skill id from list_skills');

/**
 * То же правило, что у маршрута (`safePath`): ни абсолютного пути, ни `..`, ни одних
 * точек. Проверка во входе, а не после клика: человек не должен одобрять карточку,
 * которую маршрут всё равно отвергнет.
 */
const insideSkillFolder = (path: string) =>
  !/^([a-zA-Z]:|[/\\])/.test(path) &&
  !path.includes('\0') &&
  !path.split(/[/\\]/).includes('..') &&
  !/^\.+$/.test(path.replace(/[/\\]/g, ''));

const fileInput = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    insideSkillFolder,
    'Must be a relative path inside the skill folder: no "..", no absolute path',
  )
  .describe('Path inside the skill folder, e.g. "references/api.md"');

const hasFile = (files: SkillFiles, path: string) =>
  files.files.some((file) => file.path.replaceAll('\\', '/') === path.replaceAll('\\', '/'));

async function skillFileText(inject: InjectRoute, skill: string, file: string) {
  const body = await readRoute<SkillFileText>(inject, skillFileUrl(skill, file));
  if (body.isBinary) throw new Error(`«${file}» is a binary file: it is not edited as text.`);
  if (body.contentCode) throw new Error(`«${file}» is too large to read as text.`);
  return body.content;
}

const listSkillTemplates = definePanelAction({
  name: 'list_skill_templates',
  section: 'skills',
  risk: 'read',
  description:
    'Structure templates for a skill folder (modules beside SKILL.md: references, scripts, ' +
    'config): id, title, what it is for, files it adds.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/resources/skill/templates' }),
  summary: 'journal-list-skill-templates',
});

const applySkillTemplate = definePanelAction({
  name: 'apply_skill_template',
  section: 'skills',
  risk: 'change',
  title: 'journal-apply-skill-template',
  description:
    'Add a structure template (id from list_skill_templates) to an existing skill: only files ' +
    'the skill does not have yet are created, existing ones are left alone. Needs confirmation.',
  input: z.object({ skill: skillInput, templateId: z.string().min(1) }),
  route: (input) => ({
    method: 'POST',
    url: `/api/resources/skill/${encode(input.skill)}/apply-template`,
    body: { templateId: input.templateId },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill))).files),
  preview: async (input, inject) => {
    await assertClaude(inject);
    await findSkill(inject, input.skill);
    const templates = await readRoute<SkillTemplate[]>(inject, '/api/resources/skill/templates');
    const template = templates.find((item) => item.id === input.templateId);
    if (!template) {
      throw new Error(`No skill template «${input.templateId}». Call list_skill_templates.`);
    }
    const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
    const missing = template.paths.filter((path) => !hasFile(files, path));
    if (missing.length === 0) {
      throw new Error('Nothing would change: the skill already has every file of this template.');
    }
    return {
      ...card('summary-apply-skill-template', { template: template.title, skill: input.skill }),
      fields: [
        dataField('label-template-files', missing.join('\n')),
        textField('label-what-happens', 'value-happens-template'),
      ],
    };
  },
  page: (input) => ({ route: '/skills', focus: input.skill }),
});

const listSkillFiles = definePanelAction({
  name: 'list_skill_files',
  section: 'skills',
  risk: 'read',
  description: 'Files inside a skill folder (SKILL.md and its modules), with sizes.',
  input: z.object({ skill: skillInput }),
  route: (input) => ({ method: 'GET', url: skillFilesUrl(input.skill) }),
  summary: 'journal-list-skill-files',
});

const readSkillFile = definePanelAction({
  name: 'read_skill_file',
  section: 'skills',
  risk: 'read',
  description:
    'Text of one file inside a skill folder, secrets masked. Long files come in windows: pass ' +
    'nextOffset as offset.',
  input: z.object({
    skill: skillInput,
    file: fileInput,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character offset: nextOffset of the previous window'),
  }),
  // Маршрут на отсутствующий файл отвечает пустым текстом — модель пересказала бы
  // его как пустой файл. Поэтому сначала опись: нет скилла или файла — отказ словами.
  route: async (input, inject) => {
    await findSkill(inject, input.skill);
    const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
    if (!hasFile(files, input.file)) {
      throw new Error(`«${input.file}» is not in skill «${input.skill}». Call list_skill_files.`);
    }
    return { method: 'GET', url: skillFileUrl(input.skill, input.file) };
  },
  shape: (input, body) => {
    const file = body as SkillFileText;
    if (file.isBinary) return { file: input.file, isBinary: true };
    return { file: input.file, ...textWindow(maskSecretsInText(file.content), input.offset ?? 0) };
  },
  summary: 'journal-read-skill-file',
});

async function skillFileRequest(
  input: { skill: string; file: string; content: string },
  inject: InjectRoute,
) {
  const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
  const exists = hasFile(files, input.file);
  const saved = exists ? await skillFileText(inject, input.skill, input.file) : undefined;
  return { exists, saved, content: unmasked(input.file, saved, input.content) };
}

const saveSkillFile = definePanelAction({
  name: 'save_skill_file',
  section: 'skills',
  risk: 'change',
  title: 'journal-save-skill-file',
  description:
    'Create or replace one file inside a skill folder (a module beside SKILL.md: a reference, a ' +
    'script, a config). Send the WHOLE new text; lines read with a mask stay exactly as read. ' +
    'Never put secrets into it. Needs confirmation; the card shows the diff.',
  input: z.object({ skill: skillInput, file: fileInput, content: z.string().max(200_000) }),
  route: async (input, inject) => {
    const request = await skillFileRequest(input, inject);
    return {
      method: 'PUT',
      url: `/api/resources/skill/${encode(input.skill)}/file`,
      body: { file: input.file, content: request.content },
    };
  },
  fingerprint: async (input, inject) => {
    const request = await skillFileRequest(input, inject);
    return fingerprintOf({ exists: request.exists, saved: request.saved ?? null });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    await findSkill(inject, input.skill);
    const request = await skillFileRequest(input, inject);
    if (literalSecrets({ content: input.content }).length > 0) {
      throw new Error(SECRET_REFUSAL);
    }
    if (request.saved === request.content) {
      throw new Error('Nothing would change: the file already has this text.');
    }
    const label = `skills/${input.skill}/${input.file}`;
    const diff = unifiedDiff(
      label,
      maskSecretsInText(request.saved ?? ''),
      maskSecretsInText(request.content),
    );
    return {
      ...card(
        request.exists ? 'summary-save-skill-file-update' : 'summary-save-skill-file-create',
        {
          file: input.file,
          skill: input.skill,
        },
      ),
      fields: [dataField(request.exists ? 'label-file' : 'label-new-file', label)],
      ...(diff.truncated
        ? {
            truncated: true,
            diff: `--- a/${label}\n+++ b/${label}\n(правка слишком велика для построчного диффа)`,
          }
        : { diff: diff.diff }),
    };
  },
  page: (input) => ({ route: '/skills', focus: input.skill }),
});

const deleteSkillFile = definePanelAction({
  name: 'delete_skill_file',
  section: 'skills',
  risk: 'danger',
  title: 'journal-delete-skill-file',
  description:
    'Delete one file (or sub-folder) inside a skill folder; a backup copy is kept. SKILL.md itself ' +
    'is not deleted this way — delete_skill removes the whole skill. Needs confirmation.',
  input: z.object({ skill: skillInput, file: fileInput }),
  route: (input) => ({ method: 'DELETE', url: skillFileUrl(input.skill, input.file) }),
  fingerprint: async (input, inject) => {
    const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
    return fingerprintOf(files.files.filter((file) => file.path.startsWith(input.file)));
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    await findSkill(inject, input.skill);
    if (input.file.replaceAll('\\', '/').toLowerCase() === 'skill.md') {
      throw new Error('SKILL.md is the skill itself: delete the whole skill with delete_skill.');
    }
    const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
    const inside = files.files.filter(
      (file) => file.path === input.file || file.path.startsWith(`${input.file}/`),
    );
    if (inside.length === 0) {
      throw new Error(`«${input.file}» is not in skill «${input.skill}». Call list_skill_files.`);
    }
    const label = `skills/${input.skill}/${input.file}`;
    return {
      ...card('summary-delete-skill-file', { file: input.file, skill: input.skill }),
      fields: [dataField('label-file', inside.map((file) => file.path).join('\n'))],
      ...(inside.length === 1 && !inside[0]!.isBinary
        ? {
            diff: unifiedDiff(
              label,
              maskSecretsInText(await skillFileText(inject, input.skill, input.file)),
              '',
            ).diff,
          }
        : {}),
    };
  },
  page: (input) => ({ route: '/skills', focus: input.skill }),
});

const moveSkillFile = definePanelAction({
  name: 'move_skill_file',
  section: 'skills',
  risk: 'change',
  title: 'journal-move-skill-file',
  description:
    'Rename or move a file inside a skill folder (e.g. "notes.md" → "references/notes.md"). An ' +
    'existing file at the target is never overwritten. Needs confirmation.',
  input: z.object({ skill: skillInput, from: fileInput, to: fileInput }),
  route: (input) => ({
    method: 'POST',
    url: `/api/resources/skill/${encode(input.skill)}/move`,
    body: { from: input.from, to: input.to },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill))).files),
  preview: async (input, inject) => {
    await assertClaude(inject);
    await findSkill(inject, input.skill);
    const files = await readRoute<SkillFiles>(inject, skillFilesUrl(input.skill));
    if (!hasFile(files, input.from)) {
      throw new Error(`«${input.from}» is not in skill «${input.skill}». Call list_skill_files.`);
    }
    if (hasFile(files, input.to)) {
      throw new Error(`«${input.to}» already exists in the skill: choose another name.`);
    }
    return {
      ...card('summary-move-skill-file', { from: input.from, to: input.to, skill: input.skill }),
      fields: [dataField('label-file', input.from), dataField('label-target-file', input.to)],
    };
  },
  page: (input) => ({ route: '/skills', focus: input.skill }),
});

export const ENTITY_EXTRA_ACTIONS: readonly AnyPanelAction[] = [
  renameSkill,
  moveHook,
  moveEnv,
  movePermission,
  editPermission,
  checkMcpHealth,
  listMcpTools,
  listSkillTemplates,
  applySkillTemplate,
  listSkillFiles,
  readSkillFile,
  saveSkillFile,
  deleteSkillFile,
  moveSkillFile,
];
