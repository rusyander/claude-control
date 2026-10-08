import type { ProjectTestsView } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';
import { isConflict } from '../../../shared/api/isConflict';

/**
 * Общая часть мутаций библиотеки: ответ сервера — это и есть новый список.
 *
 * Соседние ветки кэша (история, отчёт, тест-поинты) считаются по тем же файлам,
 * поэтому после записи они помечаются устаревшими: иначе отчёт показывал бы
 * покрытие до правки, а список поинтов — кейсы, которых уже нет.
 *
 * `silentError` — отказ показывает сама форма (ловит `mutateAsync`), и общий
 * тост встал бы вторым сообщением о том же.
 */
export function useViewMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
  silentError = false,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    meta: silentError ? { silentError: true } : undefined,
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data);
      void client.invalidateQueries({ queryKey: testKeys.plans(path) });
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
    },
    // 409 — экран устарел: прогон запустили в другом окне, с телефона или
    // агентом панели. Перечитать вид, чтобы стал виден идущий прогон, а не
    // кнопка, которая снова упрётся в тот же отказ.
    onError: (error) => {
      if (isConflict(error)) void client.invalidateQueries({ queryKey: testKeys.view(path) });
    },
  });
}
