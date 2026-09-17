import { z } from 'zod';
import type {
  PlatformApplyPlan,
  PlatformApplyResult,
  PlatformsInfo,
  PlatformStatus,
} from '@agentdeck/contracts';
import type { PanelPageTarget } from '@agentdeck/contracts/panel-agent';
import {
  PLATFORM_ASSISTANT_TARGET,
  defaultOurRules,
  defaultPlatformRules,
  finishPlan,
  platformIdPattern,
} from '@agentdeck/contracts/platform';
import { PLATFORM_DEFAULT_CONSUMERS } from '@agentdeck/contracts/platform-consumers';
import { PLATFORM_PRESETS, platformDrivers } from '@agentdeck/contracts/platform-presets';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Действия раздела «Контур» (А6). Главное свойство то же, что у маршрутов
 * контура: агент НИКОГДА не видит и не передаёт ключ. Ни одна схема входа не
 * имеет поля ключа, ни один ответ не несёт даже маски — только «ключ есть /
 * принят / отклонён». Ключ вводит человек в поле мастера, которое панель
 * открывает у него на экране после сохранения черновика.
 *
 * Всё исполняется настоящими маршрутами `routes/platform-routes.ts`: сохранение
 * черновика — `PUT /api/platforms/:id` (тем же телом, что шлёт мастер, только
 * без `token`), проба — `POST /api/platforms/:id/check`, включение —
 * `POST /api/platforms/:id/activate`.
 */

/** Якорь поля ключа в мастере контура — окно открывает мастер на шаге ключа. */
export function contourKeyAnchor(id: string): string {
  return `contour-key:${id}`;
}

/** Страница, где человек вводит ключ этого контура. */
export function contourKeyPage(id: string): PanelPageTarget {
  return { route: '/platform', focus: contourKeyAnchor(id) };
}

/**
 * Что агенту известно о ключе. Значения ключа нет и быть не может; маски — тоже:
 * её хвост человеку помогает узнать свой ключ, модели он не нужен ни для чего.
 * - `missing` — ключа нет, его вводит человек;
 * - `saved` — ключ лежит, последняя проба его не подтвердила и не отвергла;
 * - `accepted` — последняя проба с ключом прошла;
 * - `rejected` — последняя проба с ключом получила 401/403.
 */
export type ContourKeyState = 'missing' | 'saved' | 'accepted' | 'rejected';

export function keyStateOf(status: PlatformStatus): ContourKeyState {
  if (!status.hasToken) return 'missing';
  if (status.health?.outcome === 'ok') return 'accepted';
  if (status.health?.outcome === 'unauthorized') return 'rejected';
  return 'saved';
}

/** Карточка контура глазами модели: проекция без маски ключа, каталога и учёта. */
export function contourView(status: PlatformStatus) {
  const { platform, health } = status;
  return {
    id: platform.id,
    title: platform.title,
    driver: platform.driver,
    baseUrl: platform.baseUrl,
    active: status.active,
    consumers: platform.consumers,
    key: keyStateOf(status),
    probe: health
      ? {
          outcome: health.outcome,
          detail: health.detail,
          checkedAt: health.checkedAt,
          models: health.models.length,
          ...(health.lastOkAt ? { lastOkAt: health.lastOkAt } : {}),
        }
      : null,
    ...(status.smoke ? { smoke: { ok: status.smoke.ok, detail: status.smoke.detail } } : {}),
  };
}

const idSchema = z
  .string()
  .trim()
  .regex(platformIdPattern)
  .describe('Contour id from list_contours');

/** Прочитать карточки тем же маршрутом, что и раздел «Контур». */
async function readContours(inject: InjectRoute): Promise<PlatformsInfo> {
  const answer = await inject({ method: 'GET', url: '/api/platforms' });
  if (answer.status >= 400) throw new Error(`GET /api/platforms → HTTP ${answer.status}`);
  return answer.body as PlatformsInfo;
}

function findStatus(info: PlatformsInfo, id: string): PlatformStatus | undefined {
  return info.platforms.find((status) => status.platform.id === id);
}

/** Что применение потребителей сделало: цели записаны / пропущены с причиной. */
export interface ConsumersApplied {
  applied: string[];
  skipped: PlatformApplyResult['skipped'];
}

/**
 * «Готово» мастера для пути агента (D2). Мастер при завершении сохраняет цели,
 * СОБРАННЫЕ из потребителей, и применяет их (`finishPlan` → `POST …/apply`);
 * маршрут активации цели не применяет. Без этого шага агент включал контур с
 * отмеченным «Ассистентом панели», а ассистент оставался на облаке вендора.
 *
 * Цели собираются той же функцией контрактов, что у мастера; занятое место не
 * перезаписывается (`overwrite` пуст) — пропуск возвращается с причиной, и его
 * чинит человек в мастере, увидев, что там стоит.
 */
async function applyConsumers(id: string, inject: InjectRoute): Promise<ConsumersApplied> {
  const status = findStatus(await readContours(inject), id);
  if (!status) throw new Error(`No contour "${id}".`);
  const planAnswer = await inject({
    method: 'GET',
    url: `/api/platforms/${encodeURIComponent(id)}/apply`,
  });
  if (planAnswer.status >= 400) {
    throw new Error(`GET /api/platforms/${id}/apply → HTTP ${planAnswer.status}`);
  }
  const fileTargets = status.platform.targets.filter(
    (target) => target !== PLATFORM_ASSISTANT_TARGET,
  );
  const { platform, applyTargets } = finishPlan(
    status.platform,
    fileTargets,
    (planAnswer.body as PlatformApplyPlan).consumers,
  );
  if (JSON.stringify(platform) !== JSON.stringify(status.platform)) {
    // Без `token`: сохранённый ключ остаётся на месте.
    const saved = await inject({
      method: 'PUT',
      url: `/api/platforms/${encodeURIComponent(id)}`,
      body: { settings: platform },
    });
    if (saved.status >= 400) throw new Error(`PUT /api/platforms/${id} → HTTP ${saved.status}`);
  }
  const answer = await inject({
    method: 'POST',
    url: `/api/platforms/${encodeURIComponent(id)}/apply`,
    body: { targets: applyTargets, overwrite: [] },
  });
  if (answer.status >= 400) {
    throw new Error(`POST /api/platforms/${id}/apply → HTTP ${answer.status}`);
  }
  const result = answer.body as PlatformApplyResult;
  return { applied: result.applied.map((entry) => entry.targetId), skipped: result.skipped };
}

/**
 * Новый контур полностью — маршрут сохранения ждёт все поля, как их шлёт мастер
 * (`entities/Platform newPlatform`): выключенным, только ассистент панели,
 * умолчания прослойки и промпта — от пресета выбранного типа.
 */
function newContour(driver: (typeof platformDrivers)[number]): Record<string, unknown> {
  return {
    enabled: false,
    mode: 'required',
    budgetUsd: 0,
    capabilities: [],
    targets: [],
    consumers: [...PLATFORM_DEFAULT_CONSUMERS],
    projectPaths: [],
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    agents: [],
    budgetSince: '',
    ...PLATFORM_PRESETS[driver].defaults,
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    transport: defaultPlatformTransport(),
  };
}

/** Идентификатор из адреса: хост ссылки, приведённый к шаблону идентификатора. */
export function contourIdFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/[^a-zA-Z0-9._-]/g, '-');
  const id = host.replace(/^[^a-zA-Z0-9]+/, '');
  return id || 'contour';
}

const draftSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), 'http(s) address only')
    .describe('Contour API address from the link the human gave'),
  title: z.string().trim().min(1).max(200).optional().describe('Display name; default = host'),
  driver: z.enum(platformDrivers).optional().describe('Gateway type; default enterprise-platform'),
  id: idSchema.optional().describe('Contour id; default derived from the host'),
  consumers: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe(
      '«Где работает»: consumer ids (assistant, terminal, chat, groups, tests, foreign:<cli>)',
    ),
});
type DraftInput = z.infer<typeof draftSchema>;

interface DraftPlan {
  id: string;
  existing?: PlatformStatus;
  settings: Record<string, unknown>;
}

/**
 * Черновик ровно в той форме, которую запишет маршрут. Существующий контур
 * дополняется, а не перезаписывается: `PUT` меняет контур целиком, и черновик
 * из четырёх полей стёр бы агентов, правила и модели, настроенные человеком.
 *
 * Смена адреса контура, у которого УЖЕ лежит ключ, — отказ до карточки и ещё раз
 * перед записью. Иначе одна подтверждённая строка «адрес» отправила бы живой
 * корпоративный ключ туда, куда указала модель, — ровно то, от чего импорт
 * снимков сбрасывает ключ (`platformsChangingAddress`).
 */
async function planDraft(input: DraftInput, inject: InjectRoute): Promise<DraftPlan> {
  const id = input.id ?? contourIdFromUrl(input.baseUrl);
  const existing = findStatus(await readContours(inject), id);
  const current = existing?.platform;
  if (existing?.hasToken && current && current.baseUrl !== input.baseUrl) {
    throw new Error(
      `Contour "${id}" already has a stored key; changing its address through the agent is refused. ` +
        'The human changes the address in the contour wizard, or pick another id.',
    );
  }
  const driver = input.driver ?? current?.driver ?? 'enterprise-platform';
  const settings: Record<string, unknown> = {
    ...(current ?? newContour(driver)),
    id,
    title: input.title ?? current?.title ?? new URL(input.baseUrl).hostname,
    driver,
    baseUrl: input.baseUrl,
    ...(input.consumers ? { consumers: input.consumers } : {}),
  };
  // Смена типа шлюза у нового контура — как в мастере (`draftWithPatch`):
  // переопределения прежнего пресета новому не принадлежат.
  if (current && settings.driver !== current.driver) delete settings.manifest;
  return { id, ...(existing ? { existing } : {}), settings };
}

const listContours = definePanelAction({
  name: 'list_contours',
  section: 'contour',
  risk: 'read',
  description:
    'List configured model contours: id, address, gateway type, active flag, key state ' +
    '(missing|saved|accepted|rejected — never the key), last probe outcome.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/platforms' }),
  shape: (_input, body) => {
    const info = body as PlatformsInfo;
    return {
      activeContourId: info.activePlatformId,
      contours: info.platforms.map(contourView),
    };
  },
  summary: 'journal-list-contours',
});

const contourStatus = definePanelAction({
  name: 'contour_status',
  section: 'contour',
  risk: 'read',
  description:
    'State of one contour, incl. whether the human saved a key and whether the last probe ' +
    'accepted or rejected it. Use after save_contour_draft returned needs-secret.',
  input: z.object({ id: idSchema }),
  route: () => ({ method: 'GET', url: '/api/platforms' }),
  shape: (input, body) => {
    const status = findStatus(body as PlatformsInfo, input.id);
    return status ? { found: true, ...contourView(status) } : { found: false, id: input.id };
  },
  summary: 'journal-contour-status',
});

const probeContour = definePanelAction({
  name: 'probe_contour_url',
  section: 'contour',
  risk: 'read',
  description:
    'Probe a SAVED contour address now (models list): unreachable | not-api | no-key | ' +
    'unauthorized | not-ready | ok. Save a draft first; a stored key goes only to the stored address.',
  input: z.object({ id: idSchema }),
  route: (input) => ({
    method: 'POST',
    url: `/api/platforms/${encodeURIComponent(input.id)}/check`,
  }),
  // Ответ пробы ключа не содержит; каталог моделей модели не нужен целиком.
  shape: (_input, body) => {
    const probe = body as {
      outcome: string;
      detail?: string;
      url: string;
      models: Array<{ id: string }>;
    };
    return {
      outcome: probe.outcome,
      detail: probe.detail,
      url: probe.url,
      models: probe.models.slice(0, 20).map((model) => model.id),
      modelCount: probe.models.length,
    };
  },
  summary: 'journal-probe-contour',
});

const saveContourDraft = definePanelAction({
  name: 'save_contour_draft',
  section: 'contour',
  risk: 'change',
  title: 'journal-save-contour-draft',
  description:
    'Save a contour draft from a link (address, gateway type, title, where it works). Needs the ' +
    'human’s confirmation. Does NOT enable it. You never receive or send a key: if none is ' +
    'stored, the outcome is needs-secret and the key field opens on the human’s screen.',
  input: draftSchema,
  route: async (input, inject) => {
    const plan = await planDraft(input, inject);
    // Поля `token` в теле нет и не будет: ключ сюда приносит только мастер.
    return {
      method: 'PUT',
      url: `/api/platforms/${encodeURIComponent(plan.id)}`,
      body: { settings: plan.settings },
    };
  },
  // Отпечаток — сохранённая запись контура (и есть ли ключ): черновик собран
  // поверх неё, и правка человека в мастере между карточкой и кликом ушла бы
  // под черновик, которого он в таком виде не видел.
  fingerprint: async (input, inject) => {
    const plan = await planDraft(input, inject);
    return fingerprintOf({
      id: plan.id,
      stored: plan.existing?.platform ?? null,
      hasToken: plan.existing?.hasToken ?? false,
    });
  },
  preview: async (input, inject) => {
    const plan = await planDraft(input, inject);
    const settings = plan.settings;
    const consumers = (settings.consumers as string[] | undefined) ?? [];
    return {
      ...summaryText(
        plan.existing ? 'summary-contour-draft-update' : 'summary-contour-draft-save',
        { title: String(settings.title) },
      ),
      fields: [
        dataField('label-id', plan.id),
        dataField('label-address', String(settings.baseUrl)),
        dataField('label-driver', String(settings.driver)),
        dataField('label-title', String(settings.title)),
        consumers.length
          ? dataField('label-consumers', consumers.join(', '))
          : textField('label-consumers', 'value-consumers-default'),
        textField('label-key', plan.existing?.hasToken ? 'value-key-kept' : 'value-key-by-you'),
        textField('label-enabling', 'value-enabling-separate'),
      ],
    };
  },
  // Правка АКТИВНОГО контура в мастере тоже кончается применением: сменённые
  // потребители иначе остались бы галочками без действия. Неактивный контур не
  // применяется — применение пропустило бы все цели (контур не активен).
  afterRoute: async (_input, body, inject) => {
    const status = body as PlatformStatus;
    if (!status.active) return body;
    return { ...status, consumersApplied: await applyConsumers(status.platform.id, inject) };
  },
  shape: (_input, body) => {
    const status = body as PlatformStatus & { consumersApplied?: ConsumersApplied };
    return {
      saved: true,
      ...contourView(status),
      ...(status.hasToken ? { note: 'ключ сохранён' } : {}),
      ...(status.consumersApplied ? { consumersApplied: status.consumersApplied } : {}),
    };
  },
  // Ключа нет — дальше только человек: поле ключа у него на экране, агенту
  // вернётся лишь `needs-secret`, а «сохранён / принят / отклонён» он узнает
  // через `contour_status`.
  secretStep: (_input, result) => {
    const view = result as { id: string; key: ContourKeyState };
    return view.key === 'missing' ? contourKeyPage(view.id) : undefined;
  },
  page: () => ({ route: '/platform' }),
});

const enableContour = definePanelAction({
  name: 'enable_contour',
  section: 'contour',
  risk: 'danger',
  title: 'journal-enable-contour',
  description:
    'Make a contour ACTIVE: the panel and applied CLIs switch to it, the previous contour is ' +
    'rolled back, then a probe and a smoke request run, then the contour is applied to its ' +
    'consumers (panel assistant; CLI files when Terminal is on) — an occupied place is skipped ' +
    'and named, never overwritten. Needs the human’s confirmation. ' +
    'Refused while no key is stored.',
  input: z.object({ id: idSchema }),
  route: (input) => ({
    method: 'POST',
    url: `/api/platforms/${encodeURIComponent(input.id)}/activate`,
  }),
  // Здоровье пробы в отпечаток не входит: фоновые пробы меняют его сами, а
  // включение всё равно заново пробует контур. Запись, ключ и активный — входят.
  fingerprint: async (input, inject) => {
    const info = await readContours(inject);
    const status = findStatus(info, input.id);
    if (!status) throw new Error(`No contour "${input.id}".`);
    return fingerprintOf({
      platform: status.platform,
      hasToken: status.hasToken,
      active: info.activePlatformId,
    });
  },
  preview: async (input, inject) => {
    const info = await readContours(inject);
    const status = findStatus(info, input.id);
    if (!status) throw new Error(`No contour "${input.id}". Call list_contours.`);
    // Без ключа включать нечего: обязательный контур без ключа отказал бы всем
    // прогонам, а спросить человека о бесполезном включении — пустая карточка.
    if (!status.hasToken) {
      throw new Error(
        `Contour "${input.id}" has no key yet. The human enters it in the contour wizard; check contour_status.`,
      );
    }
    const view = contourView(status);
    const previous = info.activePlatformId;
    return {
      ...summaryText('summary-enable-contour', { title: status.platform.title }),
      fields: [
        dataField('label-address', status.platform.baseUrl),
        previous
          ? dataField('label-active-now', previous)
          : textField('label-active-now', 'value-active-none'),
        view.key === 'accepted'
          ? textField('label-key', 'value-key-accepted')
          : textField('label-key', 'value-key-state', { state: view.key }),
        view.probe
          ? dataField('label-last-probe', view.probe.outcome)
          : textField('label-last-probe', 'value-probe-never'),
        previous
          ? textField('label-what-happens', 'value-happens-rollback', { previous })
          : textField('label-what-happens', 'value-happens-probe'),
        // Включение применяет контур к потребителям (D2) — карточка называет, к каким.
        status.platform.consumers.length
          ? dataField('label-consumers', status.platform.consumers.join(', '))
          : textField('label-consumers', 'value-consumers-default'),
      ],
    };
  },
  afterRoute: async (input, body, inject) => ({
    ...(body as object),
    consumersApplied: await applyConsumers(input.id, inject),
  }),
  shape: (_input, body) => {
    const result = body as {
      activePlatformId: string;
      previousPlatformId: string;
      probe: { outcome: string; detail?: string };
      smoke: { ok: boolean; detail?: string };
      consumersApplied: ConsumersApplied;
    };
    return {
      activeContourId: result.activePlatformId,
      previousContourId: result.previousPlatformId,
      probe: { outcome: result.probe.outcome, detail: result.probe.detail },
      smoke: { ok: result.smoke.ok, detail: result.smoke.detail },
      applied: result.consumersApplied.applied,
      skipped: result.consumersApplied.skipped,
    };
  },
  summary: 'journal-enable-contour',
  page: () => ({ route: '/platform' }),
});

/** Действия раздела «Контур» в порядке показа. */
export const CONTOUR_ACTIONS: readonly AnyPanelAction[] = [
  listContours,
  contourStatus,
  probeContour,
  saveContourDraft,
  enableContour,
];
