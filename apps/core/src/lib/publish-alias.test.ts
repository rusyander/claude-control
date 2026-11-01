import { describe, expect, it } from 'vitest';
import { aliasPublishes } from './publish-alias.ts';

/** Алиас, который публикует, — любая форма из общего списка дорог публикации, в том числе через `!sh`. */
describe('publishing aliases', () => {
  it.each([
    ['push origin HEAD'],
    ['-c http.sslVerify=false push'],
    ['send-email --to=x'],
    ['subtree push --prefix=a origin b'],
    ['!git push --no-verify'],
    ['!/usr/bin/git.exe -C . push'],
    ['!f() { gh pr create --fill; }; f'],
    ['!echo ok && git push'],
  ])('%s publishes', (value) => {
    expect(aliasPublishes(value)).toBe(true);
  });

  it.each([['status -sb'], ['log --oneline'], ['!git fetch && git status'], ['remote -v']])(
    '%s does not publish',
    (value) => {
      expect(aliasPublishes(value)).toBe(false);
    },
  );

  it('follows a chain of aliases, and a loop ends', () => {
    expect(aliasPublishes('pp', { p: 'pp', pp: 'push' })).toBe(true);
    expect(aliasPublishes('a', { a: 'b', b: 'a' })).toBe(false);
  });
});
