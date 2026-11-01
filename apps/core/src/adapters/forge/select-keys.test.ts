import { describe, expect, it } from 'vitest';
import { forgeActionKey, parseForgeActionKey, type ForgeActionKey } from './action-keys.ts';
import { hostOf, projectPathOf, selectForge } from './select.ts';

/**
 * Выбор форжа по адресу remote и формат цели/подсказки outbox: читатель сверки находит факт
 * только по этим строкам, поэтому круг «записал — разобрал» обязан сойтись, а чужая форма —
 * дать `null` (сверка ответит `unknown`), не угаданный ключ.
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HASH = 'c'.repeat(64);

describe('selectForge: host match only, no guessing by name', () => {
  it('reads the host and project path of every remote form', () => {
    expect(hostOf('https://Git.Example.com/acme/app.git')).toBe('git.example.com');
    expect(hostOf('ssh://git@git.example.com:22/acme/app.git')).toBe('git.example.com');
    expect(hostOf('git@github.com:acme/app.git')).toBe('github.com');
    expect(hostOf('/local/path/repo.git')).toBe('');
    expect(projectPathOf('git@github.com:acme/app.git')).toBe('acme/app');
    expect(
      projectPathOf('https://git.example.com/gl/acme/app.git', 'https://git.example.com/gl'),
    ).toBe('acme/app');
  });

  it('an enabled site with the same host picks its kind; the configured repo wins', () => {
    const got = selectForge('https://git.example.com/acme/app.git', {
      gitlab: { enabled: true, baseUrl: 'https://git.example.com/', repo: '' },
    });
    expect(got).toEqual({
      kind: 'gitlab',
      ref: 'acme/app',
      baseUrl: 'https://git.example.com',
      pushUrl: 'https://git.example.com/acme/app.git',
    });
    const pinned = selectForge('git@github.com:acme/app.git', {
      github: { enabled: true, baseUrl: '', repo: 'acme/other' },
    });
    expect(pinned).toMatchObject({
      kind: 'github',
      ref: 'acme/other',
      baseUrl: 'https://github.com',
    });
  });

  it('a disabled site, another host or a host merely named like a forge is generic', () => {
    const site = { enabled: false, baseUrl: 'https://git.example.com', repo: '' };
    expect(selectForge('https://git.example.com/a/b.git', { gitlab: site }).kind).toBe('generic');
    expect(
      selectForge('https://gitlab.internal.example/a/b.git', {
        gitlab: { ...site, enabled: true },
      }).kind,
    ).toBe('generic');
    expect(selectForge('https://gitlab.com/a/b.git', {})).toEqual({
      kind: 'generic',
      ref: 'a/b',
      baseUrl: '',
      pushUrl: 'https://gitlab.com/a/b.git',
    });
  });
});

describe('forge action key codec (outbox target / idempotencyHint)', () => {
  const url = 'https://git.example.com/acme/app.git';
  const keys: ForgeActionKey[] = [
    { kind: 'push', url, ref: 'refs/heads/feat', sha: SHA_A, before: SHA_B },
    { kind: 'push', url, ref: 'refs/heads/feat', sha: SHA_A, before: null },
    { kind: 'ref-delete', url, ref: 'refs/heads/feat', sha: SHA_A },
    { kind: 'ref-delete', url, ref: 'refs/heads/feat', sha: null },
    { kind: 'mr-create', url, sourceBranch: 'feat', bodyHash: HASH },
    { kind: 'mr-update', url, iid: 7, bodyHash: HASH },
    { kind: 'thread-reply', url, iid: 7, threadId: 'T1', bodyHash: HASH, resolve: true },
    { kind: 'thread-reply', url, iid: 7, threadId: 'T1', bodyHash: HASH, resolve: false },
  ];

  it.each(keys.map((k) => [k.kind, k] as const))('%s round-trips', (_kind, key) => {
    const { target, idempotencyHint } = forgeActionKey(key);
    expect(parseForgeActionKey(key.kind, target, idempotencyHint)).toEqual(key);
  });

  it('a credential in the url or a spaced word refuses to encode', () => {
    expect(() =>
      forgeActionKey({
        kind: 'mr-update',
        url: 'https://u:p@git.example.com/a.git',
        iid: 1,
        bodyHash: HASH,
      }),
    ).toThrow(/password/);
    expect(() =>
      forgeActionKey({ kind: 'mr-create', url, sourceBranch: 'a b', bodyHash: HASH }),
    ).toThrow(/one word/);
  });

  it('a foreign shape parses to null, never to a guessed key', () => {
    expect(parseForgeActionKey('push', `${url} refs/heads/a`, `${SHA_A}`)).toBeNull();
    expect(parseForgeActionKey('push', `${url} refs/heads/a`, `xyz -`)).toBeNull();
    expect(parseForgeActionKey('mr-update', `${url} 7`, HASH)).toBeNull();
    expect(parseForgeActionKey('mr-create', `${url} feat extra`, HASH)).toBeNull();
    expect(parseForgeActionKey('thread-reply', `${url} !7 T1`, `${HASH} maybe`)).toBeNull();
    expect(parseForgeActionKey('ref-delete', url, '-')).toBeNull();
  });
});
