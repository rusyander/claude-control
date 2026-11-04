import { z } from 'zod';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import type { EstimateReply } from './estimate.ts';
import { uuidv7 } from './ids.ts';

/**
 * Ревью MR по ссылке (этап 10, F8): перенос карточки ревью старой панели на ядро. Человек даёт
 * ссылку на MR и репозиторий; ядро читает MR у форжа, создаёт задачу сценария `review-link@1` на
 * ветке MR и после ревью спрашивает, что делать с замечаниями. `POST /v1/review-link`.
 */

export const REVIEW_LINK_PRESET = 'review-link';
export const REVIEW_LINK_ROUTE = 'POST /v1/review-link';

/**
 * Отказы с названной причиной (snake_case, тексты ru/en — у панели):
 * - `review_link_unparsed` — ссылка не похожа на MR GitLab (`/-/merge_requests/N`) или PR GitHub
 *   (`/pull/N`);
 * - `review_link_foreign_repo` — MR из другого проекта, чем remote выбранного репозитория;
 * - `review_link_closed` — MR закрыт или влит: ревьюить и пушить в него поздно;
 * - `review_link_unread` — форж не ответил (сеть, доступ) или репозиторий не читается;
 * - `review_link_forge_unsupported` — форж без API (только пуш и ссылка): MR не прочесть.
 */
export const REVIEW_LINK_REFUSALS = [
  'review_link_unparsed',
  'review_link_foreign_repo',
  'review_link_closed',
  'review_link_unread',
  'review_link_forge_unsupported',
] as const;
export type ReviewLinkRefusal = (typeof REVIEW_LINK_REFUSALS)[number];

export const reviewLinkBodySchema = z.strictObject({
  cmdId: uuidv7,
  fields: z.strictObject({
    /** Ссылка на MR/PR как её скопировал человек (якорь и хвост `/diffs` допустимы). */
    url: z.string().min(1).max(2000),
    /** Основная папка репозитория MR — по её remote ядро выбирает форж и проект. */
    repo: z.string().min(1).max(1000),
    lang: z.enum(['ru', 'en']).optional(),
  }),
  proof: commandProofSchema,
});
export type ReviewLinkBody = z.infer<typeof reviewLinkBodySchema>;

export function parseReviewLinkBody(
  input: unknown,
): { ok: true; body: ReviewLinkBody } | { ok: false; issues: CommandIssue[] } {
  const parsed = reviewLinkBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: commandIssues(parsed.error.issues, '', input) };
  return { ok: true, body: parsed.data };
}

/** 202/200 — задача есть (ответ оценки); 422 — задачи нет, код отказа и подробности. */
export type ReviewLinkReply = EstimateReply;
export interface ReviewLinkRefused {
  code: ReviewLinkRefusal | 'estimate-refused';
  problems: string[];
}

export interface MrLink {
  forge: 'gitlab' | 'github';
  /** Хост с портом, без схемы. */
  host: string;
  /** Путь проекта: `group/sub/project` (GitLab) или `owner/repo` (GitHub). */
  project: string;
  iid: number;
}

// `URL` есть во всех средах пакета (Node, браузер, телефон), но набор типов пакета — без DOM и
// без node: объявлено только то, что читает разбор ссылки (тот же приём, что в `procs.ts`).
interface ParsedUrl {
  protocol: string;
  host: string;
  pathname: string;
}
declare const URL: new (input: string) => ParsedUrl;

const GITLAB = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;
const GITHUB = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;

/**
 * Разбор ссылки на MR (чистая функция; панель проверяет поле до отправки, ядро — снова). Не та
 * форма — `null`: догадка по чужой ссылке открыла бы ревью не того MR.
 */
export function parseMrLink(raw: string): MrLink | null {
  let url: ParsedUrl;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  const gl = GITLAB.exec(path);
  if (gl) return { forge: 'gitlab', host: url.host, project: gl[1]!, iid: Number(gl[2]) };
  const gh = GITHUB.exec(path);
  if (gh) return { forge: 'github', host: url.host, project: gh[1]!, iid: Number(gh[2]) };
  return null;
}
