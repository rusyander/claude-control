import type { ProjectChats } from '../chat/useChatProjects';

/** Разговор проекта; у разговора из git-копии — имя её каталога (обычно ветка). */
export interface ProjectChatEntry {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  messageCountPartial?: boolean;
  /** Каталог, в котором шёл разговор: сам проект или его копия. */
  path: string;
  /** Имя копии `<проект>-worktrees/<копия>`; у разговора в самом проекте не задано. */
  copy?: string;
}

/** Проект глазами телефона: запись реестра панели и разговоры, которые в нём велись. */
export interface ProjectEntry {
  path: string;
  name: string;
  /** Есть в реестре панели — тот же список, что в разделе «Проекты» на компьютере. */
  registered: boolean;
  /** Каталог на диске на месте; у записи реестра без разговоров считаем, что да. */
  exists: boolean;
  /** Последний разговор, ISO; пусто — разговоров не было. */
  lastActivity: string;
  /** Свежие первыми, вместе с разговорами в копиях. */
  chats: ProjectChatEntry[];
}

export interface ProjectLists {
  /** Реестр панели: свежие разговоры сверху, проекты без разговоров — по имени в конце. */
  mine: ProjectEntry[];
  /** Папки из истории чатов вне реестра: живые, свежие первыми. */
  others: ProjectEntry[];
}

export type ChatProject = ProjectChats;
