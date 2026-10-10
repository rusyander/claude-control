import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AppSettings,
  DlpInfo,
  EndpointProfile,
  EndpointTarget,
  EndpointsInfo,
  Group,
  IntegrationId,
  IntegrationStatus,
  ProvidersResponse,
} from '@agentdeck/contracts';
import { INTEGRATION_ORDER } from '@agentdeck/contracts/integrations';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import {
  card,
  encode,
  literalSecrets,
  MASK_REFUSAL,
  maskDeep,
  readRoute,
  routeFingerprint,
  SECRET_REFUSAL,
  stateCard,
  unmasked,
} from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';
import { maskNamedValue, SECRET_MASK } from '../../../lib/secret-mask/secret-mask.ts';
import { needsToken } from '../../../domains/integrations/store/store.ts';

/**
 * Действия волны A по состоянию панели: группы, настройки, провайдер, свои
 * эндпоинты, защита данных и интеграции. Исполнение — маршруты окна; карточка —
 * дифф маскированной записи «было → станет», отпечаток — та же запись,
 * прочитанная маршрутом чтения перед показом и перед исполнением.
 */

const settingsOf = (inject: InjectRoute) => readRoute<AppSettings>(inject, '/api/settings');

// --- Группы ---

const listGroups = definePanelAction({
  name: 'list_groups',
  section: 'groups',
  risk: 'read',
  description:
    'List panel groups (id, name, enabled, members as kind:id, env with secret values masked, bound project paths). ' +
    'To edit env send the whole map back: masked values are kept from disk.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/groups' }),
  shape: (_input, body) => ({
    groups: (body as Group[]).map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      isEnabled: group.isEnabled,
      members: group.members.map((member) => `${member.kind}:${member.id}`),
      // Значения, а не одни имена: env правки — полная замена, и у выключенной
      // группы list_env их не видит — без них добавить ключ значило стереть прочие.
      // Секреты — маской; назад маска возвращается значением с диска (groupDraft).
      env: maskDeep(group.env) as Record<string, string>,
      projectPaths: group.projectPaths,
    })),
  }),
  summary: 'journal-list-groups',
});

const MEMBER = z
  .string()
  .regex(/^(rule|hook|skill|mcp|permission|group):.+$/)
  .describe('kind:id, e.g. "skill:review", "mcp:gitlab"');

export const groupInput = z.object({
  id: z.string().min(1).optional().describe('Existing group id; omit to create'),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  members: z.array(MEMBER).optional().describe('Full member list; omit on edit to keep'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Env applied while enabled; secrets are never sent. Whole map, replaces the current one: send list_groups env back with your change (masked values are kept). Omit on edit to keep',
    ),
  projectPaths: z.array(z.string()).optional().describe('Omit on edit to keep'),
});

export async function findGroup(inject: InjectRoute, id: string): Promise<Group> {
  const group = (await readRoute<Group[]>(inject, '/api/groups')).find((item) => item.id === id);
  if (!group) throw new Error(`Group «${id}» not found. Call list_groups.`);
  return group;
}

/**
 * Значение env группы, которое модель прислала обратно. Секретное ИМЯ прячет
 * значение целиком (`maskNamedValue`), и такую маску текстовое восстановление
 * не сопоставит — оно ищет секреты детектором по тексту. Целая маска на месте
 * значения, которое под этим именем и маскируется, — «оставить как было».
 */
function keptEnvValue(key: string, saved: string | undefined, sent: string): string {
  if (sent === SECRET_MASK && saved !== undefined && maskNamedValue(key, saved) === SECRET_MASK) {
    return saved;
  }
  return unmasked(`env.${key}`, saved, sent);
}

/** Черновик группы: всё, что модель не прислала, — из нынешней записи. */
export async function groupDraft(input: z.infer<typeof groupInput>, inject: InjectRoute) {
  // Маска — это «оставить как было», а не живой секрет: её сверяет unmasked ниже.
  const env = Object.fromEntries(
    Object.entries(input.env ?? {}).filter(([, value]) => !value.includes(SECRET_MASK)),
  );
  const secrets = literalSecrets(env);
  if (secrets.length > 0) throw new Error(`env.${secrets[0]}: ${SECRET_REFUSAL}`);
  const current = input.id === undefined ? undefined : await findGroup(inject, input.id);
  // Значения env модель видит только маской (list_env): маска — назад значением
  // группы с диска, а непарная или в новой группе — отказ до карточки. Иначе
  // `••••••` молча лёг бы на место пароля, а дифф карточки маскирует обе стороны.
  const sentEnv =
    input.env &&
    Object.fromEntries(
      Object.entries(input.env).map(([key, value]) => [
        key,
        keptEnvValue(key, current?.env[key], value),
      ]),
    );
  const draft = {
    name: input.name,
    description: input.description ?? current?.description ?? '',
    color: current?.color ?? 'accent',
    icon: current?.icon ?? 'folder',
    members:
      input.members?.map((member) => {
        const at = member.indexOf(':');
        return {
          kind: member.slice(0, at) as Group['members'][number]['kind'],
          id: member.slice(at + 1),
        };
      }) ??
      current?.members ??
      [],
    env: sentEnv ?? current?.env ?? {},
    projectPaths: input.projectPaths ?? current?.projectPaths ?? [],
    ...(current?.scenario ? { scenario: current.scenario } : {}),
    isEnabled: current?.isEnabled ?? true,
  };
  return { current, draft };
}

const saveGroup = definePanelAction({
  name: 'save_group',
  section: 'groups',
  risk: 'change',
  title: 'journal-save-group',
  description:
    'Create a group or edit one by id. A new group is ENABLED at once (its env is written). Needs confirmation.',
  input: groupInput,
  route: async (input, inject) => {
    const { current, draft } = await groupDraft(input, inject);
    return current
      ? {
          method: 'PUT',
          url: `/api/groups/${encode(current.id)}`,
          body: { ...draft, order: current.order },
        }
      : { method: 'POST', url: '/api/groups', body: draft };
  },
  fingerprint: async (input, inject) =>
    input.id === undefined
      ? routeFingerprint(inject, '/api/groups', (body) =>
          (body as Group[]).map((group) => group.name),
        )
      : fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const { current, draft } = await groupDraft(input, inject);
    const shown = {
      ...draft,
      members: draft.members.map((member) => `${member.kind}:${member.id}`),
    };
    return stateCard(
      `state.json: groups/${input.name}`,
      current
        ? {
            ...current,
            members: current.members.map((member) => `${member.kind}:${member.id}`),
            id: undefined,
            order: undefined,
          }
        : undefined,
      shown,
      card(current ? 'summary-group-edit' : 'summary-group-create', { name: input.name }),
      [dataField('label-members', String(draft.members.length))],
    );
  },
  // Новая группа получает id только в ответе POST — фокус берётся из него.
  page: (input, result) => {
    const id = input.id ?? (result as Partial<Group> | undefined)?.id;
    return { route: '/groups', ...(id ? { focus: id } : {}) };
  },
});

const toggleGroup = definePanelAction({
  name: 'toggle_group',
  section: 'groups',
  risk: 'change',
  title: 'journal-toggle-group',
  description:
    'Enable or disable a group: every member is switched with it and its env is applied or removed. Needs confirmation.',
  input: z.object({ id: z.string().min(1), isEnabled: z.boolean() }),
  route: (input) => ({
    method: 'POST',
    url: `/api/groups/${encode(input.id)}/enabled`,
    body: { isEnabled: input.isEnabled },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    return stateCard(
      `state.json: groups/${group.name}`,
      { isEnabled: group.isEnabled },
      { isEnabled: input.isEnabled },
      card(input.isEnabled ? 'summary-group-enable' : 'summary-group-disable', {
        name: group.name,
      }),
      [
        dataField(
          'label-members',
          group.members.map((member) => `${member.kind}:${member.id}`).join(', ') || '—',
        ),
        ...(Object.keys(group.env).length > 0
          ? [dataField('label-env-keys', Object.keys(group.env).join(', '))]
          : []),
      ],
    );
  },
  page: (input) => ({ route: '/groups', focus: input.id }),
});

const deleteGroup = definePanelAction({
  name: 'delete_group',
  section: 'groups',
  risk: 'danger',
  title: 'journal-delete-group',
  description:
    'Delete a group. Members stay on disk and are released; env keys held only by it are removed. Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: (input) => ({ method: 'DELETE', url: `/api/groups/${encode(input.id)}` }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    const members = group.members.map((member) => `${member.kind}:${member.id}`);
    // Удаление трогает не только запись группы: снимает её env из settings.json
    // и оживляет участников, которых гасила только она. Карточка это называет.
    const effect = await readRoute<{ envRemoved: string[]; membersBackOn: string[] }>(
      inject,
      `/api/groups/${encode(group.id)}/delete-effect`,
    );
    return stateCard(
      `state.json: groups/${group.name}`,
      { ...group, members },
      {},
      card('summary-group-delete', { name: group.name }),
      [
        dataField('label-members', members.join(', ') || '—'),
        ...(effect.envRemoved.length > 0
          ? [dataField('label-group-delete-env', effect.envRemoved.join(', '))]
          : []),
        ...(effect.membersBackOn.length > 0
          ? [dataField('label-group-delete-back-on', effect.membersBackOn.join(', '))]
          : []),
      ],
    );
  },
  page: () => ({ route: '/groups' }),
});

// --- Настройки и провайдер ---

/** Ключи, которые агент правит общим PATCH. Остальные — у своих действий или только у человека. */
const SETTINGS_KEYS = {
  theme: z.enum(['light', 'dark', 'system']),
  language: z.enum(['ru', 'en']),
  accent: z.enum(['default', 'blue', 'green', 'purple', 'amber']),
  largeText: z.boolean(),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
  editor: z.string().max(500),
  costUnit: z.enum(['tokens', 'money']),
  watchFiles: z.boolean(),
  backupKeep: z.number().int().min(1).max(100),
  mcpNetworkTimeoutMs: z.number().int().min(2_000).max(120_000),
  mcpAutoCheck: z.boolean(),
  chatModel: z.string().max(200),
  chatEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  taskSplitInitiative: z.boolean(),
  handoffInitiative: z.boolean(),
  handoffContextLimit: z.number().int().nonnegative(),
  handoffAutoDefault: z.boolean(),
  deliverToMr: z.boolean(),
  autoUpdateModels: z.boolean(),
  previewProviderWrites: z.boolean(),
};

/**
 * Вкладки страницы настроек (`pages/Settings/model/tabs.constants.ts` окна): `focus`
 * цели `/settings` окно кладёт в `?tab=`. Без вкладки страница открывалась на
 * «Общих», а правленое поле стояло на другой — человек не видел, что поменялось.
 */
const SETTINGS_TAB = {
  general: 'general',
  providers: 'providers',
  models: 'models',
  integrations: 'integrations',
  spend: 'spend',
  safety: 'safety',
} as const;

/** Вкладка каждого ключа общего PATCH: тип требует её у нового ключа. */
const SETTINGS_KEY_TAB: Record<keyof typeof SETTINGS_KEYS, string> = {
  theme: SETTINGS_TAB.general,
  language: SETTINGS_TAB.general,
  accent: SETTINGS_TAB.general,
  largeText: SETTINGS_TAB.general,
  reduceMotion: SETTINGS_TAB.general,
  highContrast: SETTINGS_TAB.general,
  editor: SETTINGS_TAB.general,
  costUnit: SETTINGS_TAB.spend,
  watchFiles: SETTINGS_TAB.safety,
  backupKeep: SETTINGS_TAB.safety,
  previewProviderWrites: SETTINGS_TAB.safety,
  mcpNetworkTimeoutMs: SETTINGS_TAB.models,
  mcpAutoCheck: SETTINGS_TAB.models,
  chatModel: SETTINGS_TAB.models,
  chatEffort: SETTINGS_TAB.models,
  taskSplitInitiative: SETTINGS_TAB.models,
  handoffInitiative: SETTINGS_TAB.models,
  handoffContextLimit: SETTINGS_TAB.models,
  handoffAutoDefault: SETTINGS_TAB.models,
  deliverToMr: SETTINGS_TAB.models,
  autoUpdateModels: SETTINGS_TAB.models,
};

const HUMAN_ONLY_SETTINGS =
  'claudeDirOverride, revealSecretsByDefault, backupBeforeWrite, encryptSecretBackups, autoApproveRules, chatAutoMode, ' +
  'promptGate, modelPricing, platformGateway, remote access';

const getSettings = definePanelAction({
  name: 'get_settings',
  section: 'settings',
  risk: 'read',
  description:
    'Read panel settings (secrets masked; contours, endpoints and integrations only summarized — use their own actions).',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/settings' }),
  shape: (_input, body) => {
    const { platforms, endpointProfiles, integrations, modelPricing, ...rest } =
      body as AppSettings & Record<string, unknown>;
    return {
      ...(maskDeep(rest) as object),
      contours: platforms.map((item) => item.id),
      endpointProfiles: endpointProfiles.map((item) => item.id),
      integrationsEnabled: Object.entries(integrations)
        .filter(([, value]) => (value as { enabled?: boolean }).enabled)
        .map(([id]) => id),
      modelPricingEntries: Object.keys(modelPricing).length,
    };
  },
  summary: 'journal-get-settings',
});

const updateSettings = definePanelAction({
  name: 'update_settings',
  section: 'settings',
  risk: 'change',
  title: 'journal-update-settings',
  description:
    `Change panel settings (only the listed keys). Provider: switch_provider; endpoints, DLP, integrations, contours: their actions. ` +
    `Human-only (ask the human to change them on the Settings page): ${HUMAN_ONLY_SETTINGS}. Needs confirmation.`,
  input: z
    .object(SETTINGS_KEYS)
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'Send at least one setting'),
  route: (input) => ({ method: 'PATCH', url: '/api/settings', body: input }),
  fingerprint: async (input, inject) => {
    const settings = await settingsOf(inject);
    return fingerprintOf(
      Object.keys(input).map((key) => (settings as unknown as Record<string, unknown>)[key]),
    );
  },
  preview: async (input, inject) => {
    const settings = (await settingsOf(inject)) as unknown as Record<string, unknown>;
    const before = Object.fromEntries(Object.keys(input).map((key) => [key, settings[key]]));
    return stateCard(
      'state.json: settings',
      before,
      input,
      card('summary-settings-update', { keys: Object.keys(input).join(', ') }),
    );
  },
  // Ключи с разных вкладок — открывается вкладка первого.
  page: (input) => ({
    route: '/settings',
    focus:
      SETTINGS_KEY_TAB[Object.keys(input)[0] as keyof typeof SETTINGS_KEYS] ?? SETTINGS_TAB.general,
  }),
});

const switchProvider = definePanelAction({
  name: 'switch_provider',
  section: 'provider',
  risk: 'danger',
  title: 'journal-switch-provider',
  description:
    'Switch the active CLI provider of the whole panel (sections, chat, this assistant). Ids come from the provider list. Needs confirmation.',
  input: z.object({ provider: z.string().min(1).max(40) }),
  route: (input) => ({ method: 'PATCH', url: '/api/settings', body: { provider: input.provider } }),
  fingerprint: async (_input, inject) =>
    fingerprintOf((await readRoute<ProvidersResponse>(inject, '/api/providers')).active),
  preview: async (input, inject) => {
    const providers = await readRoute<ProvidersResponse>(inject, '/api/providers');
    const next = providers.providers.find((item) => item.id === input.provider);
    if (!next) {
      throw new Error(
        `Unknown provider «${input.provider}». Known: ${providers.providers.map((item) => item.id).join(', ')}.`,
      );
    }
    const now = providers.providers.find((item) => item.id === providers.active);
    return stateCard(
      'state.json: settings.provider',
      { provider: providers.active },
      { provider: input.provider },
      card('summary-provider-switch', { from: now?.name ?? providers.active, to: next.name }),
    );
  },
  page: () => ({ route: '/settings', focus: SETTINGS_TAB.providers }),
});

// --- Свои эндпоинты ---

const listEndpoints = definePanelAction({
  name: 'list_endpoints',
  section: 'endpoints',
  risk: 'read',
  description:
    'List own endpoint profiles (id, name, baseUrl, apiKind, model), whether a token is saved, and which one the assistant uses.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/endpoints' }),
  shape: (_input, body) => {
    const info = body as EndpointsInfo;
    return {
      profiles: info.profiles.map((profile) => ({
        ...(maskDeep(profile) as object),
        hasToken: Boolean(info.tokenMasks[profile.id]),
      })),
      assistantProfileId: info.assistantProfileId,
    };
  },
  summary: 'journal-list-endpoints',
});

const endpointInput = z.object({
  id: z.string().min(1).optional().describe('Existing profile id; omit to create'),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url(),
  apiKind: z.enum(['anthropic', 'openai-compat', 'google']),
  model: z.string().max(200).default(''),
});

/** Якорь поля токена профиля на странице настроек. */
export function endpointTokenAnchor(id: string): string {
  return `endpoint-token:${id}`;
}

async function endpointPlan(input: z.infer<typeof endpointInput>, inject: InjectRoute) {
  if (literalSecrets({ baseUrl: input.baseUrl }).length > 0)
    throw new Error(`baseUrl: ${SECRET_REFUSAL}`);
  const settings = await settingsOf(inject);
  const current =
    input.id === undefined
      ? undefined
      : settings.endpointProfiles.find((item) => item.id === input.id);
  if (input.id !== undefined && !current)
    throw new Error(`Endpoint profile «${input.id}» not found. Call list_endpoints.`);
  // Токен профиля лежит по id и едет за адресом: смена хоста отправила бы его
  // новому (проба, чат, запись в CLI). Как у MCP-сервера с секретами — отказ.
  if (current && hostOf(current.baseUrl) !== hostOf(input.baseUrl)) {
    const { tokenMasks } = await readRoute<EndpointsInfo>(inject, '/api/endpoints');
    if (tokenMasks[current.id]) {
      throw new Error(
        `Endpoint profile «${current.name}» has a saved token; moving it to another host through the ` +
          'agent is refused, because the token would be sent there. Nothing was written: the human ' +
          'changes the address in the panel, or create a new profile.',
      );
    }
  }
  // Id нового профиля выводится из имени, адреса и вида API: такой же вход дал
  // бы второй профиль с тем же id, и карточка, поле токена и правки попадали бы
  // в первый. Повтор — это правка существующего, а не новый профиль.
  if (!current) {
    const twin = settings.endpointProfiles.find((item) => item.id === newEndpointId(input));
    if (twin) {
      throw new Error(
        `Endpoint profile «${twin.name}» (id ${twin.id}) already has this name, address and API kind. ` +
          'Nothing was written; edit it by id instead of creating a copy.',
      );
    }
  }
  const profile: EndpointProfile = {
    ...(current ?? { writeToken: false }),
    id: current?.id ?? newEndpointId(input),
    name: input.name,
    baseUrl: input.baseUrl,
    apiKind: input.apiKind,
    model: input.model,
  } as EndpointProfile;
  const profiles = current
    ? settings.endpointProfiles.map((item) => (item.id === current.id ? profile : item))
    : [...settings.endpointProfiles, profile];
  return { settings, current, profile, profiles };
}

/** Кому уходит запрос: схема, хост и порт. Неразборчивый адрес сравнивается целиком. */
function hostOf(address: string): string {
  try {
    return new URL(address).origin.toLowerCase();
  } catch {
    return address.trim().toLowerCase();
  }
}

/**
 * Id нового профиля выводится из входа: карточка считается при показе, запись —
 * после клика, и обе обязаны назвать ОДИН профиль (и якорь поля токена).
 */
function newEndpointId(input: { name: string; baseUrl: string; apiKind: string }): string {
  const hash = createHash('sha256')
    .update([input.name, input.baseUrl, input.apiKind].join('\n'))
    .digest('hex');
  return `ep-${hash.slice(0, 12)}`;
}

/** Профили живут на вкладке моделей; `?id=` выбирает профиль в её списке. */
function endpointsPage(id?: string) {
  return {
    route: id === undefined ? '/settings' : `/settings?id=${encode(id)}`,
    focus: SETTINGS_TAB.models,
  };
}

const saveEndpoint = definePanelAction({
  name: 'save_endpoint',
  section: 'endpoints',
  risk: 'change',
  title: 'journal-save-endpoint',
  description:
    'Create or edit an own endpoint profile (no token: the token field opens for the human after saving). Needs confirmation.',
  input: endpointInput,
  route: async (input, inject) => {
    const planned = (await endpointPlan(input, inject)).profiles;
    return { method: 'PATCH', url: '/api/settings', body: { endpointProfiles: planned } };
  },
  fingerprint: async (_input, inject) => fingerprintOf((await settingsOf(inject)).endpointProfiles),
  preview: async (input, inject) => {
    const plan = await endpointPlan(input, inject);
    return stateCard(
      `state.json: settings.endpointProfiles/${plan.profile.id}`,
      plan.current,
      plan.profile,
      card(plan.current ? 'summary-endpoint-edit' : 'summary-endpoint-create', {
        name: input.name,
      }),
      [dataField('label-address', input.baseUrl)],
    );
  },
  shape: (input) => ({
    saved: input.id ?? newEndpointId(input),
  }),
  secretStep: (input, result) => {
    const id = (result as { saved?: string }).saved;
    return id && input.id === undefined
      ? { route: '/settings', focus: endpointTokenAnchor(id) }
      : undefined;
  },
  page: (input) => endpointsPage(input.id ?? newEndpointId(input)),
});

async function findProfile(inject: InjectRoute, id: string): Promise<EndpointProfile> {
  const profile = (await settingsOf(inject)).endpointProfiles.find((item) => item.id === id);
  if (!profile) throw new Error(`Endpoint profile «${id}» not found. Call list_endpoints.`);
  return profile;
}

/**
 * Готовность CLI принять профиль — тем же маршрутом, по которому раздел настроек
 * рисует список CLI (`GET /api/endpoints?profile=`). Неподдержанный CLI
 * отказывает ДО карточки: иначе человек подтверждал бы запись, которую маршрут
 * применения всё равно отклонит (400 `unsupported_provider`).
 */
async function applyTarget(
  inject: InjectRoute,
  id: string,
  providerId: string,
): Promise<EndpointTarget> {
  const info = await readRoute<EndpointsInfo>(inject, `/api/endpoints?profile=${encode(id)}`);
  if (info.activeProfileId !== id) {
    throw new Error(`Endpoint profile «${id}» not found. Call list_endpoints.`);
  }
  const target = info.targets.find((item) => item.providerId === providerId);
  if (!target) {
    throw new Error(
      `Unknown provider «${providerId}». Known: ${info.targets.map((item) => item.providerId).join(', ')}.`,
    );
  }
  if (!target.supported) {
    const accepts = target.apiKinds.length ? target.apiKinds.join(', ') : 'none';
    throw new Error(
      `${target.providerName} does not accept this profile (${target.reason ?? 'unsupported'}; ` +
        `API kinds it accepts: ${accepts}). Nothing was written; pick another CLI.`,
    );
  }
  return target;
}

const probeEndpoint = definePanelAction({
  name: 'probe_endpoint',
  section: 'endpoints',
  risk: 'read',
  description:
    'Check the connection of an endpoint profile: model list from its address (no data is sent).',
  input: z.object({ id: z.string().min(1) }),
  route: (input) => ({ method: 'POST', url: `/api/endpoints/${encode(input.id)}/probe` }),
  summary: 'journal-probe-endpoint',
});

const applyEndpoint = definePanelAction({
  name: 'apply_endpoint',
  section: 'endpoints',
  risk: 'danger',
  title: 'journal-apply-endpoint',
  description:
    'Write an endpoint profile into a CLI config (e.g. provider "claude" → settings.json env). Needs confirmation.',
  input: z.object({ id: z.string().min(1), provider: z.string().min(1) }),
  route: (input) => ({
    method: 'POST',
    url: `/api/endpoints/${encode(input.id)}/apply`,
    body: { provider: input.provider },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findProfile(inject, input.id)),
  preview: async (input, inject) => {
    const target = await applyTarget(inject, input.id, input.provider);
    const profile = await findProfile(inject, input.id);
    return {
      ...card('summary-endpoint-apply', { name: profile.name, provider: input.provider }),
      fields: [
        dataField('label-address', profile.baseUrl),
        dataField('label-model', profile.model || '—'),
        dataField('label-provider', input.provider),
        dataField('label-file', target.filePath),
        // У токена не показывается даже маска: её хвост модели ни к чему.
        dataField(
          'label-env-keys',
          target.plan
            .map((item) => (item.secret ? `${item.key}=•••` : `${item.key}=${item.value}`))
            .join('; '),
        ),
      ],
    };
  },
  page: (input) => endpointsPage(input.id),
});

const deleteEndpoint = definePanelAction({
  name: 'delete_endpoint',
  section: 'endpoints',
  risk: 'danger',
  title: 'journal-delete-endpoint',
  description: 'Remove an endpoint profile from the panel settings. Needs confirmation.',
  input: z.object({ id: z.string().min(1) }),
  route: async (input, inject) => ({
    method: 'PATCH',
    url: '/api/settings',
    body: {
      endpointProfiles: (await settingsOf(inject)).endpointProfiles.filter(
        (item) => item.id !== input.id,
      ),
    },
  }),
  fingerprint: async (_input, inject) => fingerprintOf((await settingsOf(inject)).endpointProfiles),
  preview: async (input, inject) => {
    const profile = await findProfile(inject, input.id);
    return stateCard(
      `state.json: settings.endpointProfiles/${profile.id}`,
      profile,
      {},
      card('summary-endpoint-delete', { name: profile.name }),
    );
  },
  page: () => endpointsPage(),
});

// --- Защита данных ---

const getDlp = definePanelAction({
  name: 'get_dlp',
  section: 'dlp',
  risk: 'read',
  description:
    'Read data protection: proxy status and settings, own rules (terms, patterns, actions), builtin ids.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/dlp' }),
  shape: (_input, body) => {
    const info = body as DlpInfo;
    return {
      settings: info.settings,
      status: info.status,
      rules: info.rules,
      builtins: info.builtins.map((item) => item.id),
    };
  },
  summary: 'journal-get-dlp',
});

const dlpRule = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  kind: z.enum(['builtin', 'terms', 'regex']),
  builtin: z.string().optional(),
  terms: z.array(z.string()).default([]),
  pattern: z.string().default(''),
  action: z.enum(['mask', 'block', 'flag']).default('mask'),
  label: z.string().default('ДАННЫЕ'),
});

const saveDlpRules = definePanelAction({
  name: 'save_dlp_rules',
  section: 'dlp',
  risk: 'change',
  title: 'journal-save-dlp-rules',
  description:
    'Replace the WHOLE list of own data protection rules (read get_dlp first, send the full list). Needs confirmation.',
  input: z.object({ rules: z.array(dlpRule).max(200) }),
  route: (input) => ({ method: 'PUT', url: '/api/dlp/rules', body: { rules: input.rules } }),
  fingerprint: (_input, inject) =>
    routeFingerprint(inject, '/api/dlp', (body) => (body as DlpInfo).rules),
  preview: async (input, inject) => {
    const info = await readRoute<DlpInfo>(inject, '/api/dlp');
    return stateCard(
      'dlp-rules.json',
      info.rules,
      input.rules,
      card('summary-dlp-rules', { count: input.rules.length }),
    );
  },
  // Первое новое или изменённое правило (`changed` маршрута записи) — подсвечено.
  page: (_input, result) => {
    const id = (result as { changed?: string[] } | undefined)?.changed?.[0];
    return id ? { route: '/dlp', focus: `dlp-rule:${id}` } : { route: '/dlp' };
  },
});

/**
 * Куда запущенный прокси будет пересылать запросы — или отказ ДО карточки.
 * Запуск без включённого правила или без адреса маршрут всё равно отклонит
 * (`buildDlpRuntime`: 400 `dlp_misconfigured`), и человек подтверждал бы
 * заведомо пустое действие (живой прогон 26.09: «включи защиту данных» при
 * пустом адресе). Порядок выбора адреса — как у `resolveDlpUpstream`: свой
 * адрес, иначе адрес профиля эндпоинта; разбор адреса остаётся маршруту.
 */
async function dlpStartUpstream(info: DlpInfo, inject: InjectRoute): Promise<string> {
  if (!info.rules.some((rule) => rule.enabled)) {
    throw new Error(
      'The proxy cannot start: no enabled data protection rule (a proxy that looks for nothing is not protection). ' +
        'Nothing was done; add or enable a rule first (save_dlp_rules).',
    );
  }
  const direct = info.settings.upstreamUrl.trim();
  if (direct) return direct;
  const profile = (await settingsOf(inject)).endpointProfiles.find(
    (item) => item.id === info.settings.upstreamProfileId,
  );
  if (profile?.baseUrl) return profile.baseUrl;
  throw new Error(
    'The proxy cannot start: no upstream address (where to forward requests) is set. Nothing was done; ' +
      'the human sets it on the Data protection page (open_page /dlp).',
  );
}

const toggleDlpProxy = definePanelAction({
  name: 'toggle_dlp_proxy',
  section: 'dlp',
  risk: 'change',
  title: 'journal-toggle-dlp-proxy',
  description:
    'Start or stop the local DLP proxy (remembered across restarts). Needs confirmation.',
  input: z.object({ running: z.boolean() }),
  route: (input) => ({ method: 'POST', url: input.running ? '/api/dlp/start' : '/api/dlp/stop' }),
  // Сравнение идёт и по живому слушателю, а не только по флагу: прокси, упавший
  // при `enabled: true`, иначе не запустить — «ничего не изменится».
  fingerprint: (_input, inject) =>
    routeFingerprint(inject, '/api/dlp', (body) => ({
      settings: (body as DlpInfo).settings,
      running: (body as DlpInfo).status.running,
    })),
  preview: async (input, inject) => {
    const info = await readRoute<DlpInfo>(inject, '/api/dlp');
    const upstream = input.running ? await dlpStartUpstream(info, inject) : undefined;
    return stateCard(
      'dlp: settings.dlp.enabled + proxy',
      { enabled: info.settings.enabled, running: info.status.running },
      { enabled: input.running, running: input.running },
      card(input.running ? 'summary-dlp-start' : 'summary-dlp-stop'),
      upstream ? [dataField('label-address', upstream)] : [],
    );
  },
  page: () => ({ route: '/dlp' }),
});

// --- Интеграции ---

const INTEGRATIONS = INTEGRATION_ORDER;

const listIntegrations = definePanelAction({
  name: 'list_integrations',
  section: 'integrations',
  risk: 'read',
  description:
    'List integrations (Jira, Confluence, GitLab, GitHub, Telegram, Zephyr, Xray, Test IT, CI, webhook) — each connects on its own: enabled, token saved, last check, visible settings.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/integrations' }),
  afterRoute: async (_input, body, inject) => {
    const settings = await settingsOf(inject);
    return (body as IntegrationStatus[]).map((status) => ({
      ...status,
      maskedToken: undefined,
      settings: maskDeep(settings.integrations[status.id]),
    }));
  },
  summary: 'journal-list-integrations',
});

/** Якорь поля токена интеграции на странице настроек. */
export function integrationSecretAnchor(id: string): string {
  return `integration-secret:${id}`;
}

async function integrationPlan(
  id: IntegrationId,
  patch: Record<string, unknown>,
  inject: InjectRoute,
) {
  const strings = Object.fromEntries(
    Object.entries(patch).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const secrets = literalSecrets(strings);
  if (secrets.length > 0) throw new Error(`settings.${secrets[0]}: ${SECRET_REFUSAL}`);
  const current = (await settingsOf(inject)).integrations[id] as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(patch).filter((key) => !(key in current));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown ${id} settings: ${unknownKeys.join(', ')}. Known: ${Object.keys(current).join(', ')}.`,
    );
  }
  // Настройки модель читает маской (list_integrations): адрес с токеном в запросе
  // приходит назад с `••••••`. Маска — назад значением с диска; лишняя или
  // непарная — отказ до карточки, иначе маска молча стёрла бы секрет в адресе.
  const restored = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => {
      if (typeof value === 'string') {
        const saved = current[key];
        return [
          key,
          unmasked(`settings.${key}`, typeof saved === 'string' ? saved : undefined, value),
        ];
      }
      if (JSON.stringify(value ?? null).includes(SECRET_MASK)) {
        throw new Error(`settings.${key}: ${MASK_REFUSAL}`);
      }
      return [key, value];
    }),
  );
  const next = { ...current, ...restored };
  await assertIntegrationNotRetargeted(id, current, next, inject);
  return { current, next };
}

/** Поля, от которых зависит, куда уходит токен интеграции (у форджа пустой адрес = github.com/gitlab.com). */
const INTEGRATION_TARGET_KEYS = ['url', 'baseUrl', 'kind'] as const;

/**
 * Токен интеграции едет за адресом: смена хоста при сохранённом ключе отправила
 * бы его туда, куда указала модель (проверка, выгрузка, вебхук). Как у профиля
 * эндпоинта и MCP с секретами — отказ до карточки; адрес меняет человек.
 */
async function assertIntegrationNotRetargeted(
  id: IntegrationId,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  inject: InjectRoute,
): Promise<void> {
  const moved = INTEGRATION_TARGET_KEYS.filter((key) => {
    if (!(key in current)) return false;
    const before = String(current[key] ?? '');
    const after = String(next[key] ?? '');
    return key === 'kind' ? before !== after : hostOf(before) !== hostOf(after);
  });
  if (moved.length === 0) return;
  const statuses = await readRoute<IntegrationStatus[]>(inject, '/api/integrations');
  const status = statuses.find((item) => item.id === id);
  if (!status?.hasToken) return;
  throw new Error(
    `Integration «${id}» has a saved token; changing its ${moved.join('/')} through the agent is ` +
      'refused, because the token would be sent to the new host. Nothing was written: the human ' +
      'changes the address in the panel.',
  );
}

/** Адрес интеграции для карточки, маской: у вебхука `url`, у остальных `baseUrl`. */
function integrationAddress(settings: Record<string, unknown>): string | undefined {
  const address = [settings.url, settings.baseUrl].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return address === undefined ? undefined : (maskDeep(address) as string);
}

/**
 * Карточка интеграции на вкладке «Интеграции». Вкладки мало: карточек десять, и
 * последние под экраном — человек видел Jira, а агент говорил «карточка вебхука
 * открыта». Имя якоря повторяет `integrationAnchor` веба.
 */
function integrationPage(id: string) {
  return { route: '/settings', focus: `integration:${id}` };
}

const saveIntegration = definePanelAction({
  name: 'save_integration',
  section: 'integrations',
  risk: 'change',
  title: 'journal-save-integration',
  description:
    'Change visible settings of an integration (address, e-mail, project key, events, enabled). The token is never sent: ' +
    'when none is saved, its field opens for the human. Needs confirmation.',
  input: z.object({
    id: z.enum(INTEGRATIONS),
    settings: z.record(z.string(), z.unknown()).describe('Only the fields to change'),
  }),
  route: async (input, inject) => ({
    method: 'PUT',
    url: `/api/integrations/${input.id}`,
    body: { settings: (await integrationPlan(input.id, input.settings, inject)).next },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await settingsOf(inject)).integrations[input.id]),
  preview: async (input, inject) => {
    const plan = await integrationPlan(input.id, input.settings, inject);
    // Адрес — отдельной строкой: в дифе длинный URL обрезан краем карточки, а
    // куда панель будет слать события, человек должен прочесть целиком.
    const address = integrationAddress(plan.next);
    return stateCard(
      `state.json: settings.integrations.${input.id}`,
      plan.current,
      plan.next,
      card('summary-integration-save', { id: input.id }),
      address ? [dataField('label-address', address)] : [],
    );
  },
  shape: (_input, body) => ({ ...(body as IntegrationStatus), maskedToken: undefined }),
  // Ключ просится, только когда он нужен: секрет подписи вебхука необязателен
  // (`needsToken`), а выключение интеграции — законченная работа, а не
  // «сохранено, нужен ключ».
  secretStep: (input, result) =>
    (result as IntegrationStatus).hasToken ||
    !needsToken(input.id) ||
    input.settings.enabled === false
      ? undefined
      : { route: '/settings', focus: integrationSecretAnchor(input.id) },
  page: (input) => integrationPage(input.id),
});

/**
 * Проверка — не чтение: она ходит наружу с сохранённым токеном, вебхуку шлёт
 * НАСТОЯЩИЙ запрос с тестовым событием, а итог пишет на диск (`health.ts`).
 * Поэтому — карточка, как у любой записи.
 */
const checkIntegration = definePanelAction({
  name: 'check_integration',
  section: 'integrations',
  risk: 'change',
  title: 'journal-check-integration',
  description:
    'Live connection check of an integration with its saved token (the webhook check SENDS a test event to its address); ' +
    'the result is saved on the integration card. Needs confirmation.',
  input: z.object({ id: z.enum(INTEGRATIONS) }),
  route: (input) => ({ method: 'POST', url: `/api/integrations/${input.id}/check` }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await settingsOf(inject)).integrations[input.id]),
  preview: async (input, inject) => {
    const saved = (await settingsOf(inject)).integrations[input.id] as unknown as Record<
      string,
      unknown
    >;
    const address = integrationAddress(saved);
    // У интеграции с полем адреса проверка без адреса обречена: карточку не
    // показываем, иначе человек одобрял бы заведомый провал.
    if (!address && ('url' in saved || 'baseUrl' in saved)) {
      throw new Error(
        `Integration «${input.id}» has no address yet — nothing to check. Ask the human for it and save it with save_integration first.`,
      );
    }
    return {
      ...card('summary-integration-check', { id: input.id }),
      fields: [
        ...(address ? [dataField('label-address', address)] : []),
        textField(
          'label-what-happens',
          input.id === 'webhook' ? 'value-happens-webhook-test' : 'value-happens-integration-check',
        ),
      ],
    };
  },
  shape: (_input, body) => ({ ...(body as IntegrationStatus), maskedToken: undefined }),
  page: (input) => integrationPage(input.id),
});

const forgetIntegration = definePanelAction({
  name: 'forget_integration',
  section: 'integrations',
  risk: 'danger',
  title: 'journal-forget-integration',
  description:
    'Forget an integration: its token is erased and it is disabled (address stays). Needs confirmation.',
  input: z.object({ id: z.enum(INTEGRATIONS) }),
  route: (input) => ({ method: 'DELETE', url: `/api/integrations/${input.id}` }),
  fingerprint: (input, inject) =>
    routeFingerprint(inject, '/api/integrations', (body) =>
      (body as IntegrationStatus[]).find((item) => item.id === input.id),
    ),
  preview: async (input, inject) => {
    const status = (await readRoute<IntegrationStatus[]>(inject, '/api/integrations')).find(
      (item) => item.id === input.id,
    );
    return stateCard(
      `integrations/${input.id}`,
      { enabled: status?.enabled, hasToken: status?.hasToken },
      { enabled: false, hasToken: false },
      card('summary-integration-forget', { id: input.id }),
    );
  },
  shape: (_input, body) => ({ ...(body as IntegrationStatus), maskedToken: undefined }),
  page: (input) => integrationPage(input.id),
});

export const APP_STATE_ACTIONS: readonly AnyPanelAction[] = [
  listGroups,
  saveGroup,
  toggleGroup,
  deleteGroup,
  getSettings,
  updateSettings,
  switchProvider,
  listEndpoints,
  saveEndpoint,
  probeEndpoint,
  applyEndpoint,
  deleteEndpoint,
  getDlp,
  saveDlpRules,
  toggleDlpProxy,
  listIntegrations,
  saveIntegration,
  checkIntegration,
  forgetIntegration,
];
