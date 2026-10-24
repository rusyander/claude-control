import type { PhoneSigningView } from '@agentdeck/contracts/phone-signing';

/**
 * Где ключ этого телефона в списке панели. Сверка по открытому ключу целиком,
 * а не только по номеру устройства: номер — короткий хэш, ключ — сама личность.
 *
 * `none` — ключа на телефоне нет; `unbound` — ключ есть, панель его не знает
 * (прошлая привязка не дошла); `revoked` — отозван в панели и второй раз не
 * примется (нужен новый); `bound` — привязан и действует.
 */
export type KeyStanding = 'none' | 'unbound' | 'revoked' | 'bound';

export function keyStanding(
  view: Pick<PhoneSigningView, 'devices'>,
  key: { publicKey: string } | undefined,
): KeyStanding {
  if (!key) return 'none';
  const device = view.devices.find((item) => item.publicKey === key.publicKey);
  if (!device) return 'unbound';
  return device.revokedAt ? 'revoked' : 'bound';
}
