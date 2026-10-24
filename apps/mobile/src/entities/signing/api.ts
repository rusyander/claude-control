import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  PhoneSigningBindBody,
  PhoneSigningModeBody,
  PhoneSigningView,
} from '@agentdeck/contracts/phone-signing';
import { ApiError, api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';
import { createKey, forgetKey, freshNonce, loadKey } from '../../shared/api/signing/keyStore';
import { signatureHeaders } from '../../shared/api/signing/signatureHeaders';
import { devicesHashOf, type PhoneKey } from '../../shared/api/signing/signing';
import { keyStanding } from './keyStanding';

/**
 * Режим подписи решений на выбранном компьютере: список ключей, привязка
 * этого телефона, включение и выключение.
 *
 * Привязка и режим подписываются ЯВНО — номером машины из ответа панели, а не
 * из записи телефона: запись старой пары может ещё не знать номера, а подпись
 * для другого номера сервер не примет.
 */

const VIEW_KEY = ['phone-signing'] as const;
const KEY_KEY = ['phone-signing-key'] as const;
const BIND_PATH = '/phone-signing/devices';
const MODE_PATH = '/phone-signing/mode';

export function useSigning(): UseQueryResult<PhoneSigningView> {
  return useQuery({
    queryKey: VIEW_KEY,
    queryFn: () => api.get<PhoneSigningView>('/phone-signing'),
    staleTime: 10_000,
    enabled: isConfigured(),
  });
}

/** Ключ этого телефона для машины; `null` — ключа нет. */
export function useMyKey(machineId: string | undefined): UseQueryResult<PhoneKey | null> {
  return useQuery({
    queryKey: [...KEY_KEY, machineId ?? ''],
    queryFn: async () => (machineId ? ((await loadKey(machineId)) ?? null) : null),
    enabled: Boolean(machineId),
  });
}

/** Подпись запроса заданным ключом для заданной машины. */
function signedBy(
  panel: string,
  key: PhoneKey,
  path: string,
  body: unknown,
): Promise<Record<string, string>> {
  return signatureHeaders('POST', path, body, {
    machineId: () => panel,
    key: async () => key,
    nonce: freshNonce,
    now: Date.now,
  });
}

async function postBind(panel: string, key: PhoneKey, label: string): Promise<PhoneSigningView> {
  const body: PhoneSigningBindBody = { label, publicKey: key.publicKey };
  // Подпись самим привязываемым ключом — доказательство, что закрытый ключ у телефона.
  const headers = await signedBy(panel, key, BIND_PATH, body);
  return api.post<PhoneSigningView>(BIND_PATH, body, { headers });
}

function useRefresh(): (view?: PhoneSigningView) => void {
  const client = useQueryClient();
  return (view) => {
    if (view) client.setQueryData(VIEW_KEY, view);
    void client.invalidateQueries({ queryKey: VIEW_KEY });
    void client.invalidateQueries({ queryKey: KEY_KEY });
  };
}

export function useBindPhone(): ReturnType<
  typeof useMutation<PhoneSigningView, Error, { view: PhoneSigningView; label: string }>
> {
  const refresh = useRefresh();
  return useMutation<PhoneSigningView, Error, { view: PhoneSigningView; label: string }>({
    mutationFn: async ({ view, label }) => {
      const panel = view.machineId;
      const existing = await loadKey(panel);
      const standing = keyStanding(view, existing);
      if (standing === 'bound') return view;
      // Ключ, который панель не знает, привязываем как есть; отозванный она
      // второй раз не примет — тогда новый.
      const key = existing && standing === 'unbound' ? existing : await createKey(panel);
      try {
        return await postBind(panel, key, label);
      } catch (error) {
        // Список на экране отстал: ключ отозвали после загрузки. Один раз — новым.
        if (!(error instanceof ApiError) || error.code !== 'phone_signing_key_revoked') throw error;
        return postBind(panel, await createKey(panel), label);
      }
    },
    onSuccess: (view) => refresh(view),
    onError: () => refresh(),
  });
}

/**
 * Включение несёт хэш набора ключей, ПОКАЗАННОГО человеку: панель не включит
 * режим, если с тех пор привязали ещё один.
 */
export function useSigningMode(): ReturnType<
  typeof useMutation<PhoneSigningView, Error, { view: PhoneSigningView; enabled: boolean }>
> {
  const refresh = useRefresh();
  return useMutation<PhoneSigningView, Error, { view: PhoneSigningView; enabled: boolean }>({
    mutationFn: async ({ view, enabled }) => {
      const key = await loadKey(view.machineId);
      const body: PhoneSigningModeBody = enabled
        ? { enabled, devicesHash: devicesHashOf(view.devices) }
        : { enabled };
      const headers = key ? await signedBy(view.machineId, key, MODE_PATH, body) : {};
      return api.post<PhoneSigningView>(MODE_PATH, body, { headers });
    },
    onSuccess: (view) => refresh(view),
    onError: () => refresh(),
  });
}

/** Отвязать этот телефон: ключ отзывается в панели и стирается с телефона. */
export function useUnbindPhone(): ReturnType<
  typeof useMutation<void, Error, { view: PhoneSigningView; key: PhoneKey }>
> {
  const refresh = useRefresh();
  return useMutation<void, Error, { view: PhoneSigningView; key: PhoneKey }>({
    mutationFn: async ({ view, key }) => {
      try {
        await api.post(`${BIND_PATH}/${encodeURIComponent(key.deviceId)}/revoke`);
      } catch (error) {
        // Панель такого ключа не знает — стереть его здесь всё равно нужно.
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      await forgetKey(view.machineId);
    },
    onSettled: () => refresh(),
  });
}
