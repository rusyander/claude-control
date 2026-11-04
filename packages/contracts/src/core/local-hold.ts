import { z } from 'zod';

/**
 * Удержание своей модели панелью (этап 10, зона C): кнопки «Запустить»/«Остановить» раздела
 * «Локальные модели» — это `hold`/`release` маршрута `local:own` ядра, а не свой llama-server
 * панели. Слот карты и память карты судит ядро: одна модель на карту, не влезает — отказ без
 * загрузки. Адрес для CLI человека (settings.json, переключатель Claude) — постоянный порт
 * ядра `LOCAL_FRONT_PORT`, а не порт сервера аренды: тот выбирается заново при каждом запуске.
 */

/** Постоянный адрес своей модели для CLI человека; прежде на нём слушал llama-server панели. */
export const LOCAL_FRONT_PORT = 11435;

/** Переменная окружения ядра и панели: другой порт адреса (стенды, тесты); `0` — адреса нет. */
export const LOCAL_FRONT_PORT_ENV = 'AGENTDECK_LOCAL_FRONT_PORT';

/**
 * Порт постоянного адреса по окружению — одно чтение для ядра (где слушать) и панели (куда
 * ходить проба здоровья и переключатель Claude): разойдись они, панель ждала бы чужой порт.
 * Пусто — порт продукта; `0`, не число или вне 1–65535 — адреса нет (`undefined`).
 */
export function localFrontPortOf(env: Record<string, string | undefined>): number | undefined {
  const raw = env[LOCAL_FRONT_PORT_ENV];
  if (raw === undefined || raw.trim() === '') return LOCAL_FRONT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** Ключ пресета llama-server — имя аргумента без дефисов (`ctx-size`, `cache-type-k`). */
const presetKey = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const localHoldModelSchema = z.strictObject({
  /** Имя модели в запросах (`model`), оно же секция пресета. */
  id: z.string().min(1).max(200),
  /** Файл GGUF библиотеки панели; ядро его только читает. */
  path: z.string().min(1).max(4096),
  sizeBytes: z.number().int().positive(),
  contextTokens: z.number().int().positive().optional(),
  /** Аргументы экземпляра модели строками пресета: окно, кеш, выгрузка, шаблон. */
  args: z.record(presetKey, z.string().max(4096)).optional(),
  /**
   * Память карты под этот запуск по раскладке панели (слои + окно + кеш), байт; 0 — сервер
   * раскладывает слои сам (`fit = on`) или считает на процессоре. Нет — файл модели + запас ядра.
   */
  needBytes: z.number().int().nonnegative().optional(),
});
export type LocalHoldModel = z.infer<typeof localHoldModelSchema>;

export const localHoldBodySchema = z.strictObject({
  /** Бинарь сервера моделей (библиотека панели ставит его сама) и окружение запуска. */
  server: z.strictObject({
    command: z.string().min(1).max(4096),
    env: z.record(z.string().min(1).max(200), z.string().max(4096)).optional(),
  }),
  model: localHoldModelSchema,
  /** Запись панели «с чем подняли» — ядро её не читает, а возвращает в виде удержания. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type LocalHoldBody = z.infer<typeof localHoldBodySchema>;

/** Отказы удержания: машинный код в `code` тела ошибки API ядра. */
export const LOCAL_HOLD_REFUSALS = [
  /** Слот карты держит задача ядра: вторая модель на карту не грузится, ждать кнопке нечего. */
  'local_slot_busy',
  /** Память карты не вмещает модель (решение `fit`), либо сервер недоступен. */
  'route_unavailable',
  /** Файла модели нет. */
  'model_absent',
  /** Сервер не поднялся или модель не загрузилась. */
  'local_start_failed',
  /** Токен сеанса: модели дороги к карте нет. */
  'forged-authority',
] as const;
export type LocalHoldRefusal = (typeof LOCAL_HOLD_REFUSALS)[number];

export interface LocalHoldView {
  /** Что удержано сейчас; нет — ничего. */
  held: {
    model: string;
    /** Адрес сервера аренды (меняется при каждом запуске) — только для чтения фактов. */
    origin: string | null;
    pid: number | null;
    since: string;
    meta?: Record<string, unknown>;
  } | null;
  /** Сервер удержания жив по личности и отвечает на пробу здоровья — сейчас. */
  live: boolean;
  /** Постоянный адрес; `null` — выключен (`AGENTDECK_LOCAL_FRONT_PORT=0`). */
  front: { port: number; url: string; listening: boolean } | null;
  /** Подъём умершего сервера удержания не удался: сколько раз, почему, когда снова. */
  failure?: { attempts: number; cause: string; retryAt: string | null };
}

export interface LocalReleaseReply {
  released: boolean;
  verified: { rid: string; fact: string }[];
  leaks: { rid: string; reason: string }[];
}
