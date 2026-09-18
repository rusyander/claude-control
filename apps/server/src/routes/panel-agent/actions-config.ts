import { z } from 'zod';
import type {
  Hook,
  McpServer,
  McpServerDraft,
  PermissionRule,
  ProvidersResponse,
  Rule,
  Skill,
} from '@agentdeck/contracts';
import type { PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import type { ConfigPreviewRequest, ConfigPreviewResponse } from '../../domains/config-preview.ts';
import { maskSecretsInLine } from '../../domains/config-preview/unified-diff.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import {
  emptySecretFields,
  literalSecretPaths,
  maskArgs,
  maskMcpServer,
  permissionIdForModel,
  resolvePermissionId,
  storedSecretPaths,
} from './actions-config-secrets.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Действия раздела «Конфигурация» (А7): правила, скиллы, хуки, MCP, права —
 * живые файлы `~/.claude`, самая дорогая ошибка панели.
 *
 * Исполнение — маршруты, которые зовёт окно (`/api/rules`, `/api/skills`,
 * `/api/permissions`, `/api/mcp`, переключатель сущностей): те же проверки, та же
 * резервная копия перед записью. Карточка — дифф файла «было → станет» от
 * `/api/config-preview`, который выполняет ту же доменную операцию по копии
 * файла. Секреты модель не видит и не присылает (`actions-config-secrets.ts`).
 */

/** Тело правила в списке для модели — хвост обрезается, файл бывает большим. */
const RULE_BODY_MAX = 1500;

const encode = encodeURIComponent;

/** Ответ маршрута чтения или исключение с его текстом: действие без данных — отказ. */
async function readRoute<T>(inject: InjectRoute, url: string): Promise<T> {
  const answer = await inject({ method: 'GET', url });
  if (answer.status >= 400) {
    const message = (answer.body as { message?: string } | undefined)?.message;
    throw new Error(`${url} answered ${answer.status}${message ? `: ${message}` : ''}`);
  }
  return answer.body as T;
}

/**
 * Эти маршруты правят файлы Claude Code. При другом активном CLI человек смотрит
 * на ЕГО конфигурацию, а правка ушла бы в `~/.claude` — невидимо для него.
 */
export async function assertClaude(inject: InjectRoute): Promise<void> {
  const providers = await readRoute<ProvidersResponse>(inject, '/api/providers');
  if (providers.active !== 'claude') {
    throw new Error(
      `Configuration actions edit Claude Code files only; the active CLI is «${providers.active}».`,
    );
  }
}

/** Предпросмотр маршрутом; отказ маршрута — исключение с его текстом. */
async function requestPreview(
  inject: InjectRoute,
  request: ConfigPreviewRequest,
): Promise<ConfigPreviewResponse> {
  await assertClaude(inject);
  const answer = await inject({ method: 'POST', url: '/api/config-preview', body: request });
  if (answer.status >= 400) {
    const message = (answer.body as { message?: string } | undefined)?.message;
    throw new Error(message ?? `Preview answered ${answer.status}`);
  }
  return answer.body as ConfigPreviewResponse;
}

/**
 * Отпечаток карточки: исходное состояние файлов (его считает домен предпросмотра)
 * плюс сам запрос — черновик тоже собран из диска (включённость правила, слитые
 * поля MCP), и его сдвиг значит, что запишется не показанное.
 */
async function configFingerprint(inject: InjectRoute, request: ConfigPreviewRequest) {
  const preview = await requestPreview(inject, request);
  return fingerprintOf({ request, source: preview.fingerprint });
}

/** Карточка из предпросмотра: дифф по каждому файлу, заметки — полями. */
async function filePreview(
  inject: InjectRoute,
  request: ConfigPreviewRequest,
  summary: ReturnType<typeof summaryText>,
  fields: PanelActionPreview['fields'],
): Promise<PanelActionPreview> {
  const preview = await requestPreview(inject, request);
  const changed = preview.files.filter((file) => !file.unchanged);
  if (changed.length === 0 && preview.notes.length === 0) {
    throw new Error('Nothing would change: the file already matches the request.');
  }
  // Правка без построчного диффа — карточка не показывает, что запишется, и
  // одобрить её нельзя: маршрут решения отказывает по этому признаку.
  const truncated = changed.some((file) => file.truncated);

  return {
    ...(truncated ? { truncated: true } : {}),
    ...summary,
    fields: [
      ...fields,
      ...changed.map((file) =>
        dataField(
          file.exists ? 'label-file' : 'label-new-file',
          `${file.path} (+${file.added} −${file.removed})`,
        ),
      ),
      ...changed
        .filter((file) => file.reformatted)
        .map((file) => textField('label-file-shape', 'value-file-shape', { path: file.path })),
      ...preview.notes.map((note) => textField('label-besides-file', note.code, note.params)),
    ],
    ...(changed.length > 0
      ? {
          diff: changed
            .map((file) =>
              file.truncated
                ? `--- a/${file.path}\n+++ b/${file.path}\n(правка слишком велика для построчного диффа)`
                : file.diff,
            )
            .join('\n'),
        }
      : {}),
  };
}

// --- Чтение ---

const listRules = definePanelAction({
  name: 'list_rules',
  section: 'rules',
  risk: 'read',
  description: 'List rules of the global CLAUDE.md (id, title, enabled, body head).',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/rules' };
  },
  shape: (_input, body) => ({
    rules: (body as Rule[]).map((rule) => ({
      id: rule.id,
      title: rule.title,
      isEnabled: rule.isEnabled,
      groupIds: rule.groupIds,
      body: rule.body.slice(0, RULE_BODY_MAX).split('\n').map(maskSecretsInLine).join('\n'),
      ...(rule.body.length > RULE_BODY_MAX ? { bodyTruncated: true } : {}),
    })),
  }),
  summary: 'journal-list-rules',
});

const listSkills = definePanelAction({
  name: 'list_skills',
  section: 'skills',
  risk: 'read',
  description: 'List skills (id = folder name, name, description, enabled, extra files).',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/skills' };
  },
  shape: (_input, body) => ({
    skills: (body as Skill[]).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: maskSecretsInLine(skill.description),
      isEnabled: skill.isEnabled,
      files: skill.files,
      groupIds: skill.groupIds,
    })),
  }),
  summary: 'journal-list-skills',
});

const listHooks = definePanelAction({
  name: 'list_hooks',
  section: 'hooks',
  risk: 'read',
  description: 'List hooks from settings.json and settings.local.json (read only).',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/hooks' };
  },
  shape: (_input, body) => ({
    hooks: (body as Hook[]).map((hook) => ({
      id: hook.id,
      event: hook.event,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      command: maskSecretsInLine(hook.command),
      isEnabled: hook.isEnabled,
      source: hook.source,
      ...(hook.description ? { description: hook.description } : {}),
    })),
  }),
  summary: 'journal-list-hooks',
});

const listMcp = definePanelAction({
  name: 'list_mcp',
  section: 'mcp',
  risk: 'read',
  description:
    'List MCP servers of ~/.claude.json. Secret values are masked (••••••); ${VAR} references stay.',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/mcp' };
  },
  shape: (_input, body) => ({ servers: (body as McpServer[]).map(maskMcpServer) }),
  summary: 'journal-list-mcp',
});

const listPermissions = definePanelAction({
  name: 'list_permissions',
  section: 'permissions',
  risk: 'read',
  description:
    'List permission rules (id, decision, pattern, source file, enabled). Ids with "local:" live in settings.local.json.',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/permissions' };
  },
  shape: (_input, body) => ({
    permissions: (body as PermissionRule[]).map((rule) => ({
      id: permissionIdForModel(rule.id, fingerprintOf),
      decision: rule.decision,
      pattern: maskSecretsInLine(rule.pattern),
      source: rule.source,
      isEnabled: rule.isEnabled,
    })),
  }),
  summary: 'journal-list-permissions',
});

// --- Правила ---

const ruleInput = z.object({
  id: z.string().min(1).optional().describe('Existing rule id from list_rules; omit to create'),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).describe('Rule text in markdown'),
});

/**
 * Черновик правила. Правка сохраняет включённость и группы правила — их модель
 * меняет не здесь (включённость — `toggle_rule`), иначе правка текста молча
 * переносила бы правило в раздел выключенных.
 */
/**
 * Правило по id — ради заголовка в карточке: id — это слаг заголовка
 * («vsegda-otvechat-po-russki»), и человек узнаёт правило по словам, а не по нему.
 */
async function findRule(inject: InjectRoute, id: string): Promise<Rule> {
  const rule = (await readRoute<Rule[]>(inject, '/api/rules')).find((item) => item.id === id);
  if (!rule) throw new Error(`Rule «${id}» not found. Call list_rules.`);
  return rule;
}

async function ruleDraft(input: z.infer<typeof ruleInput>, inject: InjectRoute) {
  if (input.id === undefined) {
    return { title: input.title, body: input.body, isEnabled: true, groupIds: [] as string[] };
  }
  const rule = (await readRoute<Rule[]>(inject, '/api/rules')).find((item) => item.id === input.id);
  if (!rule) throw new Error(`Rule «${input.id}» not found. Call list_rules.`);
  return {
    title: input.title,
    body: input.body,
    isEnabled: rule.isEnabled,
    groupIds: rule.groupIds,
  };
}

const saveRule = definePanelAction({
  name: 'save_rule',
  section: 'rules',
  risk: 'change',
  title: 'journal-save-rule',
  description:
    'Create a rule in the global CLAUDE.md, or replace title/body of an existing one (by id). Needs confirmation; the card shows the file diff.',
  input: ruleInput,
  route: async (input, inject) => {
    await assertClaude(inject);
    const body = await ruleDraft(input, inject);
    return input.id === undefined
      ? { method: 'POST', url: '/api/rules', body }
      : { method: 'PUT', url: `/api/rules/${encode(input.id)}`, body };
  },
  fingerprint: async (input, inject) =>
    configFingerprint(inject, {
      kind: 'rule',
      action: 'save',
      id: input.id,
      draft: await ruleDraft(input, inject),
    }),
  preview: async (input, inject) =>
    filePreview(
      inject,
      { kind: 'rule', action: 'save', id: input.id, draft: await ruleDraft(input, inject) },
      input.id === undefined
        ? summaryText('summary-rule-add', { title: input.title })
        : summaryText('summary-rule-edit', { title: (await findRule(inject, input.id)).title }),
      [
        dataField('label-rule-title', input.title),
        ...(input.id === undefined ? [] : [dataField('label-id', input.id)]),
      ],
    ),
  page: (input) => ({ route: '/rules', ...(input.id ? { focus: input.id } : {}) }),
});

const toggleRule = definePanelAction({
  name: 'toggle_rule',
  section: 'rules',
  risk: 'change',
  title: 'journal-toggle-rule',
  description:
    'Enable or disable a rule (a disabled rule moves to the service section of CLAUDE.md). Needs confirmation.',
  input: z.object({ id: z.string().min(1), isEnabled: z.boolean() }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return {
      method: 'POST',
      url: `/api/entities/rule/${encode(input.id)}/enabled`,
      body: { isEnabled: input.isEnabled },
    };
  },
  fingerprint: (input, inject) =>
    configFingerprint(inject, {
      kind: 'rule',
      action: 'toggle',
      id: input.id,
      isEnabled: input.isEnabled,
    }),
  preview: async (input, inject) =>
    filePreview(
      inject,
      { kind: 'rule', action: 'toggle', id: input.id, isEnabled: input.isEnabled },
      summaryText(input.isEnabled ? 'summary-rule-enable' : 'summary-rule-disable', {
        title: (await findRule(inject, input.id)).title,
      }),
      [dataField('label-id', input.id)],
    ),
  page: (input) => ({ route: '/rules', focus: input.id }),
});

const deleteRule = definePanelAction({
  name: 'delete_rule',
  section: 'rules',
  risk: 'danger',
  title: 'journal-delete-rule',
  description:
    'Delete a rule from CLAUDE.md (a backup copy is kept in History). Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'DELETE', url: `/api/rules/${encode(input.id)}` };
  },
  fingerprint: (input, inject) =>
    configFingerprint(inject, { kind: 'rule', action: 'delete', id: input.id }),
  preview: async (input, inject) =>
    filePreview(
      inject,
      { kind: 'rule', action: 'delete', id: input.id },
      summaryText('summary-rule-delete', { title: (await findRule(inject, input.id)).title }),
      [dataField('label-id', input.id)],
    ),
  page: () => ({ route: '/rules' }),
});

// --- Скиллы ---

const skillInput = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe('Existing skill id (folder) from list_skills; omit to create'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  body: z
    .string()
    .max(100_000)
    .optional()
    .describe('SKILL.md body without frontmatter; omit on edit to keep the current body'),
});

/** Правка без тела сохраняет нынешнее: пустое тело `saveSkill` заменил бы каркасом. */
async function skillDraft(input: z.infer<typeof skillInput>, inject: InjectRoute) {
  if (input.id === undefined) {
    return {
      name: input.name,
      description: input.description,
      body: input.body ?? '',
      groupIds: [] as string[],
    };
  }
  const skill = (await readRoute<Skill[]>(inject, '/api/skills')).find(
    (item) => item.id === input.id,
  );
  if (!skill) throw new Error(`Skill «${input.id}» not found. Call list_skills.`);
  return {
    name: input.name,
    description: input.description,
    body: input.body ?? skill.body,
    groupIds: skill.groupIds,
  };
}

const saveSkill = definePanelAction({
  name: 'save_skill',
  section: 'skills',
  risk: 'change',
  title: 'journal-save-skill',
  description:
    'Create a skill (folder from the name) or edit name/description/body of an existing one. Needs confirmation; the card shows the SKILL.md diff.',
  input: skillInput,
  route: async (input, inject) => {
    await assertClaude(inject);
    const body = await skillDraft(input, inject);
    return input.id === undefined
      ? { method: 'POST', url: '/api/skills', body }
      : { method: 'PUT', url: `/api/skills/${encode(input.id)}`, body };
  },
  fingerprint: async (input, inject) =>
    configFingerprint(inject, {
      kind: 'skill',
      action: 'save',
      id: input.id,
      draft: await skillDraft(input, inject),
    }),
  preview: async (input, inject) =>
    filePreview(
      inject,
      { kind: 'skill', action: 'save', id: input.id, draft: await skillDraft(input, inject) },
      input.id === undefined
        ? summaryText('summary-skill-create', { name: input.name })
        : summaryText('summary-skill-edit', { name: input.id }),
      [dataField('label-skill-name', input.name)],
    ),
  page: (input) => ({ route: '/skills', ...(input.id ? { focus: input.id } : {}) }),
});

const deleteSkill = definePanelAction({
  name: 'delete_skill',
  section: 'skills',
  risk: 'danger',
  title: 'journal-delete-skill',
  description: 'Delete a skill folder entirely (backup kept in History). Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'DELETE', url: `/api/skills/${encode(input.id)}` };
  },
  fingerprint: (input, inject) =>
    configFingerprint(inject, { kind: 'skill', action: 'delete', id: input.id }),
  preview: (input, inject) =>
    filePreview(
      inject,
      { kind: 'skill', action: 'delete', id: input.id },
      summaryText('summary-skill-delete', { name: input.id }),
      [],
    ),
  page: () => ({ route: '/skills' }),
});

// --- Права ---

const addPermissionRule = definePanelAction({
  name: 'add_permission_rule',
  section: 'permissions',
  risk: 'change',
  title: 'journal-add-permission',
  description:
    'Add a permission rule to settings.json, e.g. decision "allow", pattern "Bash(git status:*)". Needs confirmation.',
  input: z.object({
    decision: z.enum(['allow', 'ask', 'deny']),
    pattern: z.string().trim().min(1).max(500),
  }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'POST', url: '/api/permissions', body: { ...input, groupIds: [] } };
  },
  fingerprint: (input, inject) =>
    configFingerprint(inject, {
      kind: 'permission',
      action: 'add',
      draft: { ...input, groupIds: [] },
    }),
  preview: (input, inject) =>
    filePreview(
      inject,
      { kind: 'permission', action: 'add', draft: { ...input, groupIds: [] } },
      summaryText('summary-permission-add', {
        decision: input.decision,
        pattern: input.pattern,
      }),
      [],
    ),
  page: () => ({ route: '/permissions' }),
});

/** Id из `list_permissions` (возможно, непрозрачный) → настоящий id права. */
export async function permissionId(sent: string, inject: InjectRoute): Promise<string> {
  const rules = await readRoute<PermissionRule[]>(inject, '/api/permissions');
  const id = resolvePermissionId(
    sent,
    rules.map((rule) => rule.id),
    fingerprintOf,
  );
  if (id === undefined)
    throw new Error(`Permission rule «${sent}» not found. Call list_permissions.`);
  return id;
}

const removePermissionRule = definePanelAction({
  name: 'remove_permission_rule',
  section: 'permissions',
  risk: 'danger',
  title: 'journal-remove-permission',
  description: 'Remove a permission rule by id from list_permissions. Needs confirmation.',
  input: z.object({ id: z.string().min(1).describe('Rule id, e.g. "allow:Bash(ls:*)"') }),
  route: async (input, inject) => {
    await assertClaude(inject);
    const id = await permissionId(input.id, inject);
    return { method: 'DELETE', url: `/api/permissions/${encode(id)}` };
  },
  fingerprint: async (input, inject) =>
    configFingerprint(inject, {
      kind: 'permission',
      action: 'delete',
      id: await permissionId(input.id, inject),
    }),
  preview: async (input, inject) =>
    filePreview(
      inject,
      { kind: 'permission', action: 'delete', id: await permissionId(input.id, inject) },
      summaryText('summary-permission-remove', {
        rule: maskSecretsInLine(await permissionId(input.id, inject)),
      }),
      [],
    ),
  page: () => ({ route: '/permissions' }),
});

// --- MCP ---

const record = z.record(z.string(), z.string());
const mcpInput = z
  .object({
    id: z.string().min(1).optional().describe('Current server name when editing; omit to create'),
    name: z.string().trim().min(1).max(100),
    transport: z.enum(['stdio', 'sse', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional().describe('Omit on edit to keep current args'),
    url: z.string().optional(),
    env: record
      .optional()
      .describe('Secret-named keys: value "" or ${VAR}; the human fills secrets. Omit to keep'),
    headers: record.optional().describe('Same rule as env for Authorization-like headers'),
  })
  .superRefine((input, context) => {
    for (const path of literalSecretPaths(input)) {
      context.addIssue({
        code: 'custom',
        path: path.split('.'),
        message:
          'Secret values are never accepted from the agent: leave it "" (the human enters it on the MCP page) or use a ${VAR} reference.',
      });
    }
  });

type McpInput = z.infer<typeof mcpInput>;

/**
 * Черновик сервера. У правки всё, что модель не прислала, берётся из нынешней
 * записи, а пустое значение секретного ключа НЕ затирает сохранённый секрет:
 * модель видит его замаскированным и прислать настоящий не может.
 */
async function mcpDraft(input: McpInput, inject: InjectRoute): Promise<McpServerDraft> {
  const current =
    input.id === undefined
      ? undefined
      : (await readRoute<McpServer[]>(inject, '/api/mcp')).find((item) => item.id === input.id);
  if (input.id !== undefined && !current) {
    throw new Error(`MCP server «${input.id}» not found. Call list_mcp.`);
  }
  if (current) assertNotRetargeted(input, current);
  const keep = (
    next: Record<string, string> | undefined,
    saved: Record<string, string> = {},
  ): Record<string, string> =>
    next === undefined
      ? saved
      : Object.fromEntries(
          Object.entries(next).map(([key, value]) => [
            key,
            value.trim() === '' && saved[key] ? saved[key] : value,
          ]),
        );
  return {
    name: input.name,
    transport: input.transport,
    command: input.command ?? current?.command,
    args: input.args ?? current?.args ?? [],
    url: input.url ?? current?.url,
    env: keep(input.env, current?.env),
    headers: keep(input.headers, current?.headers),
    groupIds: current?.groupIds ?? [],
  };
}

/**
 * Смена адреса или команды сервера, у которого УЖЕ лежат секреты (заголовки,
 * env, вход OAuth), — отказ до карточки и ещё раз перед записью (черновик
 * пересчитывается маршрутом). Иначе одна подтверждённая строка «Адрес»
 * отправила бы живой Bearer или вход OAuth туда, куда указала модель: в диффе
 * секрет стоит замаскированным и «без изменений», и ничто на карточке не
 * говорит, что его теперь получит другой хост. То же правило, что у контура
 * (`actions-contour.ts → planDraft`).
 */
function assertNotRetargeted(input: McpInput, current: McpServer): void {
  const secrets = storedSecretPaths(current);
  if (secrets.length === 0) return;
  const moved = [
    input.transport !== current.transport ? 'transport' : '',
    input.url !== undefined && input.url !== (current.url ?? '') ? 'url' : '',
    input.command !== undefined && input.command !== (current.command ?? '') ? 'command' : '',
    input.args !== undefined && JSON.stringify(input.args) !== JSON.stringify(current.args)
      ? 'args'
      : '',
  ].filter(Boolean);
  if (moved.length === 0) return;
  throw new Error(
    `MCP server "${current.name}" has stored secrets (${secrets.join(', ')}); changing its ` +
      `${moved.join('/')} through the agent is refused, because they would be sent to the new target. ` +
      'The human changes it on the MCP page, or create a new server with another name.',
  );
}

/**
 * Какой черновик ушёл в запись — для шага секрета: он синхронный и видит только
 * вход, а пустые секреты решаются по слитому с диском черновику.
 */
const writtenDrafts = new WeakMap<object, McpServerDraft>();

/**
 * Якорь пустого секрета в форме правки MCP-сервера: окно открывает форму этого
 * сервера (`/mcp?id=<имя>&tab=secret`) и ведёт фокус в поле значения. Имя
 * повторяет `MCP_SECRET_PREFIX` окна (`entities/PanelAgent/model/pageTarget.ts`).
 */
export function mcpSecretAnchor(name: string): string {
  return `mcp-secret:${name}`;
}

const saveMcpServer = definePanelAction({
  name: 'save_mcp_server',
  section: 'mcp',
  risk: 'change',
  title: 'journal-save-mcp',
  description:
    'Create or edit an MCP server in ~/.claude.json. Never send secret values: leave secret env/header values "" and the human enters them. Needs confirmation.',
  input: mcpInput,
  route: async (input, inject) => {
    await assertClaude(inject);
    const body = await mcpDraft(input, inject);
    writtenDrafts.set(input, body);
    return input.id === undefined
      ? { method: 'POST', url: '/api/mcp', body }
      : { method: 'PUT', url: `/api/mcp/${encode(input.id)}`, body };
  },
  fingerprint: async (input, inject) =>
    configFingerprint(inject, {
      kind: 'mcp',
      action: 'save',
      id: input.id,
      draft: await mcpDraft(input, inject),
    }),
  preview: async (input, inject) => {
    const draft = await mcpDraft(input, inject);
    const waiting = emptySecretFields(draft);
    return filePreview(
      inject,
      { kind: 'mcp', action: 'save', id: input.id, draft },
      input.id === undefined
        ? summaryText('summary-mcp-add', { name: input.name })
        : summaryText('summary-mcp-edit', { name: input.id }),
      [
        dataField('label-transport', input.transport),
        ...(draft.command
          ? [dataField('label-command', [draft.command, ...maskArgs(draft.args)].join(' '))]
          : []),
        ...(draft.url ? [dataField('label-address', maskSecretsInLine(draft.url))] : []),
        ...(waiting.length > 0 ? [dataField('label-secrets-by-you', waiting.join(', '))] : []),
      ],
    );
  },
  shape: (input) => ({ saved: input.name }),
  secretStep: (input) => {
    const draft = writtenDrafts.get(input as object);
    return draft && emptySecretFields(draft).length > 0
      ? { route: '/mcp', focus: mcpSecretAnchor(draft.name) }
      : undefined;
  },
  page: (input) => ({ route: '/mcp', focus: input.name }),
});

const deleteMcpServer = definePanelAction({
  name: 'delete_mcp_server',
  section: 'mcp',
  risk: 'danger',
  title: 'journal-delete-mcp',
  description:
    'Delete an MCP server from ~/.claude.json together with its saved OAuth login. Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'DELETE', url: `/api/mcp/${encode(input.id)}` };
  },
  fingerprint: (input, inject) =>
    configFingerprint(inject, { kind: 'mcp', action: 'delete', id: input.id }),
  preview: (input, inject) =>
    filePreview(
      inject,
      { kind: 'mcp', action: 'delete', id: input.id },
      summaryText('summary-mcp-delete', { name: input.id }),
      [],
    ),
  page: () => ({ route: '/mcp' }),
});

/** Действия «Конфигурация» в порядке показа: чтение, затем правки по разделам. */
export const CONFIG_ACTIONS: readonly AnyPanelAction[] = [
  listRules,
  listSkills,
  listHooks,
  listMcp,
  listPermissions,
  saveRule,
  toggleRule,
  deleteRule,
  saveSkill,
  deleteSkill,
  addPermissionRule,
  removePermissionRule,
  saveMcpServer,
  deleteMcpServer,
];
