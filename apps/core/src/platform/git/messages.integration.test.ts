import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectConvention } from '../../publisher/text/index.ts';
import { readCommitMessages } from './messages.ts';

/** Сообщения коммитов на настоящем репозитории: многострочные тела и трейлеры не режутся. */

let repo: string;
const g = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'core-messages-'));
  g('init', '-q', '-b', 'main');
  for (const [i, msg] of [
    'feat: первая запись',
    'fix(api): повтор запроса\n\nТело в две строки.\n\nSigned-off-by: t <t@t>',
  ].entries()) {
    writeFileSync(join(repo, `f${i}.txt`), String(i));
    g('add', '-A');
    g('commit', '-q', '-m', msg);
  }
});
afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('commit messages fact', () => {
  it('reads whole messages newest first and the convention follows from them', async () => {
    const fact = await readCommitMessages(repo, 'HEAD');
    expect(fact).toEqual({
      value: [
        'fix(api): повтор запроса\n\nТело в две строки.\n\nSigned-off-by: t <t@t>',
        'feat: первая запись',
      ],
    });
    if (!('value' in fact)) throw new Error('no value');
    expect(detectConvention(fact.value)).toEqual({
      conventional: true,
      language: 'ru',
      signedOffShare: 0.5,
    });
  });

  it('an unknown revision is unknown, never an empty history', async () => {
    expect(await readCommitMessages(repo, 'refs/heads/nope')).toEqual({
      unknown: expect.any(String),
    });
  });
});
