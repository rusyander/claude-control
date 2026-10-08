import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Проекты, с которыми работал Claude Code. Список выводится на сервере из
 * истории чатов (каталог каждой сессии), поэтому здесь только запрос — вся
 * логика группировки и отсева живёт в домене `ChatProjects`.
 */

/** Ссылка на чат внутри проекта — для списка чатов таба проекта. */
export interface ProjectChatRef {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  /** Счётчик неполный: у большого транскрипта середина не сосчитана (см. chatSummarySchema). */
  messageCountPartial?: boolean;
  isSandbox: boolean;
}

export interface ProjectInfo {
  /** Абсолютный путь каталога проекта. */
  path: string;
  /** Короткое имя для интерфейса. */
  name: string;
  /** Существует ли каталог на диске сейчас. */
  exists: boolean;
  /** Последняя активность по чатам проекта, ISO. */
  lastActivity: string;
  /** Сессии проекта, свежие первыми. */
  chats: ProjectChatRef[];
}

export const projectsKey = ['chats', 'projects'] as const;

export function useProjects() {
  return useQuery({
    queryKey: projectsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectInfo[]>('/chats/projects');
      return data;
    },
  });
}
