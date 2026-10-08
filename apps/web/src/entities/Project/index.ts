// Короткое имя проекта из пути — им подписываются чаты и запуски агентов.
export { projectName } from './lib/projectName';

export { useProjects, projectsKey } from './api/ProjectApi';
export { useEditors } from './api/useEditors';
export { useFsList } from './api/useFsList';
export { useFsRoots } from './api/useFsRoots';
export { useOpenInEditor } from './api/useOpenInEditor';
export type { ProjectInfo, ProjectChatRef } from './api/ProjectApi';
export type { EditorInfo } from './api/useEditors';
export type { DirListing } from './api/useFsList';
export type { DirEntry } from './api/ProjectApi.types';

// Реестр проектов уровня конфигурации.
export { useProjectRegistry } from './api/ProjectRegistryApi';
export { useRemoveProject } from './api/useRemoveProject';
export { useAddProject } from './api/useAddProject';
export { fetchProjectRegistry } from './lib/fetchProjectRegistry';

// Проект, над которым работают в разделе тестирования: реестр плюс открытые
// вкладки, выбор запоминается браузером. Живёт здесь, а не на странице тестов,
// потому что тот же выбор нужен общему поиску — он ищет и по кейсам проекта.
export { useTestsProject } from './model/useTestedProject';
export { projectByPath } from './lib/projectByPath';
export { mergeProjects } from './lib/mergeProjects';
export { resolveSelected } from './lib/resolveSelected';
export type { TestsProject } from './model/useTestedProject';
// Выбор раздела тестирования в момент вызова: копия хука в другом месте
// (окно агента) держит своё состояние и узнала бы о смене выбора с опозданием.
export { readStored as readTestsProjectId } from './lib/readStored';

// Конфиги конкретного проекта: CLAUDE.md, MCP-серверы, права.
export { useProjectRules } from './api/ProjectConfigApi';
export { useDeleteProjectPermission } from './api/useDeleteProjectPermission';
export { useUpdateProjectPermission } from './api/useUpdateProjectPermission';
export { useCreateProjectPermission } from './api/useCreateProjectPermission';
export { useSetProjectMcpEnabled } from './api/useSetProjectMcpEnabled';
export { useDeleteProjectMcp } from './api/useDeleteProjectMcp';
export { useUpdateProjectMcp } from './api/useUpdateProjectMcp';
export { useCreateProjectMcp } from './api/useCreateProjectMcp';
export { useProjectPermissions } from './api/useProjectPermissions';
export { useProjectMcp } from './api/useProjectMcp';
export { useUpdateProjectRules } from './api/useUpdateProjectRules';

// Собственный `.claude` проекта (скиллы, хуки, правила) — только чтение, два адреса
// одного ответа: по id из реестра и по абсолютному пути привязки группы.
export { useProjectLocal } from './api/ProjectLocalApi';
export { useProjectLocalByPath } from './api/useProjectLocalByPath';
export { ProjectLocalConfigView } from './ui/ProjectLocalConfigView/ProjectLocalConfigView';
export type { ProjectLocalConfigViewProps } from './ui/ProjectLocalConfigView/ProjectLocalConfigView.types';

// Проектный уровень НЕ-Claude провайдеров (COMMON-2 + GEMINI-2/3): инструкции,
// MCP, а у Gemini ещё переменные окружения и права проекта.
export { useProviderProject } from './api/ProviderProjectApi';
export { useDeleteProviderProjectMcp } from './api/useDeleteProviderProjectMcp';
export { useUpdateProviderProjectMcp } from './api/useUpdateProviderProjectMcp';
export { useCreateProviderProjectMcp } from './api/useCreateProviderProjectMcp';
export { useSaveProviderProjectPermissions } from './api/useSaveProviderProjectPermissions';
export { useProviderProjectPermissions } from './api/useProviderProjectPermissions';
export { useSaveProviderProjectEnv } from './api/useSaveProviderProjectEnv';
export { useProviderProjectEnv } from './api/useProviderProjectEnv';
export { useProviderProjectMcp } from './api/useProviderProjectMcp';
export { useUpdateProviderProjectInstructions } from './api/useUpdateProviderProjectInstructions';
export { useProviderProjectInstructions } from './api/useProviderProjectInstructions';
