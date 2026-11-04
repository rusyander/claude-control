import type { KeyRef } from '@agentdeck/contracts/core/routes';
import type {
  HopHostLaunch,
  HopPortSubstitution,
  HopRegistration,
} from '@agentdeck/contracts/core/hops';

/**
 * Типы хоста звеньев (11 §Hop chain, план §2 H): отдельный процесс ядра, который держит DLP-звено
 * и шлюз, переживает ядро и панель и один на дом ядра.
 */

/** Настройка процесса хоста — контракт `HopHostLaunch` (один аргумент base64url JSON). */
export type HopHostConfig = HopHostLaunch;

/** Порты трёх слушателей хоста на loopback. */
export interface HopPorts {
  control: number;
  dlp: number;
  gateway: number;
}

/** Порт, который не удалось вернуть после перезапуска: записанный → новый (P46 журналит вызывающий). */
export type PortSubstitution = HopPortSubstitution;

/** Сеанс, известный звену. Заглушка ключа хранится только хэшем (P112). */
export interface TagEntry {
  /** Регистрация после разбора схемой: значения по умолчанию проставлены. */
  spec: HopRegistration;
  placeholderHash: string;
  registeredAt: number;
  /** Раздел панели из адреса шлюза человека (`/_s/<раздел>`) — в след запроса. */
  section?: string;
  /** Название контура для текстов отказа (шлюз человека); нет — `routeId`. */
  title?: string;
  /** Метка прогона из адреса шлюза человека (`/_run/<метка>`) — в след запроса контура. */
  runTag?: string;
}

/** Исход чтения ключа маршрута: значение уходит только в заголовок запроса наверх. */
export type KeyRead = { value: string } | { absent: true } | { unknown: string };

/** Откуда звено берёт ключ по ссылке; подменяется в тестах. */
export interface KeySource {
  resolve(ref: KeyRef): KeyRead;
}

/** Строка следа звена (`<home>/hops/trace.jsonl`): без тел, без ключей, без заглушек. */
export interface HopTraceEntry {
  at: number;
  tag: string;
  routeId: string;
  hop: 'dlp' | 'gateway' | 'control';
  path: string;
  status: number;
  /** Код отказа звена или вендора (`dlp_opaque`, `billing_error`, …). */
  code?: string;
  /** Названия сработавших проверок контура (451) — имена, не текст. */
  violations?: string[];
  masked?: boolean;
  lost?: string[];
  tokens?: number;
  retried?: boolean;
  error?: string;
  /** Раздел панели, от которого пришёл запрос шлюза человека (`chat`, `foreign:codex`). */
  section?: string;
  /** Ручка картинок: размер картинок ответа в байтах — только число, ни байта самой картинки. */
  imageBytes?: number;
  /** Ответ ушёл, а расхода ручка не прислала: ноль в `tokens` — «не отчиталась», не «бесплатно». */
  usageUnreported?: true;
}
