import { projectGitKey } from './ProjectGitApi.constants';

/**
 * Общие правила групп разделения — вкладка «Группы» в настройках: что группа
 * решает сама, сколько групп разом на лёгком и тяжёлом проекте и что считать
 * тяжёлым. Проект их наследует (`useSplitSettings`), пока не переопределит.
 */
export const splitDefaultsKey = [...projectGitKey, 'split-defaults'] as const;
