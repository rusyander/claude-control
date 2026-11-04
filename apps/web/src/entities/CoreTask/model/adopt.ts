import type { AdoptDevicesBody } from '@agentdeck/contracts/core/panel-api';
import { newUuidv7 } from './command';

/** Что переносу нужно из вида подписи телефона (`GET /api/phone-signing`). */
export interface AdoptSource {
  machineId: string;
  devices: readonly { id: string; publicKey: string; revokedAt?: string }[];
}

/**
 * Тело переноса ключей телефона в ядро (G9, этап 10 Q5). Номер машины — ПАНЕЛИ, тот, которым
 * телефон подписывает: ядро принимает его своим, иначе ни одна подпись телефона ядру не годится.
 * Отозванные ключи едут с отметкой отзыва — ядро должно знать, что они сняты, а не забыть о них.
 */
export function adoptDevicesBody(
  source: AdoptSource,
  nonce: string,
  page: string,
  cmdId: string = newUuidv7(),
): AdoptDevicesBody {
  return {
    cmdId,
    machineId: source.machineId,
    devices: source.devices.map((device) => ({
      id: device.id,
      publicKey: device.publicKey,
      ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
    })),
    proof: { nonce, page },
  };
}
