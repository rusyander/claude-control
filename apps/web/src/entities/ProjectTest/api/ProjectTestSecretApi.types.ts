import type { ProjectTestSecretsView, ProjectTestsView } from '@agentdeck/contracts';

/** Ответ записи: доступы окружения плюс пересобранный вид раздела. */
export type SecretsResponse = ProjectTestSecretsView & { view: ProjectTestsView };
