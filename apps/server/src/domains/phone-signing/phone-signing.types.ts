import type { SignatureRefusal } from '@agentdeck/contracts/phone-signing';

/** Привязанный ключ телефона. Отозванный остаётся в списке — видно, что и когда снято. */
export interface StoredSigningDevice {
  /** `deviceIdOf(sha256(publicKey))` — телефон знает его до привязки. */
  id: string;
  label: string;
  /** Открытый ключ Ed25519, 32 байта base64url. */
  publicKey: string;
  boundAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** Одноразовое число, уже принятое: `device:nonce` и срок, после которого его можно забыть. */
export interface SeenNonce {
  n: string;
  exp: number;
}

export interface SigningState {
  version: 1;
  enabled: boolean;
  enabledAt?: string;
  /** Каким устройством включён режим. */
  enabledBy?: string;
  devices: StoredSigningDevice[];
  nonces: SeenNonce[];
  /**
   * Файл есть, но не читается. Режим тогда считается включённым без устройств —
   * испорченный файл не должен молча выключать защиту; выход — удалить файл.
   */
  corrupt?: true;
}

/** Что сверяется: шаблон маршрута, параметры пути, разобранное тело и заголовок подписи. */
export interface SignatureInput {
  route: string;
  params: Record<string, string>;
  body: unknown;
  header: unknown;
}

export interface VerifyContext {
  machineId: string;
  now: number;
  devices: readonly StoredSigningDevice[];
  /**
   * Привязка: ключа ещё нет в списке, подпись проверяется ключом из тела —
   * так телефон доказывает, что закрытый ключ у него.
   */
  bindKey?: string;
}

export type VerifyOutcome =
  { ok: true; deviceId: string; nonce: string } | { ok: false; refusal: SignatureRefusal };
