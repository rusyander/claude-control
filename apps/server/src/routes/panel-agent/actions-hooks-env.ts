import { z } from 'zod';
import type { CommandsResponse, EnvVar, Hook } from '@agentdeck/contracts';
import type { ConfigPreviewRequest } from '../../domains/config-preview.ts';
import { isSecretName, maskSecretsInText } from '../../lib/secret-mask.ts';
import { definePanelAction, type AnyPanelAction, type InjectRoute } from './registry.ts';
import { assertClaude, permissionId } from './actions-config.ts';
import {
  card,
  encode,
  fileCard,
  fileFingerprint,
  literalSecrets,
  maskDeep,
  readRoute,
  SECRET_REFUSAL,
  textWindow,
} from './action-kit.ts';
import { dataField } from './texts.ts';

/**
 * Действия волны A по файлам Claude Code: хуки, переменные окружения, файл
 * глобальных инструкций, скрипты, команды и переключатели скилла / MCP / права.
 *
 * Исполнение — маршруты окна (`/api/hooks`, `/api/env`, `/api/claude-md`,
 * `/api/scripts`, `/api/entities/:kind/:id/enabled`). Карточка — дифф файла от
 * `/api/config-preview`, где та же доменная операция выполнена по копиям.
 */

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
] as const;

// --- Хуки ---

const hookInput = z.object({
  id: z.string().min(1).optional().describe('Existing hook id from list_hooks; omit to add'),
  event: z.enum(HOOK_EVENTS),
  matchers: z
    .array(z.string().trim().min(1))
    .default([])
    .describe('Tool names the hook filters on, e.g. ["Bash"]; empty = every tool'),
  command: z.string().trim().min(1).max(4000).describe('Shell command the hook runs'),
  timeout: z.number().int().positive().max(3600).optional().describe('Seconds'),
});

/** Хук по id — правка сохраняет включённость и группы: их меняют не здесь. */
async function findHook(inject: InjectRoute, id: string): Promise<Hook> {
  const hook = (await readRoute<Hook[]>(inject, '/api/hooks')).find(
    (item) => item.id === id || item.legacyId === id,
  );
  if (!hook) throw new Error(`Hook «${id}» not found. Call list_hooks.`);
  return hook;
}

async function hookRequest(
  input: z.infer<typeof hookInput>,
  inject: InjectRoute,
): Promise<Extract<ConfigPreviewRequest, { kind: 'hook'; action: 'save' }>> {
  await assertClaude(inject);
  const secrets = literalSecrets({ command: input.command });
  if (secrets.length > 0) throw new Error(`command: ${SECRET_REFUSAL} Use a \${VAR} reference.`);
  const current = input.id === undefined ? undefined : await findHook(inject, input.id);
  return {
    kind: 'hook',
    action: 'save',
    ...(current ? { id: current.id } : {}),
    draft: {
      event: input.event,
      matchers: input.matchers,
      command: input.command,
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      isEnabled: current?.isEnabled ?? true,
      groupIds: current?.groupIds ?? [],
      guardPatterns: [],
    },
  };
}

const saveHook = definePanelAction({
  name: 'save_hook',
  section: 'hooks',
  risk: 'change',
  title: 'journal-save-hook',
  description:
    'Add a hook to settings.json, or edit an existing one by id (event, matchers, command). ' +
    'Never put secrets into the command. Needs confirmation; the card shows the settings.json diff.',
  input: hookInput,
  route: async (input, inject) => {
    const request = await hookRequest(input, inject);
    return request.id === undefined
      ? { method: 'POST', url: '/api/hooks', body: request.draft }
      : { method: 'PUT', url: `/api/hooks/${encode(request.id)}`, body: request.draft };
  },
  fingerprint: async (input, inject) => fileFingerprint(inject, await hookRequest(input, inject)),
  preview: async (input, inject) =>
    fileCard(
      inject,
      await hookRequest(input, inject),
      card(input.id === undefined ? 'summary-hook-add' : 'summary-hook-edit', {
        event: input.event,
      }),
      [
        dataField('label-command', maskSecretsInText(input.command)),
        ...(input.matchers.length > 0
          ? [dataField('label-matchers', input.matchers.join(' | '))]
          : []),
      ],
    ),
  page: (input) => ({ route: '/hooks', ...(input.id ? { focus: input.id } : {}) }),
});

const toggleHook = definePanelAction({
  name: 'toggle_hook',
  section: 'hooks',
  risk: 'change',
  title: 'journal-toggle-hook',
  description:
    'Enable or disable a hook by id (a disabled hook is kept by the panel). Needs confirmation.',
  input: z.object({ id: z.string().min(1), isEnabled: z.boolean() }),
  route: async (input, inject) => {
    await assertClaude(inject);
    const hook = await findHook(inject, input.id);
    return {
      method: 'POST',
      url: `/api/entities/hook/${encode(hook.id)}/enabled`,
      body: { isEnabled: input.isEnabled },
    };
  },
  fingerprint: async (input, inject) => {
    await assertClaude(inject);
    return fileFingerprint(inject, {
      kind: 'hook',
      action: 'toggle',
      id: input.id,
      isEnabled: input.isEnabled,
    });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    const hook = await findHook(inject, input.id);
    return fileCard(
      inject,
      { kind: 'hook', action: 'toggle', id: hook.id, isEnabled: input.isEnabled },
      card(input.isEnabled ? 'summary-hook-enable' : 'summary-hook-disable', { event: hook.event }),
      [dataField('label-command', maskSecretsInText(hook.command))],
    );
  },
  page: (input) => ({ route: '/hooks', focus: input.id }),
});

const deleteHook = definePanelAction({
  name: 'delete_hook',
  section: 'hooks',
  risk: 'danger',
  title: 'journal-delete-hook',
  description: 'Delete a hook by id (a backup copy of settings.json is kept). Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    const hook = await findHook(inject, input.id);
    return { method: 'DELETE', url: `/api/hooks/${encode(hook.id)}` };
  },
  fingerprint: async (input, inject) => {
    await assertClaude(inject);
    return fileFingerprint(inject, { kind: 'hook', action: 'delete', id: input.id });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    const hook = await findHook(inject, input.id);
    return fileCard(
      inject,
      { kind: 'hook', action: 'delete', id: hook.id },
      card('summary-hook-delete', { event: hook.event }),
      [dataField('label-command', maskSecretsInText(hook.command))],
    );
  },
  page: () => ({ route: '/hooks' }),
});

// --- Переменные окружения ---

const listEnv = definePanelAction({
  name: 'list_env',
  section: 'env',
  risk: 'read',
  description:
    'List environment variables of settings.json, settings.local.json and .mcp-secrets.env. Secret values are masked.',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/env' };
  },
  shape: (_input, body) => ({
    variables: (body as EnvVar[]).map((item) => ({
      key: item.key,
      source: item.source,
      isSecret: item.isSecret,
      value: maskDeep(item.isSecret ? '••••••' : item.value, item.key),
      ...(item.groupId ? { groupId: item.groupId } : {}),
    })),
  }),
  summary: 'journal-list-env',
});

const ENV_SOURCES = ['settings', 'settings-local', 'secrets'] as const;

const envInput = z.object({
  key: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe('Variable name, e.g. MY_FLAG'),
  value: z
    .string()
    .max(4000)
    .default('')
    .describe('Plain value. Secrets: leave "" — the human enters the value on the Env page'),
  source: z.enum(ENV_SOURCES).default('settings'),
});

/**
 * Секрет — это имя-секрет или файл секретов. Значение такого ключа агент не
 * присылает и не затирает: существующий секрет меняет только человек.
 */
async function envRequest(input: z.infer<typeof envInput>, inject: InjectRoute) {
  await assertClaude(inject);
  const secret = input.source === 'secrets' || isSecretName(input.key);
  if (secret && input.value !== '') throw new Error(`value: ${SECRET_REFUSAL}`);
  if (!secret && literalSecrets({ value: input.value }).length > 0) {
    throw new Error(`value: ${SECRET_REFUSAL}`);
  }
  if (secret) {
    const existing = (await readRoute<EnvVar[]>(inject, '/api/env')).find(
      (item) => item.key === input.key && item.source === input.source,
    );
    if (existing) {
      throw new Error(
        `${input.key} already holds a secret in ${input.source}; the human changes it on the Env page.`,
      );
    }
  }
  const request: ConfigPreviewRequest = {
    kind: 'env',
    action: 'save',
    draft: { key: input.key, value: input.value, source: input.source, isSecret: secret },
  };
  return { request, secret };
}

/** Якорь поля значения переменной на странице env — его ведёт окно. */
export function envSecretAnchor(key: string): string {
  return `env-secret:${key}`;
}

const setEnv = definePanelAction({
  name: 'set_env',
  section: 'env',
  risk: 'change',
  title: 'journal-set-env',
  description:
    'Create or change an environment variable. For a secret (token, key, password, or source "secrets") ' +
    'send value "" — after saving, the value field opens for the human. Needs confirmation.',
  input: envInput,
  route: async (input, inject) => {
    const { request } = await envRequest(input, inject);
    return { method: 'POST', url: '/api/env', body: (request as { draft: unknown }).draft };
  },
  fingerprint: async (input, inject) =>
    fileFingerprint(inject, (await envRequest(input, inject)).request),
  preview: async (input, inject) => {
    const { request, secret } = await envRequest(input, inject);
    return fileCard(
      inject,
      request,
      card('summary-env-set', { key: input.key, source: input.source }),
      [...(secret ? [dataField('label-secrets-by-you', input.key)] : [])],
    );
  },
  shape: (input) => ({ saved: input.key, source: input.source }),
  secretStep: (input) =>
    input.source === 'secrets' || isSecretName(input.key)
      ? { route: '/env', focus: envSecretAnchor(input.key) }
      : undefined,
  page: (input) => ({ route: '/env', focus: input.key }),
});

const deleteEnv = definePanelAction({
  name: 'delete_env',
  section: 'env',
  risk: 'danger',
  title: 'journal-delete-env',
  description:
    'Delete an environment variable by key and source (backup kept). Needs confirmation.',
  input: z.object({ key: z.string().min(1), source: z.enum(ENV_SOURCES) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return {
      method: 'DELETE',
      url: `/api/env?key=${encode(input.key)}&source=${encode(input.source)}`,
    };
  },
  fingerprint: async (input, inject) => {
    await assertClaude(inject);
    return fileFingerprint(inject, { kind: 'env', action: 'delete', ...input });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    return fileCard(
      inject,
      { kind: 'env', action: 'delete', ...input },
      card('summary-env-delete', { key: input.key, source: input.source }),
    );
  },
  page: () => ({ route: '/env' }),
});

// --- Глобальные инструкции ---

const readClaudeMd = definePanelAction({
  name: 'read_claude_md',
  section: 'claude-md',
  risk: 'read',
  description:
    'Read the global instructions file of the active CLI (CLAUDE.md for Claude) in windows of 20000 chars; ' +
    'pass nextOffset to continue. Secret values are masked.',
  input: z.object({ offset: z.number().int().nonnegative().default(0) }),
  route: () => ({ method: 'GET', url: '/api/claude-md' }),
  shape: (input, body) => {
    const info = body as { content: string; filePath: string; exists: boolean };
    return {
      filePath: info.filePath,
      exists: info.exists,
      ...textWindow(maskSecretsInText(info.content), input.offset),
    };
  },
  summary: 'journal-read-claude-md',
});

const saveClaudeMd = definePanelAction({
  name: 'save_claude_md',
  section: 'claude-md',
  risk: 'danger',
  title: 'journal-save-claude-md',
  description:
    'Replace the WHOLE global instructions file with `content`. Read it first and send the full new text; ' +
    'for one rule prefer save_rule. Needs confirmation; the card shows the diff.',
  input: z.object({ content: z.string().max(400_000) }),
  route: async (input) => {
    if (literalSecrets({ content: input.content }).length > 0)
      throw new Error(`content: ${SECRET_REFUSAL}`);
    return { method: 'PUT', url: '/api/claude-md', body: { content: input.content } };
  },
  fingerprint: (input, inject) =>
    fileFingerprint(inject, { kind: 'instructions', action: 'save', content: input.content }),
  preview: (input, inject) => {
    if (literalSecrets({ content: input.content }).length > 0)
      throw new Error(`content: ${SECRET_REFUSAL}`);
    return fileCard(
      inject,
      { kind: 'instructions', action: 'save', content: input.content },
      card('summary-claude-md-save'),
    );
  },
  page: () => ({ route: '/claude-md' }),
});

// --- Скрипты и команды ---

const listScripts = definePanelAction({
  name: 'list_scripts',
  section: 'scripts',
  risk: 'read',
  description: 'List scripts under the hooks/ folder (id = relative path, used by a hook or not).',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/scripts' };
  },
  shape: (_input, body) => ({
    scripts: (body as Array<Record<string, unknown>>).map((item) => ({
      id: item.id,
      description: item.description,
      isUsed: item.isUsed,
      sizeBytes: item.sizeBytes,
    })),
  }),
  summary: 'journal-list-scripts',
});

const readScript = definePanelAction({
  name: 'read_script',
  section: 'scripts',
  risk: 'read',
  description: 'Read a script by id from list_scripts (secret values masked).',
  input: z.object({ id: z.string().min(1), offset: z.number().int().nonnegative().default(0) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: `/api/scripts/${input.id.split('/').map(encode).join('/')}` };
  },
  shape: (input, body) => ({
    id: input.id,
    ...textWindow(maskSecretsInText((body as { content: string }).content), input.offset),
  }),
  summary: 'journal-read-script',
});

const scriptUrl = (id: string): string => `/api/scripts/${id.split('/').map(encode).join('/')}`;

async function scriptRequest(
  input: { id: string; content: string },
  inject: InjectRoute,
): Promise<Extract<ConfigPreviewRequest, { kind: 'script' }> & { content: string }> {
  await assertClaude(inject);
  if (literalSecrets({ content: input.content }).length > 0)
    throw new Error(`content: ${SECRET_REFUSAL}`);
  const exists = (await readRoute<Array<{ id: string }>>(inject, '/api/scripts')).some(
    (item) => item.id === input.id,
  );
  return {
    kind: 'script',
    action: exists ? 'save' : 'create',
    id: input.id,
    content: input.content,
  };
}

const saveScript = definePanelAction({
  name: 'save_script',
  section: 'scripts',
  risk: 'change',
  title: 'journal-save-script',
  description:
    'Create a script under hooks/ (id like "guard.mjs" or "sub/check.sh") or replace an existing one. ' +
    'Never put secrets into it. Needs confirmation; the card shows the diff.',
  input: z.object({ id: z.string().min(1).max(200), content: z.string().max(200_000) }),
  route: async (input, inject) => {
    const request = await scriptRequest(input, inject);
    return request.action === 'create'
      ? { method: 'POST', url: '/api/scripts', body: { name: input.id, content: input.content } }
      : { method: 'PUT', url: scriptUrl(input.id), body: { content: input.content } };
  },
  fingerprint: async (input, inject) => fileFingerprint(inject, await scriptRequest(input, inject)),
  preview: async (input, inject) => {
    const request = await scriptRequest(input, inject);
    return fileCard(
      inject,
      request,
      card(request.action === 'create' ? 'summary-script-create' : 'summary-script-edit', {
        id: input.id,
      }),
    );
  },
  page: (input) => ({ route: '/scripts', focus: input.id }),
});

const deleteScript = definePanelAction({
  name: 'delete_script',
  section: 'scripts',
  risk: 'danger',
  title: 'journal-delete-script',
  description:
    'Delete a script file by id (backup kept). A hook calling it will fail. Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => {
    await assertClaude(inject);
    return { method: 'DELETE', url: scriptUrl(input.id) };
  },
  fingerprint: async (input, inject) => {
    await assertClaude(inject);
    return fileFingerprint(inject, { kind: 'script', action: 'delete', id: input.id });
  },
  preview: async (input, inject) => {
    await assertClaude(inject);
    return fileCard(
      inject,
      { kind: 'script', action: 'delete', id: input.id },
      card('summary-script-delete', { id: input.id }),
    );
  },
  page: () => ({ route: '/scripts' }),
});

const listCommands = definePanelAction({
  name: 'list_commands',
  section: 'commands',
  risk: 'read',
  description:
    'List slash commands (name, description, source). Commands are edited as files by the human.',
  input: z.object({}),
  route: async (_input, inject) => {
    await assertClaude(inject);
    return { method: 'GET', url: '/api/commands' };
  },
  // Ответ маршрута — объект , а не массив.
  shape: (_input, body) => {
    const response = body as CommandsResponse;
    return {
      commands: response.commands.map((item) => ({
        invocation: item.invocation,
        description: maskSecretsInText(item.description),
        source: item.source,
        isEnabled: item.isEnabled,
        ...(item.owner ? { owner: item.owner } : {}),
      })),
      ...(response.notes.length > 0 ? { notes: response.notes } : {}),
    };
  },
  summary: 'journal-list-commands',
});

// --- Переключатели скилла, MCP и права ---

type ToggleEntity = 'skill' | 'mcp' | 'permission';

const TOGGLE_ROUTES: Record<ToggleEntity, string> = {
  skill: '/skills',
  mcp: '/mcp',
  permission: '/permissions',
};

function toggleAction(
  entity: ToggleEntity,
  name: string,
  title: 'journal-toggle-skill' | 'journal-toggle-mcp' | 'journal-toggle-permission',
) {
  const resolveId = async (id: string, inject: InjectRoute): Promise<string> =>
    entity === 'permission' ? permissionId(id, inject) : id;
  return definePanelAction({
    name,
    section: entity === 'permission' ? 'permissions' : entity === 'skill' ? 'skills' : 'mcp',
    risk: 'change',
    title,
    description: `Enable or disable a ${entity === 'mcp' ? 'MCP server' : entity === 'skill' ? 'skill' : 'permission rule'} by id. Needs confirmation.`,
    input: z.object({ id: z.string().min(1), isEnabled: z.boolean() }),
    route: async (input, inject) => {
      await assertClaude(inject);
      return {
        method: 'POST',
        url: `/api/entities/${entity}/${encode(await resolveId(input.id, inject))}/enabled`,
        body: { isEnabled: input.isEnabled },
      };
    },
    fingerprint: async (input, inject) => {
      await assertClaude(inject);
      const id = await resolveId(input.id, inject);
      return fileFingerprint(inject, {
        kind: 'entity',
        action: 'toggle',
        entity,
        id,
        isEnabled: input.isEnabled,
      });
    },
    preview: async (input, inject) => {
      await assertClaude(inject);
      const id = await resolveId(input.id, inject);
      return fileCard(
        inject,
        { kind: 'entity', action: 'toggle', entity, id, isEnabled: input.isEnabled },
        card(input.isEnabled ? 'summary-entity-enable' : 'summary-entity-disable', {
          name: maskSecretsInText(id),
        }),
      );
    },
    page: (input) => ({ route: TOGGLE_ROUTES[entity], focus: input.id }),
  });
}

export const HOOKS_ENV_ACTIONS: readonly AnyPanelAction[] = [
  saveHook,
  toggleHook,
  deleteHook,
  listEnv,
  setEnv,
  deleteEnv,
  readClaudeMd,
  saveClaudeMd,
  listScripts,
  readScript,
  saveScript,
  deleteScript,
  listCommands,
  toggleAction('skill', 'toggle_skill', 'journal-toggle-skill'),
  toggleAction('mcp', 'toggle_mcp_server', 'journal-toggle-mcp'),
  toggleAction('permission', 'toggle_permission_rule', 'journal-toggle-permission'),
];
