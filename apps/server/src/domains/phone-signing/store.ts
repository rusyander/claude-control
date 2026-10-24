import { existsSync, readFileSync, statSync } from 'node:fs';
import { SIGNATURE_NONCE_TTL_MS } from '@agentdeck/contracts/phone-signing';
import { writeSecretFile } from '../../lib/credentials/credentials.ts';
import type { SeenNonce, SigningState, StoredSigningDevice } from './phone-signing.types.ts';

/**
 * Режим подписи и ключи телефонов — отдельным файлом `~/.agentdeck/phone-signing.json`
 * рядом с токеном API, а не в `state.json`: настройки панель экспортирует и
 * переносит на другую машину, и ключи с режимом уехали бы вместе с ними. Запись —
 * `writeSecretFile` (0600, без подмены ссылкой), как у токена.
 *
 * Файл перечитывается на каждой проверке, но с диска — только когда сменились
 * время правки или размер: так удалённый руками файл (это и есть восстановление
 * без телефона) действует сразу, без перезапуска панели.
 *
 * Одноразовые числа живут в том же файле: перезапуск панели не должен открывать
 * повтор подписи, принятой минуту назад.
 */

const EMPTY: SigningState = { version: 1, enabled: false, devices: [], nonces: [] };

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function deviceOf(raw: unknown): StoredSigningDevice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  if (!isText(item.id) || !isText(item.publicKey) || !isText(item.boundAt)) return undefined;
  return {
    id: item.id,
    label: typeof item.label === 'string' ? item.label : '',
    publicKey: item.publicKey,
    boundAt: item.boundAt,
    ...(isText(item.revokedAt) ? { revokedAt: item.revokedAt } : {}),
    ...(isText(item.lastUsedAt) ? { lastUsedAt: item.lastUsedAt } : {}),
  };
}

/** Разбор файла. Не та форма — «включено, устройств нет»: защита не выключается порчей. */
export function parseSigningState(text: string): SigningState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY, enabled: true, devices: [], nonces: [], corrupt: true };
  }
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean') {
    return { ...EMPTY, enabled: true, devices: [], nonces: [], corrupt: true };
  }
  const devices = Array.isArray(value.devices)
    ? value.devices.map(deviceOf).filter((item): item is StoredSigningDevice => Boolean(item))
    : [];
  const nonces = Array.isArray(value.nonces)
    ? value.nonces.filter(
        (item): item is SeenNonce =>
          Boolean(item) &&
          typeof item === 'object' &&
          isText((item as SeenNonce).n) &&
          typeof (item as SeenNonce).exp === 'number',
      )
    : [];
  return {
    version: 1,
    enabled: value.enabled,
    ...(isText(value.enabledAt) ? { enabledAt: value.enabledAt } : {}),
    ...(isText(value.enabledBy) ? { enabledBy: value.enabledBy } : {}),
    devices,
    nonces,
  };
}

export const activeDevices = (state: SigningState): StoredSigningDevice[] =>
  state.devices.filter((device) => !device.revokedAt);

export type BindResult = 'bound' | 'enabled' | 'exists' | 'revoked';
export type ModeResult = 'ok' | 'devices-changed';

export class PhoneSigningStore {
  private cache: { stamp: string; state: SigningState } | undefined;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private stamp(): string | undefined {
    try {
      const stat = statSync(this.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  read(): SigningState {
    const stamp = this.stamp();
    if (!stamp || !existsSync(this.path)) {
      this.cache = undefined;
      return structuredClone(EMPTY);
    }
    if (this.cache?.stamp !== stamp) {
      this.cache = { stamp, state: parseSigningState(readFileSync(this.path, 'utf8')) };
    }
    return structuredClone(this.cache.state);
  }

  private write(state: SigningState): void {
    const { corrupt: _corrupt, ...clean } = state;
    writeSecretFile(this.path, `${JSON.stringify(clean, null, 2)}\n`);
    this.cache = undefined;
  }

  /** Привязать ключ. Пока режим включён — нельзя: иначе правка окна добавила бы свой ключ. */
  bind(device: StoredSigningDevice): BindResult {
    const state = this.read();
    if (state.enabled) return 'enabled';
    const known = state.devices.find((item) => item.id === device.id);
    // Отозванный ключ мог уйти вместе с телефоном: привязка его же «снимала» бы
    // отзыв. Телефон в ответ создаёт новый ключ.
    if (known?.revokedAt) return 'revoked';
    if (known) return 'exists';
    state.devices = [...state.devices, device];
    this.write(state);
    return 'bound';
  }

  /** Отозвать ключ. Свободно в любом режиме: отзыв только ужесточает. */
  revoke(id: string, now: Date): boolean {
    const state = this.read();
    const device = state.devices.find((item) => item.id === id);
    if (!device || state.corrupt) return false;
    if (!device.revokedAt) device.revokedAt = now.toISOString();
    this.write(state);
    return true;
  }

  setMode(enabled: boolean, deviceId: string, now: Date): void {
    const state = this.read();
    state.enabled = enabled;
    if (enabled) {
      state.enabledAt = now.toISOString();
      state.enabledBy = deviceId;
    } else {
      delete state.enabledAt;
      delete state.enabledBy;
    }
    this.write(state);
  }

  /**
   * Принять одноразовое число. Уже было — `false`, и решение не проходит; иначе
   * число запоминается на `SIGNATURE_NONCE_TTL_MS` (дольше окна часов), а у
   * устройства отмечается последнее использование.
   */
  consumeNonce(deviceId: string, nonce: string, now: number): boolean {
    const state = this.read();
    const key = `${deviceId}:${nonce}`;
    const live = state.nonces.filter((item) => item.exp > now);
    if (live.some((item) => item.n === key)) return false;
    live.push({ n: key, exp: now + SIGNATURE_NONCE_TTL_MS });
    state.nonces = live;
    const device = state.devices.find((item) => item.id === deviceId);
    if (device) device.lastUsedAt = new Date(now).toISOString();
    this.write(state);
    return true;
  }
}
