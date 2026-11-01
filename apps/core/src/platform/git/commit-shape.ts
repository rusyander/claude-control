import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Механика формы коммитов публикатора (05 §Commit shape): коммиты единицы от базы, коммит
 * рабочего дерева, пересборка цепочки с новыми сообщениями тем же деревом. Решение о форме —
 * `publisher/compose`; здесь только git. Сбой — исключение: вызывающий называет его отказом.
 */

export interface UnitCommit {
  sha: string;
  tree: string;
  message: string;
  author: { name: string; email: string; date: string };
}

const SEP = '\x1f';
const OID = /^[0-9a-f]{40,64}$/;
const call = (o: GitOptions, ms = 30_000) => ({ ...o, timeoutMs: ms });

export function parseUnitCommits(stdout: string): UnitCommit[] {
  const out: UnitCommit[] = [];
  for (const raw of stdout.split('\0')) {
    const rec = raw.replace(/^\n+/, '');
    if (rec.trim() === '') continue;
    const [sha, tree, name, email, date, ...rest] = rec.split(SEP);
    if (!sha || !OID.test(sha) || !tree || !OID.test(tree)) {
      throw new Error(`log garbage: ${rec.slice(0, 80)}`);
    }
    out.push({
      sha,
      tree,
      message: rest.join(SEP).trimEnd(),
      author: { name: name ?? '', email: email ?? '', date: date ?? '' },
    });
  }
  return out;
}

/** Коммиты `base..head` от старого к новому, без слияний. */
export async function unitCommits(
  repo: string,
  base: string,
  head = 'HEAD',
  options: GitOptions = {},
): Promise<UnitCommit[]> {
  const format = ['%H', '%T', '%an', '%ae', '%aI', '%B'].join('%x1f');
  const out = await git(
    repo,
    ['log', '--reverse', '--no-merges', `--format=${format}%x00`, `${base}..${head}`, '--'],
    call(options),
  );
  return parseUnitCommits(out.stdout);
}

export async function revParse(
  repo: string,
  rev: string,
  options: GitOptions = {},
): Promise<string> {
  const out = await git(repo, ['rev-parse', '--verify', `${rev}^{commit}`], call(options));
  const sha = out.stdout.trim();
  if (!OID.test(sha)) throw new Error(`rev-parse garbage: ${sha.slice(0, 80)}`);
  return sha;
}

/**
 * Несохранённое рабочее дерево — коммитом (финальная проверка шла по рабочему дереву, публикуется
 * оно же). `git commit` — хуки проекта идут на коммит ядра (04 §Full stack). Нечего — null.
 */
export async function commitWorktree(
  repo: string,
  message: string,
  options: GitOptions = {},
): Promise<string | null> {
  await git(repo, ['add', '-A', '--', '.'], call(options));
  const staged = await git(repo, ['diff', '--cached', '--quiet'], {
    ...call(options),
    acceptNonZero: true,
  });
  if (staged.code === 0) return null;
  await git(repo, ['commit', '-q', '-m', message], call(options, 120_000));
  return revParse(repo, 'HEAD', options);
}

/**
 * Цепочка `rows` поверх `parent` тем же деревом каждого коммита (`commit-tree`), затем ветка
 * переставляется ровно с `expectHead` (`update-ref` с прежним значением — гонка не затрёт чужое).
 * Рабочее дерево и индекс не меняются: дерево последнего коммита то же.
 */
export async function rewriteChain(
  repo: string,
  branch: string,
  parent: string,
  expectHead: string,
  rows: readonly { tree: string; message: string; author?: UnitCommit['author'] }[],
  options: GitOptions = {},
): Promise<string> {
  let head = parent;
  for (const row of rows) {
    const env: Record<string, string> = row.author
      ? {
          GIT_AUTHOR_NAME: row.author.name,
          GIT_AUTHOR_EMAIL: row.author.email,
          GIT_AUTHOR_DATE: row.author.date,
        }
      : {};
    const out = await git(repo, ['commit-tree', row.tree, '-p', head, '-m', row.message], {
      ...call(options),
      extraEnv: env,
    });
    head = out.stdout.trim();
    if (!OID.test(head)) throw new Error(`commit-tree garbage: ${head.slice(0, 80)}`);
  }
  await git(repo, ['update-ref', `refs/heads/${branch}`, head, expectHead], call(options));
  return head;
}

export type RebaseResult = { kind: 'rebased'; head: string } | { kind: 'stopped'; files: string[] };

/**
 * Перебазировка ядром на конфликт ДО MR (05 §Push and MR): остановилась — сразу `--abort`, ветка
 * как была, конфликт решает шаг правки слиянием базы. Без конфликта ядро не перебазирует никогда.
 */
export async function rebaseOnto(
  repo: string,
  base: string,
  options: GitOptions = {},
): Promise<RebaseResult> {
  const got = await git(repo, ['rebase', '--no-autostash', base], {
    ...call(options, 120_000),
    acceptNonZero: true,
  });
  if (got.code === 0) return { kind: 'rebased', head: await revParse(repo, 'HEAD', options) };
  const files = await git(repo, ['diff', '--name-only', '--diff-filter=U'], {
    ...call(options),
    acceptNonZero: true,
  });
  await git(repo, ['rebase', '--abort'], { ...call(options), acceptNonZero: true });
  return {
    kind: 'stopped',
    files: files.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  };
}
