import { git } from '../exec/exec.ts';

/**
 * Коммиты на ветке группы, которых группа не делала (g8 26.10, F1/F3): бот CI
 * дописал в её ветку перегенерацию справочника. Группа не знала, что удалённый
 * впереди (доставка писала «не отправлена»), а подтянув его, отдала в ревью MR,
 * чья голова откатила её же правку в сгенерированной странице.
 */

/** Сколько коммитов «впереди» назвать в строке пробела. */
const AHEAD_SHOWN = 3;
/** Дальше коммитов ветки не разбирать: ветка группы столько не делает. */
const COMMITS_LIMIT = 60;

const read = (cwd: string, args: string[]): Promise<string> => git(cwd, args).catch(() => '');

/**
 * Удалённая ветка группы впереди копии: голова копии — предок удалённой. Коммита
 * удалённой у копии нет — он докачивается (`fetch` ветки); не вышло — неизвестно.
 * Строки — `<sha> <тема>`, первые `AHEAD_SHOWN`, и счёт всех.
 */
export async function remoteAhead(
  cwd: string,
  remote: string,
  branch: string,
  remoteSha: string,
  head: string,
): Promise<{ commits: string[]; count: number } | undefined> {
  if (!remoteSha || remoteSha === head) return undefined;
  const has = async (): Promise<boolean> =>
    (await read(cwd, ['cat-file', '-t', remoteSha])).trim() === 'commit';
  if (!(await has())) {
    await read(cwd, ['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`]);
    if (!(await has())) return undefined;
  }
  const ancestor = await git(cwd, ['merge-base', '--is-ancestor', head, remoteSha]).then(
    () => true,
    () => false,
  );
  if (!ancestor) return undefined;
  const lines = (await read(cwd, ['log', '--format=%h %s', `${head}..${remoteSha}`]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0
    ? { commits: lines.slice(0, AHEAD_SHOWN), count: lines.length }
    : undefined;
}

export interface ForeignRevert {
  /** `<sha> <тема> (<автор>)` чужого коммита. */
  commit: string;
  /** Файлы, где он убрал строки, добавленные группой, и их нет в HEAD. */
  files: string[];
}

interface BranchCommit {
  sha: string;
  own: boolean;
  label: string;
}

/** Строки, которые коммит добавил (`+`) и убрал (`-`), по файлам. */
async function linesOf(
  cwd: string,
  sha: string,
): Promise<Map<string, { added: Set<string>; removed: Set<string> }>> {
  const out = await read(cwd, [
    'show',
    '--format=',
    '--unified=0',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    sha,
  ]);
  const files = new Map<string, { added: Set<string>; removed: Set<string> }>();
  let current: { added: Set<string>; removed: Set<string> } | undefined;
  for (const line of out.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      current = { added: new Set(), removed: new Set() };
      files.set(header[1] as string, current);
      continue;
    }
    if (!current || line.startsWith('+++') || line.startsWith('---')) continue;
    const text = line.slice(1).trim();
    if (!text) continue;
    if (line.startsWith('+')) current.added.add(text);
    else if (line.startsWith('-')) current.removed.add(text);
  }
  return files;
}

/**
 * Чужие коммиты ветки (автор — не `user.email` копии), убравшие строки, которые
 * группа добавила раньше, когда этих строк нет и в HEAD, а своего коммита в том
 * файле после чужого не было. Свой коммит после — группа файл уже решила: вернула
 * строки или поправила источник генерации. `user.email` не задан — своих не
 * отличить, разбора нет.
 */
export async function foreignReverts(cwd: string, base: string): Promise<ForeignRevert[]> {
  const email = (await read(cwd, ['config', '--get', 'user.email'])).trim().toLowerCase();
  if (!email || !base) return [];
  const commits: BranchCommit[] = (
    await read(cwd, [
      'log',
      '--reverse',
      '--no-merges',
      `--max-count=${COMMITS_LIMIT}`,
      '--format=%H%x09%ae%x09%an%x09%h %s',
      `${base}..HEAD`,
    ])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', author = '', name = '', label = ''] = line.split('\t');
      return {
        sha,
        own: author.trim().toLowerCase() === email,
        label: `${label} (${name})`,
      };
    });
  if (!commits.some((commit) => !commit.own) || !commits.some((commit) => commit.own)) return [];
  const diffs = new Map<string, Awaited<ReturnType<typeof linesOf>>>();
  for (const commit of commits) diffs.set(commit.sha, await linesOf(cwd, commit.sha));
  const headLines = new Map<string, Set<string>>();
  const atHead = async (file: string): Promise<Set<string>> => {
    let lines = headLines.get(file);
    if (!lines) {
      lines = new Set(
        (await read(cwd, ['show', `HEAD:${file}`]))
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
      headLines.set(file, lines);
    }
    return lines;
  };
  const found: ForeignRevert[] = [];
  for (const [at, commit] of commits.entries()) {
    if (commit.own) continue;
    const entry: ForeignRevert = { commit: commit.label, files: [] };
    found.push(entry);
    for (const [file, { removed }] of diffs.get(commit.sha) ?? []) {
      const addedBefore = new Set<string>();
      for (const own of commits.slice(0, at)) {
        if (!own.own) continue;
        for (const line of diffs.get(own.sha)?.get(file)?.added ?? []) addedBefore.add(line);
      }
      const settledAfter = commits
        .slice(at + 1)
        .some((later) => later.own && diffs.get(later.sha)?.has(file));
      if (settledAfter || addedBefore.size === 0) continue;
      const head = await atHead(file);
      if ([...removed].some((line) => addedBefore.has(line) && !head.has(line))) {
        entry.files.push(file);
      }
    }
  }
  return found.filter((item) => item.files.length > 0);
}
