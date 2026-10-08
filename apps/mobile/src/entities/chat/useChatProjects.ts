import type { UseQueryResult } from '@tanstack/react-query';
import { useLocalTitle } from './useLocalTitle';
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import { STALE_MS } from './api.constants';

/**
 * Разговоры и их содержимое. Источник — транскрипты самого Claude Code, поэтому
 * список одинаков в панели, в приложении и в терминале: своей базы нет ни у
 * кого, и расходиться нечему.
 */

/** Проект глазами чата: путь, имя и разговоры, которые в нём велись. */
export interface ProjectChats {
  path: string;
  name: string;
  exists: boolean;
  lastActivity: string;
  chats: {
    id: string;
    title: string;
    updatedAt: string;
    messageCount: number;
    messageCountPartial?: boolean;
    isSandbox: boolean;
  }[];
}

export function useChatProjects(): UseQueryResult<ProjectChats[]> {
  const localTitle = useLocalTitle();
  const select = useCallback(
    (projects: ProjectChats[]) =>
      projects.map((project) => ({ ...project, chats: project.chats.map(localTitle) })),
    [localTitle],
  );
  return useQuery({
    queryKey: ['chats', 'projects'],
    select,
    queryFn: () => api.get<ProjectChats[]>('/chats/projects'),
    staleTime: STALE_MS,
  });
}
