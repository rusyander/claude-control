import { useQuery } from '@tanstack/react-query';
import type { ConfluencePage, JiraIssue, JiraProject } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

/**
 * Поиск по Jira и Confluence для выбора того, к чему привязывают проект.
 *
 * Запрос уходит только по нажатию, а не на каждую букву: это ЧУЖОЙ сервис, и
 * поиск по нему стоит секунды и лимитов. Поэтому хук получает уже
 * зафиксированный запрос, а поле ввода живёт в форме отдельно.
 *
 * Ошибка сюда приходит как есть: «интеграция не настроена» и «токен отклонён» —
 * разные причины пустого списка, и подменять их общим «ничего не найдено»
 * значит прятать единственное объяснение.
 */

const SEARCH_LIMIT = 25;

export function useJiraProjects(isEnabled: boolean) {
  return useQuery({
    queryKey: integrationKeys.jiraProjects,
    queryFn: async (): Promise<JiraProject[]> => {
      const { data } = await apiClient.get<JiraProject[]>('/integrations/jira/projects');
      return data;
    },
    enabled: isEnabled,
  });
}

export function useJiraSearch(query: string) {
  return useQuery({
    queryKey: integrationKeys.jiraSearch(query),
    queryFn: async (): Promise<JiraIssue[]> => {
      const { data } = await apiClient.get<JiraIssue[]>('/integrations/jira/search', {
        params: { q: query, limit: SEARCH_LIMIT },
      });
      return data;
    },
    enabled: query.trim().length > 0,
  });
}

export function useConfluenceSearch(query: string) {
  return useQuery({
    queryKey: integrationKeys.confluenceSearch(query),
    queryFn: async (): Promise<ConfluencePage[]> => {
      const { data } = await apiClient.get<ConfluencePage[]>('/integrations/confluence/search', {
        params: { q: query, limit: SEARCH_LIMIT },
      });
      return data;
    },
    enabled: query.trim().length > 0,
  });
}
