import { z } from 'zod';
import { commandProofSchema } from './commands.ts';
import { uuidv7 } from './ids.ts';
import type { CheckRecord, Profile } from './records.ts';
import type { FinalReport } from './report.ts';
import type {
  CredentialKind,
  RouteCaps,
  RouteKind,
  RouteLimit,
  RouteModel,
  RoutePrice,
} from './routes.ts';
import { scenarioSchema, type Scenario, type ScenarioRef } from './scenario.ts';
import type { ReportRef, TaskView } from './task-view.ts';

/**
 * Ручки ядра, которые видит панель (07:3-16, этап 9), — ОДИН список: прокси сервера регистрирует
 * по нему пересылку (`/api/core<path>` → `/v1<path>`), клиент панели строит по нему адреса. Ручка
 * не из списка до ядра через панель не доходит; новая ручка — строка здесь, а не код в прокси.
 */

export const CORE_PANEL_ROUTES = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/tasks' },
  { method: 'GET', path: '/tasks/:id' },
  // Поток событий задачи: прокси не копит тело и передаёт Last-Event-ID (возобновление ленты).
  { method: 'GET', path: '/tasks/:id/events', stream: true },
  { method: 'GET', path: '/tasks/:id/report' },
  { method: 'GET', path: '/routes' },
  { method: 'GET', path: '/profiles/:repoKey' },
  { method: 'GET', path: '/records/:id' },
  { method: 'GET', path: '/scenarios' },
  { method: 'GET', path: '/scenarios/:ref' },
  { method: 'POST', path: '/scenarios' },
  { method: 'POST', path: '/estimate' },
  { method: 'GET', path: '/config' },
  { method: 'POST', path: '/config' },
  { method: 'GET', path: '/nonce' },
  { method: 'POST', path: '/commands' },
  // Перенос привязанных ключей телефона в устройства ядра (G9, F11): строгий суд человека.
  { method: 'POST', path: '/devices/adopt' },
] as const satisfies readonly CorePanelRoute[];

export interface CorePanelRoute {
  method: 'GET' | 'POST';
  /** Путь без префикса: у ядра `/v1<path>`, у панели `/api/core<path>`. */
  path: string;
  stream?: boolean;
}

export const CORE_API_PREFIX = '/v1';
export const PANEL_CORE_PREFIX = '/api/core';

/**
 * Ядро шлёт `: ping` в поток событий задачи с этим шагом (прокси и мобильная сеть рвут молчащее
 * соединение); клиент панели по нему же судит, что поток умер молча. Одно число на обе стороны.
 */
export const SSE_PING_MS = 25_000;

/** Адрес ручки у панели с подставленными параметрами (`:id` → значение, кодируется). */
export function panelCorePath(path: string, params: Record<string, string> = {}): string {
  return (
    PANEL_CORE_PREFIX +
    path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined) throw new Error(`panelCorePath: no value for :${name} in ${path}`);
      return encodeURIComponent(value);
    })
  );
}

// ── Ответы ────────────────────────────────────────────────────────────────────────────

/**
 * Тело отказа любой ручки ядра: `code` машинный, `error` читает человек. Коды ручек этапа 9 —
 * списком: панель различает «нет записи», «отчёт подменён» и «не подключено», а не только статус.
 */
export const CORE_READ_ERROR_CODES = [
  'token-required',
  'not-implemented',
  'bad-id',
  'no-task',
  'no-record',
  'record-unreadable',
  'no-report',
  'report-tampered',
  'report-unreadable',
  'no-profile',
  'profile-unreadable',
  'bad-repo-key',
  'library-unreadable',
  'invalid-ref',
  'not-found',
  'bad-devices',
  'device-id-mismatch',
] as const;
export type CoreReadErrorCode = (typeof CORE_READ_ERROR_CODES)[number];

export interface CoreApiError {
  error: string;
  code: string;
  [extra: string]: unknown;
}

/** Окно маршрута в health (G7): вердикт пары «маршрут × вид предела», о которой есть факт. */
export interface WindowHealthRow {
  routeId: string;
  limitKind: 'window' | 'rate' | 'budget' | 'slot';
  verdict: string;
  resumeAt: number | null;
  usedPct: number | null;
  observedAt: number;
}

/**
 * Звенья пересылки (P131): сколько pid надзор записал и когда. `null` — у загрузки нет канала
 * надзора; `recordedAt: null` — канал есть, но сторож панели ещё ничего не записал. В обоих
 * случаях команда человека через панель у ядра — пир без доверия (нужна подпись устройства).
 */
export interface TrustedHopsHealth {
  count: number;
  recordedAt: number | null;
}

/** `GET /v1/health`. */
export interface HealthReply {
  ok: true;
  build: string;
  bootId: string;
  pid: number;
  startedAt: number;
  home: string;
  uptimeMs: number;
  liveTasks: number;
  queue: { commandsInFlight: number; commandsPending: number };
  window: { routes: WindowHealthRow[] };
  journalLagMs: number;
  trustedHops: TrustedHopsHealth | null;
}

/** Надзор не записал ни одного звена: команды человека через панель ядро не примет без подписи. */
export function hopsUnrecorded(hops: TrustedHopsHealth | null): boolean {
  return hops === null || hops.recordedAt === null || hops.count === 0;
}

/** Строка списка задач (`GET /v1/tasks`): журнал задачи, которой не прочесть, в список не входит. */
export interface TaskListItem {
  taskId: string;
  live: boolean;
  seq: number;
  state: TaskView['state'];
  ended: TaskView['ended'];
  title: string | null;
  /** Задача требует человека: журнал не открылся или сверка упала при загрузке. */
  attention: string | null;
}

export interface TasksReply {
  tasks: TaskListItem[];
}

/** `GET /v1/tasks/:id`: свёртка (сырой вид для отладки), живость и вид для панели. */
export interface TaskReply {
  task: unknown;
  live: boolean;
  view: TaskView;
}

/**
 * Маршрут моделей для панели (`GET /v1/routes`, 11 §Policy): только виды и наличие доступа,
 * значение — никогда (P111). Факт, который ядро не прочитало, — `null`, не догадка.
 */
export interface RouteView {
  id: string;
  kind: RouteKind;
  credential: { kind: CredentialKind; present: boolean } | null;
  /** Возможности маршрута из реестра (диалекты, инструменты, офлайн, привязка) — без доступа. */
  caps: RouteCaps;
  price: RoutePrice | null;
  limit: RouteLimit | null;
  models: RouteModel[] | null;
  /** Исчерпан (402): снимает только человек командой `clear-exhausted` (P122). */
  exhausted: boolean;
}

export interface RoutesReply {
  routes: RouteView[];
}

/** `GET /v1/records/:id`: запись проверки, на которой стоит вердикт (ссылка из ленты). */
export interface RecordReply {
  record: CheckRecord;
}

/** `GET /v1/profiles/:repoKey`: профиль репозитория ядра (04:45-52); нет профиля — 404. */
export interface ProfileReply {
  repoKey: string;
  profile: Profile;
}

/** `GET /v1/tasks/:id/report`: итоговый отчёт по ссылке из вида задачи (тело — артефакт). */
export interface ReportReply {
  taskId: string;
  ref: ReportRef;
  report: FinalReport;
}

/**
 * `POST /v1/scenarios`: новый сценарий в библиотеку — запись однократная (F6), суд полномочий
 * `save-scenario` строгий; доказательство — как у команды.
 */
export const saveScenarioBodySchema = z.strictObject({
  cmdId: uuidv7,
  scenario: scenarioSchema,
  proof: commandProofSchema,
});

export type SaveScenarioBody = z.infer<typeof saveScenarioBodySchema>;

export interface ScenarioSaveReply {
  ref: ScenarioRef;
}

/** `GET /v1/scenarios`: пресеты кода, их последние версии, библиотека человека и её сбои. */
export interface ScenariosReply {
  presets: readonly Scenario[];
  latestPresets: ScenarioRef[];
  library: Scenario[];
  /** Файлы библиотеки, которые не прочлись или не по схеме, — названы, не пропущены молча. */
  problems: { file: string; reason: string }[];
}

/** `GET /v1/scenarios/:ref`: сценарий и откуда он (пресет кода или библиотека человека). */
export interface ScenarioReply {
  scenario: Scenario;
  source: 'preset' | 'library';
}

/**
 * `POST /v1/devices/adopt` (G9, F11): ключи телефона в устройства ядра. Номер устройства обязан
 * выводиться из его ключа (иначе 422 `device-id-mismatch`); класс `adopt-devices` — строгий суд
 * человека, доказательство — как у команды.
 */
export const ADOPT_DEVICES_MAX = 32;
export const adoptDevicesBodySchema = z.strictObject({
  cmdId: uuidv7,
  devices: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[0-9a-f]{16}$/),
        publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        revokedAt: z.string().min(1).optional(),
      }),
    )
    .max(ADOPT_DEVICES_MAX),
  proof: commandProofSchema,
});
export type AdoptDevicesBody = z.infer<typeof adoptDevicesBodySchema>;

export interface AdoptDevicesReply {
  cmdId: string;
  adopted: string[];
  digest: string;
}
