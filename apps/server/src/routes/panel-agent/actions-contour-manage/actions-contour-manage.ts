import { z } from 'zod';
import type {
  PlatformApplyPlan,
  PlatformGatewayInfo,
  PlatformRollbackResult,
  PlatformsInfo,
  PlatformSpendDay,
  PlatformSpendInfo,
  PlatformStatus,
} from '@agentdeck/contracts';
import { platformIdPattern } from '@agentdeck/contracts/platform';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, encode, readRoute } from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Контур сверх «составить и включить» (`actions-contour.ts`): снять применение,
 * выключить, удалить, шлюз, расход и переходник MCP. Всё — маршрутами
 * `routes/platform-routes/platform-routes.ts`, теми же, что зовут кнопки раздела «Контур».
 *
 * Ключ и здесь не виден: ни вход, ни ответ его не несут. Разрушающее (снять,
 * выключить, удалить, перезапустить шлюз) — `danger`: карточка называет, что
 * именно откатится, и человек подтверждает.
 */

const idSchema = z
  .string()
  .trim()
  .regex(platformIdPattern)
  .describe('Contour id from list_contours');

const contourUrl = (id: string) => `/api/platforms/${encode(id)}`;

/** Карточка контура по id — отказ словами, если такого нет. */
async function contourOf(inject: InjectRoute, id: string): Promise<PlatformStatus> {
  const info = await readRoute<PlatformsInfo>(inject, '/api/platforms');
  const status = info.platforms.find((item) => item.platform.id === id);
  if (!status) throw new Error(`No contour "${id}". Call list_contours.`);
  return status;
}

/** Цели, к которым контур применён сейчас: название и файл. */
async function appliedTargets(inject: InjectRoute, id: string) {
  const plan = await readRoute<PlatformApplyPlan>(inject, `${contourUrl(id)}/apply`);
  return plan.targets
    .filter((target) => target.applied)
    .map((target) => ({
      targetId: target.targetId,
      title: target.title,
      filePath: target.filePath,
      ...(target.appliedAt ? { appliedAt: target.appliedAt } : {}),
    }));
}

const appliedField = (targets: Awaited<ReturnType<typeof appliedTargets>>) =>
  targets.length
    ? dataField(
        'label-applied-targets',
        targets.map((target) => `${target.title} — ${target.filePath}`).join('\n'),
      )
    : textField('label-applied-targets', 'value-applied-none');

/** Итог отката глазами модели: файл и что с ним стало. */
const rollbackView = (result: PlatformRollbackResult) => ({
  files: result.entries.map((entry) => ({
    target: entry.targetId,
    file: entry.filePath,
    outcome: entry.outcome,
  })),
  profileRemoved: result.profileRemoved,
});

const disableContour = definePanelAction({
  name: 'disable_contour',
  section: 'contour',
  risk: 'danger',
  title: 'journal-disable-contour',
  description:
    'Roll back where a contour is APPLIED: CLI files return to how they were, the managed profile ' +
    'goes. A file the human edited afterwards is kept and named. The contour itself stays, and so ' +
    'does its active flag. Needs the human’s confirmation.',
  input: z.object({ id: idSchema }),
  route: (input) => ({ method: 'POST', url: `${contourUrl(input.id)}/disable` }),
  fingerprint: async (input, inject) => fingerprintOf(await appliedTargets(inject, input.id)),
  preview: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    const targets = await appliedTargets(inject, input.id);
    if (!targets.length) {
      throw new Error(`Nothing would change: contour "${input.id}" is not applied anywhere.`);
    }
    return {
      ...card('summary-disable-contour', { title: status.platform.title }),
      fields: [
        appliedField(targets),
        textField('label-what-happens', 'value-disable-contour-effect'),
      ],
    };
  },
  shape: (_input, body) => rollbackView(body as PlatformRollbackResult),
  page: () => ({ route: '/platform' }),
});

const deactivateContour = definePanelAction({
  name: 'deactivate_contour',
  section: 'contour',
  risk: 'danger',
  title: 'journal-deactivate-contour',
  description:
    'Switch a contour OFF and return to the default provider: its applications are rolled back, ' +
    'its toggle goes off, and it stops being the active contour. The contour and its key stay. ' +
    'Needs the human’s confirmation.',
  input: z.object({ id: idSchema }),
  route: (input) => ({ method: 'POST', url: `${contourUrl(input.id)}/deactivate` }),
  fingerprint: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    return fingerprintOf({
      active: status.active,
      enabled: status.platform.enabled,
      applied: await appliedTargets(inject, input.id),
    });
  },
  preview: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    const targets = await appliedTargets(inject, input.id);
    if (!status.active && !status.platform.enabled && !targets.length) {
      throw new Error(`Nothing would change: contour "${input.id}" is already off.`);
    }
    return {
      ...card('summary-deactivate-contour', { title: status.platform.title }),
      fields: [
        dataField('label-address', status.platform.baseUrl),
        appliedField(targets),
        textField('label-what-happens', 'value-deactivate-contour-effect'),
      ],
    };
  },
  shape: (_input, body) => ({ deactivated: true, ...rollbackView(body as PlatformRollbackResult) }),
  page: () => ({ route: '/platform' }),
});

const deleteContour = definePanelAction({
  name: 'delete_contour',
  section: 'contour',
  risk: 'danger',
  title: 'journal-delete-contour',
  description:
    'Delete a contour for good: its settings, its stored key and its probe trail. Its ' +
    'applications are rolled back first. Needs the human’s confirmation.',
  input: z.object({ id: idSchema }),
  route: (input) => ({ method: 'DELETE', url: contourUrl(input.id) }),
  fingerprint: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    return fingerprintOf({ platform: status.platform, hasToken: status.hasToken });
  },
  preview: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    return {
      ...card('summary-delete-contour', { title: status.platform.title }),
      fields: [
        dataField('label-address', status.platform.baseUrl),
        appliedField(await appliedTargets(inject, input.id)),
        textField('label-what-happens', 'value-delete-contour-effect'),
      ],
    };
  },
  shape: (input, body) => {
    const info = body as PlatformsInfo;
    return {
      deleted: input.id,
      activeContourId: info.activePlatformId,
      remaining: info.platforms.map((status) => status.platform.id),
    };
  },
  page: () => ({ route: '/platform' }),
});

const GATEWAY_URL = '/api/platforms/gateway';

/** Шлюз глазами модели: без маршрутов, учёта и ленты запросов. */
const gatewayView = (info: PlatformGatewayInfo) => ({
  enabled: info.settings.enabled,
  running: info.status.running,
  address: info.status.address,
  port: info.status.port,
  requestedPort: info.status.requestedPort,
  ...(info.status.error ? { error: info.status.error } : {}),
  requests: info.status.requests,
  failures: info.status.failures,
});

const gatewayStatus = definePanelAction({
  name: 'gateway_status',
  section: 'contour',
  risk: 'read',
  description:
    'Contour gateway (the local listener CLIs talk to): enabled in settings, running, address, ' +
    'port actually bound vs requested, why it failed to start, requests and failures since start.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: GATEWAY_URL }),
  shape: (_input, body) => gatewayView(body as PlatformGatewayInfo),
  summary: 'journal-gateway-status',
});

const readGateway = (inject: InjectRoute) => readRoute<PlatformGatewayInfo>(inject, GATEWAY_URL);

const startGateway = definePanelAction({
  name: 'start_gateway',
  section: 'contour',
  risk: 'change',
  title: 'journal-start-gateway',
  description:
    'Start the contour gateway when it is down: switches it on in settings and binds the saved ' +
    'port. A running gateway is not touched. Needs the human’s confirmation.',
  input: z.object({}),
  route: () => ({ method: 'POST', url: `${GATEWAY_URL}/start` }),
  fingerprint: async (_input, inject) => {
    const info = await readGateway(inject);
    return fingerprintOf({ settings: info.settings, running: info.status.running });
  },
  preview: async (_input, inject) => {
    const info = await readGateway(inject);
    if (info.status.running) {
      throw new Error(`Nothing would change: the gateway already runs at ${info.status.address}.`);
    }
    return {
      ...card('summary-start-gateway'),
      fields: [
        dataField('label-port', String(info.settings.port)),
        textField('label-what-happens', 'value-start-gateway-effect'),
      ],
    };
  },
  shape: (_input, body) => gatewayView(body as PlatformGatewayInfo),
  page: () => ({ route: '/platform' }),
});

const restartGateway = definePanelAction({
  name: 'restart_gateway',
  section: 'contour',
  risk: 'danger',
  title: 'journal-restart-gateway',
  description:
    'Restart the contour gateway with its saved settings (stops it when switched off in ' +
    'settings). Requests in flight through it are cut. Needs the human’s confirmation.',
  input: z.object({}),
  route: () => ({ method: 'POST', url: `${GATEWAY_URL}/restart` }),
  fingerprint: async (_input, inject) => fingerprintOf((await readGateway(inject)).settings),
  preview: async (_input, inject) => {
    const info = await readGateway(inject);
    return {
      ...card('summary-restart-gateway'),
      fields: [
        dataField('label-port', String(info.settings.port)),
        textField('label-what-happens', 'value-restart-gateway-effect'),
      ],
    };
  },
  shape: (_input, body) => gatewayView(body as PlatformGatewayInfo),
  page: () => ({ route: '/platform' }),
});

const dayView = (day: PlatformSpendDay) => ({
  day: day.day,
  requests: day.requests,
  tokens: day.totalTokens,
  estimateUsd: day.money.usd,
});

const spendView = (spend: PlatformSpendInfo, days: number) => ({
  contour: spend.platformId,
  ...(spend.budgetSince ? { budgetSince: spend.budgetSince } : {}),
  period: dayView(spend.period),
  total: dayView(spend.total),
  budget: {
    tracked: spend.budget.tracked,
    budgetUsd: spend.budget.budgetUsd,
    spentEstimateUsd: spend.budget.spentUsd,
    nearLimit: spend.budget.nearLimit,
    overEstimate: spend.budget.overEstimate,
    exhausted: spend.budget.exhausted,
    ...(spend.budget.exhaustedAt ? { exhaustedAt: spend.budget.exhaustedAt } : {}),
  },
  lastDays: spend.days.slice(-days).map(dayView),
  note: 'Money is the panel’s own estimate; the contour does not report its remaining budget.',
});

const contourSpend = definePanelAction({
  name: 'contour_spend',
  section: 'contour',
  risk: 'read',
  description:
    'Spend of one contour from the panel’s own records (never asks the contour): budget period, ' +
    'all time, the last days, and whether the contour refused on budget (402).',
  input: z.object({
    id: idSchema,
    days: z.number().int().min(1).max(90).default(14).describe('How many last days to list'),
  }),
  route: (input) => ({ method: 'GET', url: `${contourUrl(input.id)}/spend` }),
  shape: (input, body) => spendView(body as PlatformSpendInfo, input.days),
  summary: 'journal-contour-spend',
});

const clearContourExhausted = definePanelAction({
  name: 'clear_contour_exhausted',
  section: 'contour',
  risk: 'change',
  title: 'journal-clear-contour-exhausted',
  description:
    'Clear the "budget exhausted" mark of a contour (set by its 402 refusal) after the human ' +
    'extended the budget in the contour admin. Needs the human’s confirmation.',
  input: z.object({ id: idSchema }),
  route: (input) => ({ method: 'DELETE', url: `${contourUrl(input.id)}/spend/exhausted` }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      (await readRoute<PlatformSpendInfo>(inject, `${contourUrl(input.id)}/spend`)).budget,
    ),
  preview: async (input, inject) => {
    const status = await contourOf(inject, input.id);
    const spend = await readRoute<PlatformSpendInfo>(inject, `${contourUrl(input.id)}/spend`);
    if (!spend.budget.exhaustedAt) {
      throw new Error(`Nothing would change: contour "${input.id}" is not marked exhausted.`);
    }
    return {
      ...card('summary-clear-contour-exhausted', { title: status.platform.title }),
      fields: [
        dataField('label-exhausted-at', spend.budget.exhaustedAt),
        textField('label-what-happens', 'value-clear-exhausted-effect'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as PlatformSpendInfo & { cleared: boolean };
    return { cleared: result.cleared, exhausted: result.budget.exhausted };
  },
  page: () => ({ route: '/platform' }),
});

const MCP_URL = '/api/platforms/mcp/connect';

interface McpState {
  name: string;
  connected: boolean;
  blockedReason?: string;
}

const contourMcp = definePanelAction({
  name: 'contour_mcp_connect',
  section: 'contour',
  risk: 'change',
  title: 'journal-contour-mcp',
  description:
    'Connect (connect=true) or disconnect the contour tools as an MCP server in the CLI config. ' +
    'The entry carries only the panel address, never the contour key. Needs the human’s confirmation.',
  input: z.object({
    connect: z.boolean().describe('true = add the MCP server, false = remove it'),
  }),
  route: (input) => ({ method: input.connect ? 'POST' : 'DELETE', url: MCP_URL }),
  fingerprint: async (_input, inject) => fingerprintOf(await readRoute<McpState>(inject, MCP_URL)),
  preview: async (input, inject) => {
    const state = await readRoute<McpState>(inject, MCP_URL);
    if (state.connected === input.connect) {
      throw new Error(
        `Nothing would change: the contour MCP server is already ${state.connected ? 'connected' : 'not connected'}.`,
      );
    }
    if (input.connect && state.blockedReason) {
      throw new Error(`The contour MCP server cannot be connected: ${state.blockedReason}`);
    }
    return {
      ...card(input.connect ? 'summary-contour-mcp-connect' : 'summary-contour-mcp-disconnect'),
      fields: [
        dataField('label-mcp-server', state.name),
        textField(
          'label-what-happens',
          input.connect ? 'value-mcp-bridge-no-key' : 'value-mcp-disconnect-effect',
        ),
      ],
    };
  },
  shape: (_input, body) => {
    const state = body as McpState & { removed?: boolean };
    return {
      name: state.name,
      connected: state.connected,
      ...(state.removed === undefined ? {} : { removed: state.removed }),
    };
  },
  page: () => ({ route: '/platform' }),
});

/** Контур сверх «составить и включить»: в порядке показа. */
export const CONTOUR_MANAGE_ACTIONS: readonly AnyPanelAction[] = [
  disableContour,
  deactivateContour,
  deleteContour,
  gatewayStatus,
  startGateway,
  restartGateway,
  contourSpend,
  clearContourExhausted,
  contourMcp,
];
