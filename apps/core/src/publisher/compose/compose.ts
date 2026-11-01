import type { CommitConvention, CommitShape, TextVerdict } from '@agentdeck/contracts/core/publish';
import {
  commitWorktree,
  revParse,
  rewriteChain,
  unitCommits,
  type UnitCommit,
} from '../../platform/git/commit-shape.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { matchesConvention } from '../text/index.ts';

/**
 * Форма коммитов единицы (05 §Commit shape): коммиты автора остаются, когда КАЖДОЕ сообщение
 * проходит сито текста и соглашение репозитория; сообщение, с которого сито сняло подпись,
 * переписывается тем же деревом. Иначе — один коммит на единицу с сообщением из журнала.
 */

export interface ComposeInput {
  commits: readonly UnitCommit[];
  /** Сообщение из журнала (заголовок задачи, требования) — для схлопывания. */
  unitMessage: string;
  sieve(text: string): TextVerdict;
  convention: CommitConvention | null;
}

export type ComposePlan =
  | { shape: 'kept' }
  | {
      shape: 're-messaged';
      rows: { tree: string; message: string; author: UnitCommit['author'] }[];
    }
  | { shape: 'squashed'; message: string };

export function decideShape(input: ComposeInput): ComposePlan {
  if (input.commits.length === 0) return { shape: 'kept' };
  const rows: { tree: string; message: string; author: UnitCommit['author'] }[] = [];
  let rewritten = false;
  for (const c of input.commits) {
    const verdict = input.sieve(c.message);
    if (verdict.kind === 'refused') return { shape: 'squashed', message: input.unitMessage };
    if (input.convention && !matchesConvention(verdict.text, input.convention)) {
      return { shape: 'squashed', message: input.unitMessage };
    }
    if (verdict.kind === 'stripped') rewritten = true;
    rows.push({ tree: c.tree, message: verdict.text, author: c.author });
  }
  return rewritten ? { shape: 're-messaged', rows } : { shape: 'kept' };
}

export interface ComposeResult {
  shape: CommitShape;
  commits: string[];
  head: string;
}

/**
 * Собрать ветку единицы к публикации: несохранённое — коммитом из журнала, затем форма. Дерево
 * последнего коммита после сборки = дерево, которое проверяла финальная проверка.
 */
export async function composeUnit(
  repo: string,
  branch: string,
  base: string,
  input: Omit<ComposeInput, 'commits'>,
  options: GitOptions = {},
): Promise<ComposeResult> {
  await commitWorktree(repo, input.unitMessage, options);
  const commits = await unitCommits(repo, base, 'HEAD', options);
  const head = await revParse(repo, 'HEAD', options);
  const plan = decideShape({ ...input, commits });
  if (plan.shape === 'kept') return { shape: 'kept', commits: commits.map((c) => c.sha), head };
  const last = commits[commits.length - 1]!;
  const rows = plan.shape === 'squashed' ? [{ tree: last.tree, message: plan.message }] : plan.rows;
  const next = await rewriteChain(repo, branch, base, head, rows, options);
  const after = await unitCommits(repo, base, next, options);
  return { shape: plan.shape, commits: after.map((c) => c.sha), head: next };
}
