import { describe, expect, it } from 'vitest';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import {
  coreBindingState,
  parseReposText,
  reposText,
  withTelegramOwner,
  withTelegramRepos,
} from './telegramCoreBinding';

const FP = 'a'.repeat(64);
const view = {
  doc: { lead: { level: 2 }, telegram: { owner: null } },
  digest: 'd1',
} as unknown as ConfigView;

describe('telegramCoreBinding', () => {
  it('без отпечатка — сначала бот, без ядра — недоступно, иначе по признанию ядра', () => {
    expect(coreBindingState(undefined)).toBe('needBot');
    const base = { ownerName: '', listening: true };
    expect(coreBindingState({ ...base, fingerprint: null, bound: false, reachable: true })).toBe(
      'needBot',
    );
    expect(coreBindingState({ ...base, fingerprint: FP, bound: true, reachable: false })).toBe(
      'unreachable',
    );
    expect(coreBindingState({ ...base, fingerprint: FP, bound: true, reachable: true })).toBe(
      'bound',
    );
    expect(coreBindingState({ ...base, fingerprint: FP, bound: false, reachable: true })).toBe(
      'unbound',
    );
  });

  it('включение пишет отпечаток, выключение — null; прочие разделы и отпечаток настройки целы', () => {
    const on = withTelegramOwner(view, FP);
    expect(on.doc.telegram).toEqual({ owner: FP });
    expect(on.baseDigest).toBe('d1');
    expect((on.doc as unknown as { lead: unknown }).lead).toEqual({ level: 2 });
    expect(withTelegramOwner(view, null).doc.telegram).toEqual({ owner: null });
  });

  it('переключатель меняет только владельца: подпись и прочие поля раздела telegram целы', () => {
    const label = { bot: 'answers_bot', account: 'Анна' };
    const labelled = {
      doc: { telegram: { owner: null, label } },
      digest: 'd2',
    } as unknown as ConfigView;
    expect(withTelegramOwner(labelled, FP).doc.telegram).toEqual({ owner: FP, label });
    expect(withTelegramOwner(labelled, null).doc.telegram).toEqual({ owner: null, label });
  });
});

describe('репозитории записей /task (telegram.repos, W2-D F2)', () => {
  it('строки поля — путь и необязательная ветка через « @ »; пустые строки и повторы пропущены', () => {
    expect(parseReposText('C:/work/app @ main\n\n  C:/work/lib  \nC:/work/lib')).toEqual({
      repos: [
        { path: 'C:/work/app', baseRef: 'main' },
        { path: 'C:/work/lib', baseRef: null },
      ],
    });
    expect(parseReposText('  \n ')).toEqual({ repos: [] });
    expect(parseReposText('/srv/a b @ ')).toEqual({ repos: [{ path: '/srv/a b', baseRef: null }] });
  });

  it('девятая строка, длинный путь или ветка — отказ с причиной, не тихое усечение', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `/r/${i}`).join('\n');
    expect(parseReposText(eight)).toEqual({
      repos: Array.from({ length: 8 }, (_, i) => ({ path: `/r/${i}`, baseRef: null })),
    });
    expect(parseReposText(`${eight}\n/r/8`)).toEqual({ error: 'tooMany' });
    expect(parseReposText('/'.repeat(1001))).toEqual({ error: 'tooLong' });
    expect(parseReposText('/'.repeat(1000))).toEqual({
      repos: [{ path: '/'.repeat(1000), baseRef: null }],
    });
    expect(parseReposText(`/r @ ${'b'.repeat(301)}`)).toEqual({ error: 'tooLong' });
  });

  it('текст поля из настройки — обратный разбору', () => {
    const repos = [
      { path: 'C:/work/app', baseRef: 'main' },
      { path: 'C:/work/lib', baseRef: null },
    ];
    expect(reposText(repos)).toBe('C:/work/app @ main\nC:/work/lib');
    expect(parseReposText(reposText(repos))).toEqual({ repos });
    expect(reposText(undefined)).toBe('');
  });

  it('запись репозиториев не трогает владельца и подпись; пустой список снимает поле', () => {
    const label = { bot: 'answers_bot', account: 'Анна' };
    const bound = {
      doc: {
        lead: { level: 2 },
        telegram: { owner: FP, label, repos: [{ path: '/old', baseRef: null }] },
      },
      digest: 'd3',
    } as unknown as ConfigView;
    const repos = [{ path: '/new', baseRef: 'dev' }];
    const set = withTelegramRepos(bound, repos);
    expect(set.doc.telegram).toEqual({ owner: FP, label, repos });
    expect(set.baseDigest).toBe('d3');
    expect((set.doc as unknown as { lead: unknown }).lead).toEqual({ level: 2 });
    const cleared = withTelegramRepos(bound, []);
    expect(cleared.doc.telegram).toEqual({ owner: FP, label });
    expect('repos' in (cleared.doc.telegram ?? {})).toBe(false);
  });

  it('раздела telegram нет — репозитории пишутся с закрытым каналом (owner null)', () => {
    const bare = { doc: { lead: { level: 2 } }, digest: 'd4' } as unknown as ConfigView;
    expect(withTelegramRepos(bare, [{ path: '/a', baseRef: null }]).doc.telegram).toEqual({
      owner: null,
      repos: [{ path: '/a', baseRef: null }],
    });
  });
});
