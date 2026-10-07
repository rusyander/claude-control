import type {
  ProjectDirProblemCode,
  ProviderChatProject,
  ProviderChatProjectProvider,
} from '@agentdeck/contracts';

/** Бейдж провайдера в строке проекта. */
export interface ProjectBadge extends ProviderChatProjectProvider {
  /** Это активный провайдер — новый разговор будет у него. */
  isActive: boolean;
}

/** Строка списка проектов в чате чужого провайдера. */
export interface ProjectRowView {
  path: string;
  name: string;
  lastActivity: string;
  badges: ProjectBadge[];
  /** Почему новый разговор здесь не начать; нет — можно. */
  problem?: ProjectDirProblemCode;
}

/**
 * Строки списка: поиск по имени и пути, бейджи с отметкой активного провайдера.
 * Порядок — серверный (свежие сверху); каталог, в котором разговор не начать,
 * НЕ выбрасывается — он остаётся строкой с причиной, иначе проект пропадал бы
 * молча.
 */
export function projectRows(
  projects: readonly ProviderChatProject[],
  activeProviderId: string,
  query: string,
): ProjectRowView[] {
  const needle = query.trim().toLowerCase();
  return projects
    .filter(
      (project) =>
        !needle ||
        project.name.toLowerCase().includes(needle) ||
        project.path.toLowerCase().includes(needle),
    )
    .map((project) => ({
      path: project.path,
      name: project.name,
      lastActivity: project.lastActivity,
      badges: project.providers.map((provider) => ({
        ...provider,
        isActive: provider.id === activeProviderId,
      })),
      ...(project.startProblem ? { problem: project.startProblem } : {}),
    }));
}
