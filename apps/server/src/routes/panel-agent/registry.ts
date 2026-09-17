import { createHash } from 'node:crypto';
import { z, type ZodType } from 'zod';
import type {
  PanelAgentPageContext,
  PanelActionDescriptor,
  PanelActionPreview,
  PanelActionRisk,
  PanelPageTarget,
  PanelTextCode,
} from '@agentdeck/contracts/panel-agent';

/** Запрос к маршруту панели, которым действие исполняется. */
export interface ActionRouteRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  /**
   * Маршрут отвечает потоком SSE, который живёт весь прогон (`/api/chat/send`).
   * Исполнитель читает первые кадры до `session`/`done`/`error` и отцепляется —
   * ровно как вкладка, закрытая посреди ответа: прогон в реестре идёт дальше.
   * Ждать конца потока значило бы держать вызов агента часами.
   */
  stream?: true;
}

/** Кадры потока, прочитанные до отцепления. */
export interface StreamHead {
  frames: Array<Record<string, unknown>>;
  /** Отцепились по сроку, не дождавшись кадра сессии. */
  timedOut: boolean;
}

/** Ответ маршрута: статус и разобранное тело (JSON, иначе текст). */
export interface RouteAnswer {
  status: number;
  body: unknown;
}

/** Вызов маршрута панели изнутри процесса — тем же путём, что и из окна. */
export type InjectRoute = (request: ActionRouteRequest) => Promise<RouteAnswer>;

/** Что доступно действию без маршрута API (навигация, статичные списки). */
export interface LocalActionEnv {
  /** Сколько окон панели подписано на поток событий прямо сейчас. */
  windows: () => number;
  /**
   * Где человек был, когда начался ход этого разговора (файл разговора). Нет
   * разговора — `undefined`: переходник записан руками в чужой конфиг.
   */
  pageContext: () => PanelAgentPageContext | undefined;
}

/**
 * Описание действия — ОДНО на всю панель. Отсюда собираются инструменты
 * переходника, карточка подтверждения и след.
 *
 * Исполняется действие ровно одним из двух способов:
 * - `route` — маршрут API, который зовёт интерфейс. Второй реализации поведения
 *   здесь нет и быть не должно: та же проверка тела, тот же гейт доступа;
 * - `local` — только то, у чего маршрута нет по природе: статичный список
 *   разделов и открытие страницы (это кадр в поток, а не поведение домена).
 */
export interface PanelActionDefinition<I> {
  /** snake_case — имя инструмента MCP. */
  name: string;
  section: string;
  risk: PanelActionRisk;
  /** Для модели: английское и короткое, читается каждый ход. */
  description: string;
  input: ZodType<I>;
  /**
   * Запрос к маршруту. `inject` — для значения, которое интерфейс подставляет
   * сам из настроек (модель чата по умолчанию): читается в момент выполнения,
   * тем же маршрутом чтения, что и у окна.
   */
  route?: (input: I, inject: InjectRoute) => ActionRouteRequest | Promise<ActionRouteRequest>;
  /**
   * Что из УСПЕШНОГО ответа маршрута отдать модели. Только проекция: вид раздела
   * тестов весит десятки килобайт, а модель читает его каждый ход. Отказ
   * маршрута идёт мимо — его текст нужен как есть.
   */
  shape?: (input: I, body: unknown) => unknown;
  /**
   * Маршрут ответил 2xx, но сообщает отказ в теле (плагины: вызов CLI отвечает
   * `{ ok: false, error }`, как и ждёт форма). Вернула текст — исход `failed` с
   * этим текстом: модель не должна рассказывать «установлено» про отказ.
   */
  refusal?: (body: unknown) => string | undefined;
  /**
   * Второй шаг после УСПЕШНОГО маршрута — тоже маршрутами окна, тем же `inject`
   * (включение контура применяет цели ровно как мастер после активации). Отказ
   * второго шага — исключение с текстом: исход `failed`, первый шаг уже
   * выполнен, и текст обязан это назвать. Вернула значение — оно заменяет тело
   * ответа для `shape`.
   */
  afterRoute?: (input: I, body: unknown, inject: InjectRoute) => Promise<unknown>;
  local?: (input: I, env: LocalActionEnv) => unknown;
  /**
   * Карточка подтверждения для `change`/`danger`. Может сходить в маршрут
   * чтения (`inject`), чтобы показать настоящее состояние, а не догадку.
   */
  preview?: (input: I, inject: InjectRoute) => PanelActionPreview | Promise<PanelActionPreview>;
  /**
   * Отпечаток состояния, из которого посчитана карточка (байты файла, запись
   * контура, файл группы, настройки прогона). Считается при создании карточки и
   * ещё раз прямо перед исполнением: между показом и кликом цель мог поменять
   * человек в интерфейсе или сам Claude Code, и одобрение записало бы то, чего
   * человек не видел. Не совпал (или цель уже не читается) — исход `failed` с
   * кодом `stale_preview`, ничего не выполняется. Значение живёт только в памяти
   * процесса и никуда не отдаётся: в нём бывают секреты — сворачивать через
   * `fingerprintOf`.
   */
  fingerprint?: (input: I, inject: InjectRoute) => string | Promise<string>;
  /**
   * Строка следа для чтения (код текста); без неё — имя действия. Входа здесь нет намеренно:
   * строка из входа модели (адрес, имя, шаблон права) легла бы в след, который
   * читают глазами и переносят между машинами.
   */
  summary?: PanelTextCode;
  /**
   * Название правки для следа (`change`/`danger`) кодом текста и без входа:
   * сводка карточки собрана из строк модели и в след не идёт. Нет — имя действия.
   */
  title?: PanelTextCode;
  /** Какую страницу открыть у человека после выполнения. */
  page?: (input: I, result: unknown) => PanelPageTarget | undefined;
  /**
   * Дальше нужен секрет, который вводит только человек. Вернула страницу —
   * исход `needs-secret`, у человека открывается именно она (вместо `page`), а
   * агенту уходит проекция без секрета. `result` — уже после `shape`.
   */
  secretStep?: (input: I, result: unknown) => PanelPageTarget | undefined;
}

/** Действие со стёртым типом входа — так их держит реестр. */
export type AnyPanelAction = PanelActionDefinition<unknown>;

/**
 * Хеш значения с упорядоченными ключами: два чтения одного состояния дают один
 * отпечаток, даже если маршрут собрал объект в другом порядке полей.
 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Объявить действие. Ошибка описания — исключение при загрузке модуля, а не
 * отказ в разговоре: действие без исполнителя или с двумя исполнителями
 * обнаружится первым же тестом, а не агентом на экране владельца.
 */
export function definePanelAction<I>(definition: PanelActionDefinition<I>): AnyPanelAction {
  if (!NAME_PATTERN.test(definition.name)) {
    throw new Error(`Имя действия «${definition.name}» не snake_case`);
  }
  if (Boolean(definition.route) === Boolean(definition.local)) {
    throw new Error(`Действие «${definition.name}»: нужен ровно один из route/local`);
  }
  return definition as unknown as AnyPanelAction;
}

/** Описание для модели и окна: схема входа уходит JSON Schema из той же zod-схемы. */
export function describeAction(action: AnyPanelAction): PanelActionDescriptor {
  return {
    name: action.name,
    section: action.section,
    risk: action.risk,
    description: action.description,
    inputSchema: z.toJSONSchema(action.input, { io: 'input' }) as Record<string, unknown>,
  };
}
