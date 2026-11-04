import { useMutation } from '@tanstack/react-query';
import type { AdoptDevicesReply } from '@agentdeck/contracts/core/panel-api';
import { adoptDevicesBody, type AdoptSource } from '../model/adopt';
import { pageLoadId } from '../model/command';
import { corePost, fetchNonce } from './coreApi';

/**
 * Перенести ключи телефона в ядро: число этой загрузки страницы от ядра, затем тело с номером
 * машины панели. Суд `human-strict`: окно панели — доверенный пир, чужой процесс сюда не дойдёт.
 */
export async function adoptPhoneKeys(source: AdoptSource): Promise<AdoptDevicesReply> {
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  return corePost<AdoptDevicesReply>('/devices/adopt', adoptDevicesBody(source, nonce, page));
}

export function useAdoptPhoneKeys() {
  return useMutation({ mutationFn: adoptPhoneKeys });
}
