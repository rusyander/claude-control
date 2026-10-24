import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SIGNATURE_HEADER,
  SIGNED_DECISION_ROUTES,
  signatureClass,
  type SignatureRefusal,
} from '@agentdeck/contracts/phone-signing';
import { SPLIT_DEFAULTS_BUILTIN, resolveGroupPermissions } from '@agentdeck/contracts/split-groups';
import type { ServerContext } from '../../context.ts';
import { layoutForCwd } from '../../domains/project-git/copy-readiness.ts';
import {
  sendLoosens,
  settingsPatchLoosens,
  splitDefaultsLoosen,
  splitSettingsLoosen,
  type ChatLeverState,
} from '../../domains/phone-signing/levers.ts';
import { activeDevices, type PhoneSigningStore } from '../../domains/phone-signing/store.ts';
import type { SigningState } from '../../domains/phone-signing/phone-signing.types.ts';
import { verifySignature } from '../../domains/phone-signing/verify.ts';
import { machineId } from '../../lib/machine-identity/machine-identity.ts';
import { humanOnlyDepsFor } from '../chat/human-only/human-only-deps.ts';
import {
  checkHumanCaller,
  refuseNonHuman,
  type HumanOnlyDeps,
} from '../chat/human-only/human-only.ts';
import { phoneSigningStore, refuseSignature } from './signing-common.ts';

/**
 * Подпись телефона на маршрутах решений — одним хуком `onRoute`, как ворота
 * журнала возможностей (`ledger-gate.ts`), а не строкой в каждом файле. Хук
 * ставится ВТОРЫМ, сразу после ворот «только человек», и добавляет проверку в
 * КОНЕЦ `preHandler`-ов: сперва панель узнаёт, что звонит не процесс модели,
 * потом — что решение подписано ключом телефона.
 *
 * Режим выключен — ничего не меняется, кроме одного: отправка, ослабляющая
 * чат (`fullAccess`, `autoApprove` у чата без авторежима), теперь проходит
 * строгие ворота «только человек» в любом режиме. Раньше этот путь был открыт
 * процессу модели: строка журнала у отправки — `action:`, ворот на ней не было.
 *
 * Свои маршруты режима (`/api/phone-signing/...`) подпись проверяют сами: у
 * привязки ключ берётся из тела, у включения сверяется набор устройств.
 */

/** Рычаги: ослабление отклоняется при включённом режиме с любого канала. */
export const LEVER_ROUTES = [
  'PATCH /api/settings',
  'POST /api/settings/import',
  'PUT /api/split-defaults',
  'PUT /api/project-git/split-settings',
] as const;

const SELF_ROUTES = new Set(['POST /api/phone-signing/mode', 'POST /api/phone-signing/devices']);
const DECISIONS = new Set<string>(
  SIGNED_DECISION_ROUTES.filter((route) => !SELF_ROUTES.has(route)),
);
const LEVERS = new Set<string>(LEVER_ROUTES);

export interface SignatureGateDeps {
  store: () => PhoneSigningStore;
  machineId: () => string;
  now?: () => number;
  human: HumanOnlyDeps;
  /** Ослабляет ли отправка чат (`levers.ts sendLoosens`). */
  sendLoosens: (body: unknown) => boolean;
  /** Ослабляет ли тело рычага права всех будущих решений. */
  leverLoosens: (route: string, body: unknown) => boolean;
}

const routeOf = (request: FastifyRequest): string =>
  `${request.method} ${request.routeOptions.url ?? ''}`;

const paramsOf = (request: FastifyRequest): Record<string, string> =>
  request.params && typeof request.params === 'object'
    ? (request.params as Record<string, string>)
    : {};

export type AcceptOutcome =
  { ok: true; deviceId: string } | { ok: false; refusal: SignatureRefusal };

/**
 * Принять подпись запроса: есть живой ключ, подпись сошлась, не отозван, часы
 * в окне, одноразовое число новое. Число запоминается только у принятой.
 */
export function acceptSignature(
  request: FastifyRequest,
  deps: Pick<SignatureGateDeps, 'store' | 'machineId' | 'now'>,
  route: string,
  state: SigningState = deps.store().read(),
): AcceptOutcome {
  if (activeDevices(state).length === 0) return { ok: false, refusal: 'no-device' };
  const now = (deps.now ?? Date.now)();
  const outcome = verifySignature(
    {
      route,
      params: paramsOf(request),
      body: request.body,
      header: request.headers[SIGNATURE_HEADER],
    },
    { machineId: deps.machineId(), now, devices: state.devices },
  );
  if (!outcome.ok) return outcome;
  if (!deps.store().consumeNonce(outcome.deviceId, outcome.nonce, now)) {
    return { ok: false, refusal: 'replayed' };
  }
  return { ok: true, deviceId: outcome.deviceId };
}

/**
 * Сверить подпись решения, когда режим включён. `true` — пропустить дальше;
 * `false` — отказ уже отправлен.
 */
export async function checkSignedDecision(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: SignatureGateDeps,
  route: string = routeOf(request),
): Promise<boolean> {
  const state = deps.store().read();
  if (!state.enabled) return true;
  const outcome = acceptSignature(request, deps, route, state);
  if (outcome.ok) return true;
  await refuseSignature(reply, outcome.refusal, deps.store().path);
  return false;
}

export function signedDecisionHandler(deps: SignatureGateDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const route = routeOf(request);
    if (signatureClass(route, request.body) === 'free') return;
    if (route === 'POST /api/chat/send') {
      // Повтор действующего положения — обычное сообщение.
      if (!deps.sendLoosens(request.body)) return;
      const check = await checkHumanCaller(request, deps.human);
      if (!check.ok) {
        await refuseNonHuman(reply, check);
        return;
      }
    }
    await checkSignedDecision(request, reply, deps, route);
  };
}

export function leverHandler(deps: SignatureGateDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.store().read().enabled) return;
    if (!deps.leverLoosens(routeOf(request), request.body)) return;
    await refuseSignature(reply, 'lever');
  };
}

export function registerPhoneSigningGate(app: FastifyInstance, deps: SignatureGateDeps): void {
  const decision = signedDecisionHandler(deps);
  const lever = leverHandler(deps);
  app.addHook('onRoute', (route) => {
    const keys = [route.method].flat().map((method) => `${method} ${route.url}`);
    const extra = [
      ...(keys.some((key) => DECISIONS.has(key)) ? [decision] : []),
      ...(keys.some((key) => LEVERS.has(key)) ? [lever] : []),
    ];
    if (extra.length === 0) return;
    route.preHandler = [...[route.preHandler ?? []].flat(), ...extra];
  });
}

/** Ослабление рычага по текущему положению панели. */
export function leverLoosensFor(ctx: ServerContext, route: string, body: unknown): boolean {
  const settings = ctx.store.getSettings();
  switch (route) {
    case 'PATCH /api/settings':
      return settingsPatchLoosens(
        { chatAutoMode: settings.chatAutoMode, autoApproveRules: settings.autoApproveRules },
        body,
      );
    // Снимок чужой машины несёт и авторежим, и правила, и строки групп разом —
    // и может стереть более строгое положение проекта, просто не упомянув его.
    // Сличать по полям — значит пропустить одно из них; при включённой подписи
    // импорт целиком ждёт её выключения.
    case 'POST /api/settings/import':
      return true;
    case 'PUT /api/split-defaults':
      return splitDefaultsLoosen(
        ctx.store.getSplitDefaults().permissions,
        body,
        SPLIT_DEFAULTS_BUILTIN.permissions,
      );
    case 'PUT /api/project-git/split-settings': {
      const asked =
        body && typeof body === 'object' ? (body as { path?: unknown }).path : undefined;
      if (typeof asked !== 'string' || !asked) return false;
      const dir = layoutForCwd(asked).mainDir ?? asked;
      const defaults = ctx.store.getSplitDefaults().permissions;
      const effective = resolveGroupPermissions(
        defaults,
        ctx.store.getSplitSettings(dir).permissions,
      );
      return splitSettingsLoosen(effective, defaults, body);
    }
    default:
      return false;
  }
}

interface RunsView {
  resolveKey(chatId: string, sessionId?: string): string;
  describe(chatId: string): { options: { permissionMode?: string } } | undefined;
}

interface SessionView {
  autoModeOverride(...keys: (string | undefined)[]): boolean | undefined;
}

/**
 * Регистратор таблицы маршрутов: ставится сразу после ворот журнала
 * (`gateHumanRoutesFor`) — хук `onRoute` видит лишь маршруты после себя.
 */
export function phoneSigningGateFor(runs: RunsView, session: SessionView) {
  return (app: FastifyInstance, ctx: ServerContext): void => {
    const chat: ChatLeverState = {
      autoMode: (chatId, sessionId) =>
        session.autoModeOverride(chatId, sessionId) ?? ctx.store.getSettings().chatAutoMode,
      bypass: (chatId, sessionId) =>
        runs.describe(runs.resolveKey(chatId, sessionId))?.options.permissionMode ===
        'bypassPermissions',
    };
    registerPhoneSigningGate(app, {
      store: () => phoneSigningStore(),
      machineId: () => machineId(),
      human: humanOnlyDepsFor(),
      sendLoosens: (body) => sendLoosens(body, chat),
      leverLoosens: (route, body) => leverLoosensFor(ctx, route, body),
    });
  };
}
