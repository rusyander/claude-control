import { useQueryClient, useMutation } from '@tanstack/react-query';
import { setLocation } from '../lib/setLocation';

export function useSetLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setLocation,
    onSuccess: () => {
      // Смена каталога меняет вообще всё, что показывает приложение.
      void queryClient.invalidateQueries();
    },
    // Тост об успехе — у вызывающего: сервер отвечает 200 и на отказанный путь
    // (`isValid: false` с причиной), а общий `successMessage` хвалил и его.
  });
}
