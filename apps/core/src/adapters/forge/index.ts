import type {
  ForgeInbox,
  ForgeKind,
  ForgePort,
  ForgeProject,
} from '@agentdeck/contracts/core/forge';
import { createCaFetch } from '../../platform/net/ca-fetch.ts';
import type { NetFetch } from '../../platform/net/net.types.ts';
import { createGenericPort } from './generic.ts';
import { createGithubPort } from './github.ts';
import { createGitlabInbox } from './gitlab-inbox.ts';
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

/** Входящие по всему сайту (D16): сайт форжа и учётка человека, без проекта задачи. */
export interface ForgeInboxInput {
  kind: ForgeKind;
  /** Адрес сайта (`https://gitlab.example.com`), не проекта. */
  baseUrl: string;
  token: string | null;
  tokenProblem?: string;
  fetch?: NetFetch;
  caCertPath?: string;
  timeoutMs?: number;
  /** Потолок страниц одного списка; дошёл без конца списка — `unknown`. */
  maxPages?: number;
}

/** Почему входящих нет у форжа без чтений по сайту: названо, не пустой список. */
export const INBOX_UNSUPPORTED: Readonly<Record<Exclude<ForgeKind, 'gitlab'>, string>> = {
  github:
    'github inbox reads are not supported (D16): assigned issues, review requests and own MRs are read from GitLab only',
  generic: 'generic forge inbox reads are not supported (D16): the core knows no API of this forge',
};

export function createForgeInbox(input: ForgeInboxInput): ForgeInbox {
  if (input.kind !== 'gitlab') {
    const reason = { unsupported: INBOX_UNSUPPORTED[input.kind] };
    return {
      kind: input.kind,
      assignedIssues: async () => reason,
      reviewRequests: async () => reason,
      ownMrsWithOpenThreads: async () => reason,
    };
  }
  const access = {
    // Порт ходит от корня сайта; проекта у входящих нет — путь проекта берётся из ответа.
    project: { kind: input.kind, ref: '', baseUrl: input.baseUrl, pushUrl: '' },
    token: input.token,
    ...(input.tokenProblem ? { tokenProblem: input.tokenProblem } : {}),
    fetch: input.fetch ?? createCaFetch(input.caCertPath ?? ''),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  return createGitlabInbox(access, input.maxPages);
}

export { GENERIC_REASON } from './generic.ts';
export { DRAFT_PREFIX, mrBodyHash, noteHash } from './hash.ts';
export type { ForgeAccess } from './forge.types.ts';
export { forgeActionKey, parseForgeActionKey, type ForgeActionKey } from './action-keys.ts';
