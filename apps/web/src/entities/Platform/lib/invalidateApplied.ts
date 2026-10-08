import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Сбросить всё, чего касается запись контура в чужие файлы.
 *
 * Список длиннее, чем кажется с первого взгляда, и в этом суть: контур пишет не
 * в свой раздел, а в переменные окружения CLI и в настройки панели (управляемый
 * профиль эндпоинта). Не сбросив их, панель показывала бы состояние ДО записи в
 * трёх разных разделах сразу.
 */
export function invalidateApplied(queryClient: QueryClient, id: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
  void queryClient.invalidateQueries({ queryKey: queryKeys.platformApply(id) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.env });
  void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
  void queryClient.invalidateQueries({ queryKey: queryKeys.history });
  void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
}
