import type { ForgePort, ForgeProject } from '@agentdeck/contracts/core/forge';
import { createCaFetch } from '../../platform/net/ca-fetch.ts';
import type { NetFetch } from '../../platform/net/net.types.ts';
import { createGenericPort } from './generic.ts';
import { createGithubPort } from './github.ts';
import { createGitlabPort } from './gitlab.ts';

/**
 * Порт форжа по виду проекта (05 §Push and MR): GitLab, GitHub или «другой» (пуш и ссылка).
 * Транспорт по умолчанию — `createCaFetch` платформы: свой корень доверия компании и прокси из
 * окружения; тест подаёт адрес заглушки форжа на loopback.
 */
export interface ForgePortInput {
  project: ForgeProject;
  token: string | null;
  /** Почему значения доступа нет (хранилище ключей не прочиталось); пусто — «не сохранён». */
  tokenProblem?: string;
  fetch?: NetFetch;
  /** Свой корень доверия (PEM/DER); пусто — системный. */
  caCertPath?: string;
  timeoutMs?: number;
}

export function createForgePort(input: ForgePortInput): ForgePort {
  if (input.project.kind === 'generic') return createGenericPort(input.project);
  const access = {
    project: input.project,
    token: input.token,
    ...(input.tokenProblem ? { tokenProblem: input.tokenProblem } : {}),
    fetch: input.fetch ?? createCaFetch(input.caCertPath ?? ''),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  return input.project.kind === 'gitlab' ? createGitlabPort(access) : createGithubPort(access);
}

export { GENERIC_REASON } from './generic.ts';
export { DRAFT_PREFIX, mrBodyHash, noteHash } from './hash.ts';
export type { ForgeAccess } from './forge.types.ts';
export { forgeActionKey, parseForgeActionKey, type ForgeActionKey } from './action-keys.ts';
