import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangelogResponse } from '@agentdeck/contracts/changelog';
import { buildChangelog } from './build.ts';
import { readEntries } from './entries.ts';
import { readGitHistory, readHead, readWorkingTree, type GitHistory } from './git-log.ts';

/**
 * Лента «Что нового»: git (история, привязки, правки рабочей копии) плюс файлы
 * описаний. Разбор истории дорог и меняется только с новым коммитом — он
 * запоминается по HEAD; описания и правки рабочей копии читаются каждый раз (описания
 * мало, а человек правит их и код прямо сейчас).
 */

interface Memo {
  repoRoot: string;
  head: string;
  history: GitHistory;
}

let memo: Memo | undefined;

export function resetChangelogMemo(): void {
  memo = undefined;
}

async function history(repoRoot: string, head: string): Promise<GitHistory> {
  if (memo && memo.repoRoot === repoRoot && memo.head === head) return memo.history;
  const fresh = await readGitHistory(repoRoot);
  memo = { repoRoot, head, history: fresh };
  return fresh;
}

export async function getChangelog(repoRoot: string): Promise<ChangelogResponse> {
  const { curated, invalid } = await readEntries(repoRoot);
  const head = existsSync(join(repoRoot, '.git')) ? await readHead(repoRoot) : undefined;
  if (!head) {
    return {
      entries: buildChangelog({
        commits: [],
        anchors: new Map(),
        curated,
        workingTree: [],
        gitAvailable: false,
      }),
      gitAvailable: false,
      invalid,
    };
  }

  const { commits, anchors } = await history(repoRoot, head);
  const workingTree = await readWorkingTree(repoRoot);
  return {
    entries: buildChangelog({ commits, anchors, curated, workingTree, gitAvailable: true }),
    gitAvailable: true,
    invalid,
  };
}
