import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import type { GroupListItem } from '../model/types';

// Группы живут в данных приложения, а не в конфигах Claude Code,
// поэтому у них свой набор запросов, а не общая CRUD-фабрика сущностей.

async function listGroups(): Promise<GroupListItem[]> {
  const { data } = await apiClient.get<GroupListItem[]>('/groups');
  return data;
}

export function useGroups() {
  return useQuery({ queryKey: queryKeys.groups, queryFn: listGroups });
}
