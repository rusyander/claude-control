import { object, string, number, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Фоновый наблюдатель панели: пока тумблер в настройках включён, панель
 * собирает ВСЕ свои проблемы — сервера (5xx, 4xx из-за ошибки своего же
 * интерфейса, предупреждения и ошибки журнала, медленные ответы, упавшие и
 * завершившиеся с ошибкой запуски CLI) и страницы (ошибки, отказы промисов,
 * падения отрисовки, предупреждения и ошибки консоли, неудавшиеся запросы,
 * ответ не того вида, зависшая загрузка) — и отдаёт их дешёвой модели. Она
 * сверяет каждую с исходным кодом панели, дописывает замечания о рядом
 * найденных дефектах и пишет всё в отчёт `WATCH-REPORT.md` в корне
 * приложения: его читает человек или другой агент, который будет чинить.
 *
 * Модуль самодостаточный (только zod): сервер берёт схемы по подпути
 * `@agentdeck/contracts/watcher` — zod-ЗНАЧЕНИЯ из барреля в Node не резолвятся.
 */

/**
 * Откуда пришёл сигнал: сама панель (сервер), её страница в браузере,
 * модель (замечание, найденное при сверке с кодом) или человек, описавший
 * баг своими словами.
 */
export const WATCH_SIGNAL_SOURCES = ['server', 'client', 'model', 'user'] as const;
export type WatchSignalSource = (typeof WATCH_SIGNAL_SOURCES)[number];

/**
 * Вид сигнала. Список закрытый: по нему отчёт подписывает раздел, а модель
 * понимает, где искать причину.
 */
export const WATCH_SIGNAL_KINDS = [
  /** Ответ сервера 5xx. */
  'http-5xx',
  /** Запись уровня error в журнале сервера. */
  'log-error',
  /** Необработанное исключение или отказ промиса в процессе сервера. */
  'process-crash',
  /** CLI не запустился (нет в PATH, отказ оболочки). */
  'spawn-failed',
  /** `window.onerror` на странице. */
  'window-error',
  /** Необработанный отказ промиса на странице. */
  'unhandled-rejection',
  /** Падение отрисовки, пойманное границей ошибок React. */
  'render-crash',
  /** Запрос страницы к API, которого сервер не видел: обрыв сети, 5xx прокси. */
  'api-failure',
  /** Ответ 4xx, который значит ошибку своего же интерфейса: 400/422, 404 без маршрута, 409 по кругу. */
  'http-4xx',
  /** Запись уровня warn в журнале сервера. */
  'log-warn',
  /** Ответ сервера дольше порога. */
  'slow-request',
  /** CLI запустился и завершился с ненулевым кодом (сюда же — ошибки провайдера). */
  'cli-exit',
  /** `console.error` на странице (в том числе ошибки React). */
  'console-error',
  /** `console.warn` на странице (в том числе предупреждения React). */
  'console-warn',
  /** Ответ API не того вида: HTML или текст вместо JSON. */
  'contract-mismatch',
  /** Загрузка на странице дольше порога. */
  'stuck-loading',
  /** Замечание модели: дефект логики рядом со сбоем, найденный при сверке. */
  'remark',
  /**
   * Баг, описанный человеком в окне наблюдателя. В отчёт ложится, только если
   * модель подтвердила его по коду: неподтверждённая жалоба — не находка.
   */
  'user-report',
] as const;
export type WatchSignalKind = (typeof WATCH_SIGNAL_KINDS)[number];

/** Сигналы, которые шлёт страница. */
export const WATCH_CLIENT_SIGNAL_KINDS = [
  'window-error',
  'unhandled-rejection',
  'render-crash',
  'api-failure',
  'console-error',
  'console-warn',
  'contract-mismatch',
  'stuck-loading',
] as const;

/** Раздел отчёта — сбой (что-то сломалось на деле) или замечание модели. */
export const WATCH_ENTRY_CLASSES = ['failure', 'remark'] as const;
export type WatchEntryClass = (typeof WATCH_ENTRY_CLASSES)[number];

/** Важность раздела; до разбора — по виду сигнала, после — слово модели. */
export const WATCH_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type WatchSeverity = (typeof WATCH_SEVERITIES)[number];

/**
 * Заголовок ответа сервера: этот сбой уже записан сервером. Страница по нему
 * не шлёт тот же сбой второй раз — иначе один отказ считался бы дважды.
 */
export const WATCH_SEEN_HEADER = 'x-agentdeck-watch';

/** Сигнал со страницы: тело `POST /api/watcher/events`. Потолки — против мусора. */
export const watchClientSignalSchema = object({
  kind: zodEnum(WATCH_CLIENT_SIGNAL_KINDS),
  message: string().min(1).max(2000),
  /** Стек или стопка компонентов — первые строки хватает на поиск по коду. */
  stack: string().max(8000).optional(),
  /** Маршрут страницы (`/settings`), не полный адрес. */
  route: string().max(300).optional(),
  /** Для `api-failure`: метод, путь запроса и статус (0 — сеть). */
  method: string().max(10).optional(),
  path: string().max(500).optional(),
  status: number().int().min(0).max(999).optional(),
  /** Для `stuck-loading`: сколько уже длится загрузка. */
  durationMs: number().int().min(0).max(86_400_000).optional(),
});
export type WatchClientSignal = Infer<typeof watchClientSignalSchema>;

/** Тело `POST /api/watcher/reports`: баг словами человека и где он его видел. */
export const watchUserReportSchema = object({
  text: string().trim().min(3).max(4000),
  /** Маршрут страницы, с которой отправили, — подсказка модели, где искать. */
  route: string().max(300).optional(),
});
export type WatchUserReport = Infer<typeof watchUserReportSchema>;

/**
 * Проверка бага, присланного человеком: `checking` — ждёт модели;
 * `confirmed` — дефект есть, раздел `ref` лежит в отчёте; `rejected` — по коду
 * дефекта нет; `unclear` — модель не решила; `failed` — разбор не удался.
 * В отчёт попадает только `confirmed`.
 */
export const WATCH_USER_CHECK_STATES = [
  'checking',
  'confirmed',
  'rejected',
  'unclear',
  'failed',
] as const;
export type WatchUserCheckState = (typeof WATCH_USER_CHECK_STATES)[number];

export interface WatchUserCheck {
  /** Отпечаток сигнала — тот же id, что у раздела отчёта, если его подтвердят. */
  id: string;
  text: string;
  route?: string;
  at: string;
  state: WatchUserCheckState;
  /** `WR-n` подтверждённого раздела. */
  ref?: string;
  /** Заголовок, который дала модель. */
  title?: string;
  /** Почему так решила модель или почему разбор не удался — на языке панели. */
  reason?: string;
}

/** Тело `POST /api/watcher`: включить или выключить. */
export const watcherToggleBodySchema = object({ enabled: boolean() });
export type WatcherToggleBody = Infer<typeof watcherToggleBodySchema>;

/** Вердикт модели по одной находке. */
export const WATCH_VERDICTS = ['confirmed', 'not-in-code', 'unclear', 'pending'] as const;
export type WatchVerdict = (typeof WATCH_VERDICTS)[number];

/** Токены, потраченные наблюдателем с момента включения. */
export interface WatcherSpend {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Сколько раз модель вызывалась. */
  runs: number;
  /**
   * Оценка по тарифам API — не счёт: при подписке токены деньгами не
   * списываются. Нет — модель не нашлась в прайсе.
   */
  estimatedUsd?: number;
}

/** Почему наблюдатель не может сделать свою работу. */
export const WATCHER_PROBLEM_CODES = [
  'cli_missing',
  'report_unwritable',
  'analysis_failed',
  /** Потолок разборов в час достигнут: сбои пишутся, разбор — со следующим часом. */
  'hourly_cap',
  /**
   * Маршрут разбора отказал: активен чужой CLI, свой эндпоинт ассистента или
   * контур недоступен. Причина на языке панели — в `detail`.
   */
  'route_refused',
] as const;
export type WatcherProblemCode = (typeof WATCHER_PROBLEM_CODES)[number];

export interface WatcherProblem {
  /** Код текста: клиент переводит его своим словарём (`watcher.problem.<код>`). */
  problemCode: WatcherProblemCode;
  /** Русская фраза сервера — запасной текст для клиента, не знающего кода. */
  message: string;
  /** Сырая причина (вывод CLI, ошибка файловой системы) — как есть, без перевода. */
  detail?: string;
  at: string;
}

export interface WatcherThresholds {
  /** Ответ сервера дольше — сигнал `slow-request`. */
  slowRequestMs: number;
  /** Загрузка на странице дольше — сигнал `stuck-loading`. */
  stuckLoadingMs: number;
}

/** Ответ `GET /api/watcher` и обоих `POST`. */
export interface WatcherStatus {
  enabled: boolean;
  /** Когда тумблер включили (ISO); время работы считается от него. */
  since?: string;
  /** Время сервера на момент ответа — клиент считает длительность от него, а не от своих часов. */
  serverNow: string;
  /** Идёт ли сейчас разбор (живой процесс CLI). */
  analyzing: boolean;
  /** Сигналов, ещё не отданных модели. */
  pending: number;
  /** Разделов в отчёте — сбоев и замечаний вместе. */
  findings: number;
  /** Из них замечаний модели. */
  remarks: number;
  /** Пороги, по которым страница и сервер считают «медленно» и «зависло». */
  thresholds: WatcherThresholds;
  /** Потолок разборов в час и сколько потрачено в текущем часе. */
  hourlyCap: { limit: number; used: number };
  spend: WatcherSpend;
  /** Абсолютный путь отчёта — его человек и пересылает. */
  reportPath: string;
  problem?: WatcherProblem;
  /** Баги, присланные человеком, — свежие первыми, не больше десяти. */
  checks?: WatchUserCheck[];
}

/** Раздел отчёта для страницы: метка раздела и его текст в Markdown. */
export interface WatchReportSection {
  id: string;
  ref: string;
  entryClass: WatchEntryClass;
  severity: WatchSeverity;
  verdict: WatchVerdict;
  count: number;
  first: string;
  last: string;
  title: string;
  location?: string;
  /** Тело раздела без заголовка и меток — Markdown как в файле. */
  body: string;
}

/** Ответ `GET /api/watcher/report`. */
export interface WatchReportView {
  path: string;
  exists: boolean;
  /** Когда файл менялся последний раз (ISO). */
  updatedAt?: string;
  sections: WatchReportSection[];
}
