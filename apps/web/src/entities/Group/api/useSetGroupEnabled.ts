import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { invalidateGroupMembers } from '../lib/invalidateGroupMembers';
import { toast } from '@shared/lib/toast';

export function useSetGroupEnabled() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (input: { id: string; isEnabled: boolean; provider?: string }) => {
      // `provider` — чей тумблер: без него сервер берёт активный CLI, и щелчок,
      // сделанный до смены CLI, ушёл бы не тому (F1).
      const { data } = await apiClient.post<{
        ok: true;
        affected: number;
        skippedLocalHooks?: number;
      }>(`/groups/${input.id}/enabled`, {
        isEnabled: input.isEnabled,
        ...(input.provider ? { provider: input.provider } : {}),
      });
      return data;
    },
    onSuccess: (data) => {
      invalidateGroupMembers(queryClient);
      // Хук из settings.local.json группе не подчиняется: панель в этот файл не
      // пишет. Молчать об этом нельзя — человек считал бы, что выключил его.
      if (data.skippedLocalHooks)
        toast.warning(t('groups.localHooksSkipped', { count: data.skippedLocalHooks }));
    },
    meta: { successMessage: 'toasts.updated' },
  });
}
