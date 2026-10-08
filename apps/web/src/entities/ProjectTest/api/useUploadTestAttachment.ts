import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Вложение к кейсу: файл уезжает base64 внутри обычного JSON.
 *
 * Multipart здесь не нужен и вреден: доказательство — это скриншот на пару
 * сотен килобайт, а отдельный разбор форм на сервере пришлось бы держать ради
 * одного маршрута. Ответ — путь файла от корня проекта, его и кладут в кейс.
 */
export function useUploadTestAttachment(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: { caseId: string; name: string; contentBase64: string }) => {
      const { data } = await apiClient.post<{ file: string }>('/project-tests/attachment', {
        path,
        ...payload,
      });
      return data.file;
    },
  });
}
