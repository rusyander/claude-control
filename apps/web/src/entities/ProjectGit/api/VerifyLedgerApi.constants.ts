import { projectGitKey } from './ProjectGitApi.constants';

/** Журнал проверок — вкладка «Группы» в настройках, рядом с ситами. */
export const verifyLedgerKey = [...projectGitKey, 'verify-ledger'] as const;
