import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Сообщения последних коммитов ревизии (класс `git.history`) — вход поиска соглашения о
 * сообщениях публикатора (05:42, `publisher/text` `detectConvention`). Разделитель — NUL:
 * сообщение может содержать любую строку, и маркер в тексте не разрежет его.
 */

/** Соглашению хватает свежего хвоста: старые коммиты могли жить по другим правилам. */
export const MESSAGE_COMMITS = 100;

export function parseMessages(stdout: string): string[] {
  return stdout
    .split('\0')
    .map((m) => m.replace(/^\n+/, '').trimEnd())
    .filter((m) => m !== '');
}

export function readCommitMessages(
  repo: string,
  rev: string,
  options: GitOptions & { commits?: number } = {},
): Promise<Fact<string[]>> {
  return readFact('git.history', async () => {
    const out = await git(
      repo,
      [
        'log',
        `-n${options.commits ?? MESSAGE_COMMITS}`,
        '--no-merges',
        '--format=%B%x00',
        rev,
        '--',
      ],
      { ...options, timeoutMs: 30_000 },
    );
    return parseMessages(out.stdout);
  });
}
