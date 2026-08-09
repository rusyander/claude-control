import { object, string, boolean, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Удалённый доступ с телефона: гейт на API, адрес в приватной сети и устройства,
 * которым уходят уведомления.
 *
 * Панель по построению отдаёт секреты и заводит хуки — то есть команды, которые
 * Claude Code выполнит сам. Пока к API дотягивается только петля, этого хватает.
 * Как только адрес открыт наружу (Tailscale Serve), «кто дошёл до порта — тот и
 * хозяин» перестаёт быть приемлемым, поэтому включённый удалённый доступ требует
 * токен на КАЖДОМ запросе, включая свой же интерфейс.
 */

export const pushPlatformSchema = zodEnum(['android', 'ios']);
export type PushPlatform = Infer<typeof pushPlatformSchema>;

/**
 * Устройство, которому шлём уведомления. `token` — Expo push token, выданный
 * сервисом Expo этой установке приложения; он же ключ: переустановка выдаёт
 * новый, а старый молча перестаёт принимать.
 */
export const pushDeviceSchema = object({
  token: string().min(1),
  platform: pushPlatformSchema,
  /** Как устройство называется в списке — человеку, а не коду. */
  label: string().default(''),
  registeredAt: string().default(''),
});

export type PushDevice = Infer<typeof pushDeviceSchema>;

export const remoteAccessSettingsSchema = object({
  /**
   * Требовать `Authorization: Bearer <токен>` на каждом запросе к API. Выключено
   * — поведение прежнее (панель доступна всему, что дотянулось до петли).
   */
  enabled: boolean().default(false),
  /**
   * Адрес, по которому приложение видит API снаружи, — обычно имя машины в
   * tailnet. Панель его не проверяет: она лишь показывает его в QR-коде.
   */
  publicUrl: string().default(''),
  /** Слать push-уведомления о событиях прогонов на зарегистрированные устройства. */
  notify: boolean().default(true),
});

export type RemoteAccessSettings = Infer<typeof remoteAccessSettingsSchema>;

/** Что видно в разделе удалённого доступа. */
export interface RemoteAccessStatus {
  enabled: boolean;
  publicUrl: string;
  notify: boolean;
  /** Токен доступа. Отдаётся только своему интерфейсу — он же его и показывает. */
  token: string;
  devices: PushDevice[];
  /**
   * Адрес, который панель нашла сама через `tailscale status`. Пусто — Tailscale
   * не установлен, не запущен или в нём нет имени для этой машины.
   */
  detectedUrl: string;
  /** Работает ли `tailscale serve` на этой машине прямо сейчас. */
  serveActive: boolean;
}

/** Содержимое QR-кода для спаривания с приложением. */
export interface RemotePairing {
  url: string;
  token: string;
}

/** Событие прогона, о котором уведомляем телефон. */
export type RemoteNotifyKind = 'done' | 'error' | 'permission' | 'question';

export const pushDevicesSchema = array(pushDeviceSchema);
