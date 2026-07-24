export {
  useProjects,
  projectsKey,
  useFsRoots,
  useFsList,
  useOpenInEditor,
  useEditors,
} from './api/ProjectApi';
export type {
  ProjectInfo,
  ProjectChatRef,
  DirEntry,
  DirListing,
  EditorInfo,
} from './api/ProjectApi';

// Реестр проектов уровня конфигурации.
export { useProjectRegistry, useAddProject, useRemoveProject } from './api/ProjectRegistryApi';

// Конфиги конкретного проекта: CLAUDE.md, MCP-серверы, права.
export {
  useProjectRules,
  useUpdateProjectRules,
  useProjectMcp,
  useCreateProjectMcp,
  useUpdateProjectMcp,
  useDeleteProjectMcp,
  useSetProjectMcpEnabled,
  useProjectPermissions,
  useCreateProjectPermission,
  useUpdateProjectPermission,
  useDeleteProjectPermission,
} from './api/ProjectConfigApi';

// Проектный уровень НЕ-Claude провайдеров (COMMON-2 + GEMINI-2/3): инструкции,
// MCP, а у Gemini ещё переменные окружения и права проекта.
export {
  useProviderProject,
  useProviderProjectInstructions,
  useUpdateProviderProjectInstructions,
  useProviderProjectMcp,
  useCreateProviderProjectMcp,
  useUpdateProviderProjectMcp,
  useDeleteProviderProjectMcp,
  useProviderProjectEnv,
  useSaveProviderProjectEnv,
  useProviderProjectPermissions,
  useSaveProviderProjectPermissions,
} from './api/ProviderProjectApi';
