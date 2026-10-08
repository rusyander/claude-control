import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@agentdeck/contracts';
import { queryKeys, isProviderScopedKey } from '@shared/api/query-keys';

/**
 * Разложить ответ `PATCH /settings` по кешу.
 *
 * Вынесено из хука отдельной функцией, потому что прогон фронта идёт в node без
 * DOM: отрендерить мутацию в тесте негде, а поведение при смене провайдера
 * проверять обязательно.
 */
export function applySettingsUpdate(
  queryClient: QueryClient,
  settings: AppSettings,
  patch: Partial<AppSettings>,
): void {
  // Настройки кладём в кеш напрямую: тема и язык должны примениться
  // мгновенно, без ожидания повторного запроса.
  queryClient.setQueryData(queryKeys.settings, settings);

  // Источник каталога — настройка, от которой зависит ЧУЖОЙ запрос. Ключ
  // каталога источника не содержит, а `staleTime` у него десять минут: без
  // сброса переключение «models.dev ↔ контур» десять минут не меняло на экране
  // ничего, кроме подписи поля, и единственным выходом оставалась кнопка
  // «Обновить» — то есть поход к контуру, которого правило Т1 избегает.
  // Перезапрос в сеть не идёт: каталог контура берётся из следа последней пробы.
  if (patch.modelSource !== undefined || patch.modelSourcePlatform !== undefined) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.models });
  }

  if (patch.provider === undefined) return;
  // Смена провайдера меняет активный id и карту возможностей — перечитываем
  // /providers, чтобы навигация перестроилась под нового провайдера.
  void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  // Разделы универсального слоя кешированы без id провайдера. Именно reset, а
  // не invalidate: invalidate оставляет данные в кеше, и раздел успевает
  // отрисовать файлы ПРОШЛОГО CLI и утащить их в локальный state редактора —
  // а «Сохранить» уже уйдёт на маршрут нового провайдера. Сброс гарантирует
  // загрузку вместо чужих данных; открытые разделы перезапросятся сразу.
  void queryClient.resetQueries({ predicate: (query) => isProviderScopedKey(query.queryKey) });
}
