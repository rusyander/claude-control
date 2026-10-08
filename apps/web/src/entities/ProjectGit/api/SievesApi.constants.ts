import { projectGitKey } from './ProjectGitApi.constants';

/**
 * Сита перед MR — вкладка «Группы» в настройках: выученные по тредам MR и счёт
 * блокеров по классам. Встроенные сита — каталог контракта, сервер их не отдаёт.
 */
export const sievesKey = [...projectGitKey, 'sieves'] as const;
