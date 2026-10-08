import type { Project } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Реестр проектов уровня конфигурации — список запомненных путей к каталогам
 * проектов. Сам список живёт в состоянии панели; здесь только его чтение и
 * правка (добавить/забыть). Файлы проекта при удалении не трогаем — забываем путь.
 */

/** Прочитать реестр проектов — для тех, кому нужен список вне компонента. */
export async function fetchProjectRegistry(): Promise<Project[]> {
  const { data } = await apiClient.get<Project[]>('/projects');
  return data;
}
