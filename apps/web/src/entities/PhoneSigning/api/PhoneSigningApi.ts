import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhoneSigningView } from '@agentdeck/contracts/phone-signing';
import { apiClient } from '@shared/api/client';
import { PHONE_SIGNING_KEY, PHONE_SIGNING_REFRESH_MS } from './PhoneSigningApi.constants';

/**
 * Режим «решения только с подписью телефона» со стороны окна панели.
 *
 * Окно только смотрит и отзывает. Привязать ключ, включить и выключить режим
 * можно лишь с телефона: правка фронтенда исполняется в этом же окне, и кнопка
 * «включить» здесь была бы кнопкой, которую нажимает и она. Отзыв свободен —
 * он только ужесточает.
 */

async function getPhoneSigning(): Promise<PhoneSigningView> {
  const { data } = await apiClient.get<PhoneSigningView>('/phone-signing');
  return data;
}

export function usePhoneSigning() {
  return useQuery({
    queryKey: PHONE_SIGNING_KEY,
    queryFn: getPhoneSigning,
    refetchInterval: PHONE_SIGNING_REFRESH_MS,
  });
}

/** Отозвать ключ телефона: ответ — уже новое состояние, кладётся в кэш. */
export function useRevokePhoneKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const { data } = await apiClient.post<PhoneSigningView>(
        `/phone-signing/devices/${encodeURIComponent(deviceId)}/revoke`,
      );
      return data;
    },
    onSuccess: (view) => queryClient.setQueryData(PHONE_SIGNING_KEY, view),
  });
}
