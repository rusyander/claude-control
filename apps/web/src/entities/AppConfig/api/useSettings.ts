import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getSettings } from '../lib/getSettings';
import { readSettings } from '../lib/sendSettingsPatch';

export function useSettings() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.settings,
    // Перечитывание по фокусу окна не откатывает правки, ещё идущие на сервер.
    queryFn: async () => (await readSettings(queryClient, getSettings)).settings,
  });
}
