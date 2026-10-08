import { useQueryClient, useMutation } from '@tanstack/react-query';
import { saveToken } from '../lib/saveToken';

/** Сохранить токен профиля. Наружу он больше не вернётся — только маской. */
export function useSaveEndpointToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['endpoints'] }),
  });
}
