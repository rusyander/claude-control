import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { describe, expect, it } from 'vitest';
import * as forge from './index.ts';
import { createGenericPort } from './generic.ts';
import { createGithubPort } from './github.ts';
import { createGitlabPort } from './gitlab.ts';

/**
 * P63 (05:7): у переходника форжа нет ни слияния, ни одобрения — по построению. Статически:
 * ключи каждого объекта порта и экспорт модуля не похожи на слияние или одобрение; исходники
 * не содержат звена пути `/merge`, `/approve`, `/approvals`, `/reviews` и операций GraphQL
 * слияния и ревью. Существительное `merge_requests` и метод `mergeability` разрешены — тест
 * сам показывает, что его выражения видят разницу.
 */

const KEY_FORBIDDEN = /approv|accept|^merge(?!ability)|automerge|merge(?:mr|pr|request)$/i;
const SOURCE_FORBIDDEN = [
  /\/(?:merge|approve|approvals|unapprove|reviews|auto_merge)\b/,
  /\b(?:mergePullRequest|enablePullRequestAutoMerge|addPullRequestReview|submitPullRequestReview)\b/,
  /\bAPPROVE\b/,
];

const here = dirname(fileURLToPath(import.meta.url));
const access = {
  project: { kind: 'gitlab' as const, ref: 'a/b', baseUrl: 'http://127.0.0.1:9', pushUrl: 'x' },
  token: null,
  fetch: globalThis.fetch,
};

function ports(): [string, ForgePort][] {
  return [
    ['gitlab', createGitlabPort(access)],
    ['github', createGithubPort({ ...access, project: { ...access.project, kind: 'github' } })],
    ['generic', createGenericPort({ ...access.project, kind: 'generic' })],
  ];
}

describe('forge adapters have no merge and no approve (P63)', () => {
  it('the key and source expressions tell merge_requests and mergeability from merging', () => {
    for (const bad of [
      'merge',
      'mergeMr',
      'approve',
      'approveMr',
      'acceptMr',
      'autoMerge',
      'mergeRequest',
    ])
      expect(KEY_FORBIDDEN.test(bad), bad).toBe(true);
    for (const fine of ['mergeability', 'createMr', 'updateMr', 'resolve', 'reply'])
      expect(KEY_FORBIDDEN.test(fine), fine).toBe(false);
    const hits = (text: string) => SOURCE_FORBIDDEN.some((re) => re.test(text));
    expect(hits('`${project}/merge_requests/${iid}`')).toBe(false);
    expect(hits('`${project}/merge_requests/${iid}/merge`')).toBe(true);
    expect(hits('`${repo}/pulls/${n}/merge`')).toBe(true);
    expect(hits('`${project}/merge_requests/${iid}/approve`')).toBe(true);
    expect(hits('`${repo}/pulls/${n}/reviews`')).toBe(true);
    expect(hits('mutation{mergePullRequest(input:{})}')).toBe(true);
    expect(hits('mutation{addPullRequestReviewThreadReply(input:{})}')).toBe(false);
  });

  it('no port object and no module export carries a merge or approve key', () => {
    for (const [kind, port] of ports())
      for (const key of Object.keys(port))
        expect(KEY_FORBIDDEN.test(key), `${kind}.${key}`).toBe(false);
    for (const key of Object.keys(forge)) expect(KEY_FORBIDDEN.test(key), key).toBe(false);
  });

  it('no adapter source names a merge or approve endpoint', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(join(here, file), 'utf8');
      for (const re of SOURCE_FORBIDDEN) expect(re.test(text), `${file} ${re}`).toBe(false);
    }
  });
});
