import { describe, expect, it } from 'vitest';
import { gitVerbs, publishesBeforeDelivery, pushesBranch, sendsPack } from './delivery-publish.ts';

/**
 * RF-BGCD-07: звено до доставки публиковало ветку формами, которые шаблон
 * `deny` CLI не видит, а брокер пуш своей ветки разрешает сам. Разбор слов
 * обязан узнать пуш в любой записи — и не принять за него обычную работу.
 */
describe('publishesBeforeDelivery — публикация в любой записи', () => {
  it.each([
    'git push origin feat/x',
    'Git push origin feat/x',
    'GIT.EXE push origin feat/x',
    '"C:/Program Files/Git/cmd/git.exe" push',
    'C:\\Program\\Git\\bin\\git.exe push',
    '\\git push origin feat/x',
    '"git" push origin feat/x',
    "'git' push origin feat/x",
    'git\tpush origin feat/x',
    'env GIT_TRACE=0 git push',
    'nice git push',
    'echo feat/x | xargs git push origin',
    "bash -c 'git push origin feat/x'",
    "bash -c 'Git push origin feat/x'",
    'sh -c "git --no-pager push"',
    'cmd /c git push origin feat/x',
    'pwsh -c "& git push origin feat/x"',
    'eval git push origin feat/x',
    'X=$(git push origin feat/x)',
    'npm test && git push',
    'git -c gc.auto=0 -C . --git-dir .git push',
    'git send-pack origin feat/x',
    'git -c alias.p=push p origin feat/x',
    'gh pr create --fill',
    '/usr/local/bin/GH pr create',
    'glab mr create --fill',
  ])('%s — публикация', (command) => {
    expect(publishesBeforeDelivery(command)).toBe(true);
  });

  it.each([
    'git commit -m "push later"',
    'git log --grep push',
    'git -C push status',
    "bash -c 'npm test'",
    'gh pr view 12',
    'glab mr list',
    'pnpm run push-schema',
    'git stash push -m wip',
  ])('%s — не публикация', (command) => {
    expect(publishesBeforeDelivery(command)).toBe(false);
  });

  // Осторожность сознательная: слово `git` — вызов git, где бы оно ни стояло.
  // Звену до доставки отказ в `echo git push` ничего не стоит, а пропуск
  // `xargs git push` / `nohup git push` стоил бы публикации.
  it('`git push` аргументом другой программы — тоже отказ (осторожная сторона)', () => {
    expect(publishesBeforeDelivery('echo git push')).toBe(true);
    expect(publishesBeforeDelivery('nohup git push origin feat/x')).toBe(true);
  });

  it('подкоманда — после глобальных ключей; send-pack узнаётся отдельно', () => {
    expect(gitVerbs('git -c a=b --no-pager -C x push')).toEqual(['push']);
    expect(gitVerbs('git status; Git.exe log')).toEqual(['status', 'log']);
    expect(pushesBranch('git send-pack origin main')).toBe(true);
    expect(sendsPack('git send-pack origin main')).toBe(true);
    expect(sendsPack('git push origin main')).toBe(false);
  });
});
