import { describe, expect, it } from 'vitest';
import { PUSH_UNRESOLVED_CAUSE, pushVerdictOf } from './push-targets.ts';

/**
 * D-S02: формы `git push`, которые писали main, но проходили грубый разбор по
 * пробелам и становились разрешаемой одной кнопкой D-n (холодное ревью 23.10).
 * Каждая строка здесь — ровно та форма, которая проходила.
 */
describe('push targets', () => {
  const facts = { branch: 'feat/x', base: 'main' };

  it.each([
    ['git push origin main', 'main'],
    ['git push origin HEAD:"main"', 'main'],
    ["git push origin 'main'", 'main'],
    ['git push origin HEAD:refs/heads/main', 'main'],
    ['git push origin HEAD:heads/main', 'main'],
    ['git push origin +main', 'main'],
    ['git push origin :main', 'main'],
    ['git push origin develop', 'develop'],
    ['git push origin release/1.2', 'release/1.2'],
    ['git push -o ci.skip origin main', 'main'],
    ['cd /tmp/copy && git push origin main', 'main'],
  ])('%s → protected %s', (command, target) => {
    expect(pushVerdictOf(command, facts)).toEqual({ kind: 'protected', target });
  });

  it('HEAD without a destination is the current branch, HEAD: is the remote default', () => {
    expect(pushVerdictOf('git push origin HEAD', facts)).toBeUndefined();
    expect(pushVerdictOf('git push origin HEAD:HEAD', facts)).toEqual({
      kind: 'protected',
      target: 'main',
    });
  });

  it.each([
    ['git push origin HEAD:$B', 'substitution'],
    ['git push origin "refs/heads/*:refs/heads/*"', 'wildcard'],
    ['git push --all origin', 'all-refs'],
    ['git push --mirror origin', 'all-refs'],
    ['git -c alias.p=push p origin feat/x', 'alias'],
    ['git -c "alias.p=!git push --mirror" p', 'alias'],
    ['git push origin a:b:c', 'wildcard'],
    // Настройка в самой команде: ветка уезжает в main, не называясь main.
    ['git -c push.default=upstream push', 'push-config'],
    ['git -c push.default=matching push origin', 'push-config'],
    ['git --config=push.default=tracking push', 'push-config'],
    ['git --config-env=push.default=PD push', 'push-config'],
    ['git -c remote.origin.push=refs/heads/*:refs/heads/* push', 'push-config'],
    ['git -c "$CFG" push', 'push-config'],
    // Пуш из ДРУГОЙ копии без refspec: её ветка здесь неизвестна.
    ['git -C ../main-copy push', 'other-repo'],
    ['git --git-dir=../main-copy/.git push origin', 'other-repo'],
  ])('%s → unresolved (%s)', (command, why) => {
    expect(pushVerdictOf(command, facts)).toEqual({ kind: 'unresolved', why });
    expect(PUSH_UNRESOLVED_CAUSE[why as keyof typeof PUSH_UNRESOLVED_CAUSE]).toBeTruthy();
  });

  /**
   * RF-DS-06 (повторное ревью 24.10): те же причины в окружении — git слушает
   * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*` так же, как ключи; и соседние
   * настройки цели (`remote.pushDefault`, `branch.*.merge`), и имя, которое git
   * веткой не примет («main » с пробелом).
   */
  it.each([
    ['GIT_DIR=../main-copy/.git git push', 'other-repo'],
    ['GIT_WORK_TREE=../main-copy GIT_DIR=../main-copy/.git git push', 'other-repo'],
    ['env GIT_DIR=../main-copy/.git git push', 'other-repo'],
    ['env -u X GIT_DIR=$D git push', 'other-repo'],
    ['export GIT_DIR=../main-copy/.git; git push', 'other-repo'],
    [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push',
      'push-config',
    ],
    ['GIT_CONFIG_GLOBAL=/tmp/evil.cfg git push', 'push-config'],
    ["GIT_CONFIG_PARAMETERS=\"'push.default'='matching'\" git push", 'push-config'],
    ['git -c remote.pushDefault=upstream push', 'push-config'],
    ['git -c branch.feat/x.merge=refs/heads/main push', 'push-config'],
    ['git push origin "HEAD:main "', 'invalid-ref'],
    ['git push origin "HEAD:ma..in"', 'invalid-ref'],
    [`git push origin "HEAD:ma${String.fromCharCode(1)}in"`, 'invalid-ref'],
    [`git push origin "HEAD:main${String.fromCharCode(0x7f)}"`, 'invalid-ref'],
  ])('%s → unresolved (%s)', (command, why) => {
    expect(pushVerdictOf(command, facts)).toEqual({ kind: 'unresolved', why });
    expect(PUSH_UNRESOLVED_CAUSE[why as keyof typeof PUSH_UNRESOLVED_CAUSE]).toBeTruthy();
  });

  it('PowerShell: an environment twin of the same cause is refused too', () => {
    expect(pushVerdictOf("$env:GIT_DIR='../main-copy/.git'; git push", facts, false)).toEqual({
      kind: 'unresolved',
      why: 'other-repo',
    });
  });

  it('environment that does not steer git, and an explicit own branch elsewhere, stay allowed', () => {
    expect(pushVerdictOf('GIT_TRACE=1 git push', facts)).toBeUndefined();
    expect(
      pushVerdictOf('GIT_SSH_COMMAND="ssh -i k" git push origin feat/x', facts),
    ).toBeUndefined();
    expect(pushVerdictOf('NODE_ENV=test git push', facts)).toBeUndefined();
    expect(pushVerdictOf('GIT_DIR=../other/.git git push origin feat/x', facts)).toBeUndefined();
    expect(pushVerdictOf('git push origin HEAD~1:feat/x', facts)).toBeUndefined();
  });

  it('no refspec and no known branch: the target cannot be proven', () => {
    expect(pushVerdictOf('git push', { base: 'main' })).toEqual({
      kind: 'unresolved',
      why: 'current-branch-unknown',
    });
    expect(pushVerdictOf('git push', facts)).toBeUndefined();
  });

  it('a safe push.default and a named branch elsewhere stay allowed', () => {
    expect(pushVerdictOf('git -c push.default=current push', facts)).toBeUndefined();
    expect(pushVerdictOf('git -c push.default=simple push', facts)).toBeUndefined();
    expect(pushVerdictOf('git -C ../other push origin feat/x', facts)).toBeUndefined();
    expect(pushVerdictOf('git -C ../other push origin main', facts)).toEqual({
      kind: 'protected',
      target: 'main',
    });
  });

  it('a push to the group branch is not refused', () => {
    expect(pushVerdictOf('git push origin feat/x', facts)).toBeUndefined();
    expect(pushVerdictOf('git push -u origin HEAD', facts)).toBeUndefined();
    expect(pushVerdictOf('git status', facts)).toBeUndefined();
  });

  it('local merge into a protected branch counts, into its own branch does not', () => {
    expect(pushVerdictOf('git checkout main && git merge feat/x', facts)).toEqual({
      kind: 'protected',
      target: 'main',
    });
    expect(pushVerdictOf('git merge origin/main', facts)).toBeUndefined();
  });

  it('PowerShell is judged by rough words: a substitution is still unresolved', () => {
    expect(pushVerdictOf('git push origin main', facts, false)).toEqual({
      kind: 'protected',
      target: 'main',
    });
    expect(pushVerdictOf('git push origin HEAD:$env:B', facts, false)).toEqual({
      kind: 'unresolved',
      why: 'substitution',
    });
  });
});
