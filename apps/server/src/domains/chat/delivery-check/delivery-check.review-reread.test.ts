import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchText } from '../../../lib/server-texts/server-texts.ts';
import type { MrReview } from '../../integrations/mr-review/mr-review.ts';
import { deliveryFacts } from './delivery-check.ts';

/**
 * N6 (g5 25.10, MR !1101): группа прочла обсуждения MR один раз в начале 21-минутного
 * хода и написала «перед завершением их надо перечитать ещё раз», не перечитав. Это
 * перечтение делает сама панель: проверка доставки после КАЖДОГО хода (и хода по слову
 * наблюдателя) читает MR заново, и ветка ревьюера, пришедшая за ход, держит доставку.
 * Настоящие git (MR — служебная ссылка GitLab в голом репозитории) и сама проверка;
 * подменено только чтение форджа (`review`) — им и отвечает то, что пришло за ход.
 */

const WEB = 'https://git.example.com/team/app';
const MR = `${WEB}/-/merge_requests/1101`;
const WORK = '2026-10-25T09:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: WORK, GIT_COMMITTER_DATE: WORK },
  }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const reviewWith = (threads: MrReview['threads']): MrReview => ({
  state: 'open',
  author: 'rustam',
  description: '## Проверки\npnpm test — зелёный на итоговом коммите\n',
  threads,
});

describe(
  'N6: проверка доставки после хода перечитывает обсуждения MR сама',
  { timeout: 60_000 },
  () => {
    let root = '';
    let work = '';

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'cc-n6-'));
      const bare = join(root, 'remote.git');
      work = join(root, 'work');
      mkdirSync(work);
      git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
      git(work, ['init', '-q', '-b', 'main']);
      write(work, { 'README.md': 'seed\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'seed']);
      git(work, ['remote', 'add', 'origin', `${WEB}.git`]);
      git(work, ['config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, `${WEB}.git`]);
      git(work, ['push', '-q', 'origin', 'main']);
      git(work, ['switch', '-q', '-c', 'fix/PROJ-1']);
      write(work, { 'lib/sum.ts': 'export const sum = 1;\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'fix']);
      git(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
      git(bare, ['update-ref', 'refs/merge-requests/1101/head', git(work, ['rev-parse', 'HEAD'])]);
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const check = (review: MrReview) => {
      const asked: string[] = [];
      return deliveryFacts({ path: work, branch: 'fix/PROJ-1', base: 'main' }, MR, [], {
        testsCommand: 'node tests-cli.mjs run',
        branchOfMr: async () => 'fix/PROJ-1',
        review: async (url) => {
          asked.push(url);
          return review;
        },
      }).then((verdict) => ({ verdict, asked }));
    };

    it('ветка ревьюера пришла за ход — проверка прочла MR и держит доставку пробелом', async () => {
      const { verdict, asked } = await check(
        reviewWith([
          {
            id: 't-late',
            resolvable: true,
            resolved: false,
            notes: [{ id: '501', author: 'reviewer', body: 'блокер: нет теста на ноль' }],
          },
        ]),
      );
      expect(asked).toEqual([MR]);
      expect(verdict.mr).toBe(MR);
      expect(verdict.reviewThreads?.map((thread) => thread.id)).toEqual(['t-late']);
      expect(
        verdict.missing.some(
          (line) => matchText(line)?.messageCode === 'delivery-gap-review-threads',
        ),
      ).toBe(true);
    });

    it('обсуждений без ответа нет — этот пробел не ставится', async () => {
      const { verdict, asked } = await check(reviewWith([]));
      expect(asked).toEqual([MR]);
      expect(verdict.reviewThreads).toBeUndefined();
      expect(
        verdict.missing.some(
          (line) => matchText(line)?.messageCode === 'delivery-gap-review-threads',
        ),
      ).toBe(false);
    });
  },
);
