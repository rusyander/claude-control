import { describe, expect, it } from 'vitest';
import { gitDestroys } from './group-tree-state.ts';

/**
 * Удаление данных git и слияние в одиночном чате (решение владельца 23.10):
 * такое авторежим чата не пропускает, решает человек. Следящие ссылки удалённого
 * и снимки панели возвращаются сами — их уборка не удаление (как у группы).
 */
const destroys = (command: string): boolean => gitDestroys('Bash', { command });

describe('gitDestroys: одиночный чат', () => {
  it('уборка следящих ссылок удалённого — не удаление (как у группы)', () => {
    for (const command of [
      'git update-ref -d refs/remotes/origin/feature/x',
      'git -C ../copy update-ref -d refs/remotes/upstream/old',
    ]) {
      expect(`${command} → ${destroys(command)}`).toBe(`${command} → false`);
    }
  });

  it('удаление любой другой ссылки — удаление, и «старое» после неё не прикрывает её', () => {
    for (const command of [
      'git update-ref -d refs/heads/main',
      'git update-ref -d refs/tags/v1',
      'git update-ref -d refs/heads/main refs/remotes/origin/main',
      'git update-ref -d refs/heads/main refs/agentdeck/backup/x',
      // Снимок панели — единственная копия стёртого; его удаление — потеря (A-17).
      'git update-ref -d refs/agentdeck/backup/20261023-1200',
      'git update-ref --stdin',
      'printf "delete refs/heads/main\\n" | git update-ref --stdin',
    ]) {
      expect(`${command} → ${destroys(command)}`).toBe(`${command} → true`);
    }
  });

  it('перенос и копия поверх существующей ветки (`-M`, `-C`) — удаление; обычный перенос — нет', () => {
    expect(destroys('git branch -M main')).toBe(true);
    expect(destroys('git branch -C old new')).toBe(true);
    // Склеенные `-mf`/`-cf` и `--move --force` — тот же перенос поверх.
    expect(destroys('git branch -mf old main')).toBe(true);
    expect(destroys('git branch -cf old main')).toBe(true);
    expect(destroys('git branch --move --force old main')).toBe(true);
    expect(destroys('git branch -m feature/new')).toBe(false);
    expect(destroys('git branch -mq feature/new')).toBe(false);
    expect(destroys('git branch -c feature/copy')).toBe(false);
    expect(destroys('git branch -a')).toBe(false);
  });

  it('удаление веток, меток, тайника и слияние — удаление в любой обёртке', () => {
    for (const command of [
      'git branch -D old',
      'git branch -dr origin/x',
      'git tag -d v1',
      'git push origin --delete old',
      'git push origin :old',
      'git merge feature',
      'git stash drop',
      'bash -c "git branch -D old"',
      'env git branch -D old',
      'git -C ../x branch -D y',
    ]) {
      expect(`${command} → ${destroys(command)}`).toBe(`${command} → true`);
    }
  });

  it('аудит 23.10: склеенные ключи, сокращения, развёртка и перенос ветки — удаление', () => {
    for (const command of [
      // A-21, A-22
      'git push -fd origin x',
      'git push -df origin x',
      'git push origin --del x',
      'git push --mir origin',
      'git push --pru origin',
      'git branch -qD y',
      'git branch -fd y',
      'git branch --del y',
      'git tag -fd v1',
      'git tag --del v1',
      // A-23: подкоманда из настройки или со входа
      "git -c alias.nb='branch -D' nb y",
      "printf 'branch -D y' | xargs git",
      // A-24: ветка перенесена поверх существующей
      'git branch -f x HEAD~5',
      'git update-ref refs/heads/x HEAD~5',
      // A-25
      'git symbolic-ref -qd HEAD',
      'git replace -fd abc',
    ]) {
      expect(`${command} → ${destroys(command)}`).toBe(`${command} → true`);
    }
  });

  it('обычная работа — не удаление', () => {
    for (const command of [
      'git status',
      'git commit -m "x"',
      'git push origin HEAD:feature',
      'git push -f origin feature',
      'git branch feature/new',
      "git -c alias.st='status' st",
      'git checkout -B feature/x',
      'git pull origin main',
      'git merge --abort',
      'git fetch --prune',
    ]) {
      expect(`${command} → ${destroys(command)}`).toBe(`${command} → false`);
    }
  });
});

/** Инструмент PowerShell (I-08): раньше `gitDestroys` его не судил вовсе. */
const psDestroys = (command: string): boolean => gitDestroys('PowerShell', { command });

describe('gitDestroys: инструмент PowerShell', () => {
  it('удаление и слияние — как в Bash, в любом регистре имени и в обёртках PowerShell', () => {
    for (const command of [
      'git branch -D keep3',
      'git push origin --delete del4',
      'git push origin :del5',
      'git merge side',
      'Git.exe branch -D x',
      "& 'C:\\Program Files\\Git\\cmd\\git.exe' branch -D x",
      'git status; git stash drop',
      "Invoke-Expression 'git branch -D keep4'",
      'iex "git merge side"',
      "Start-Process git -ArgumentList 'branch','-D','x'",
      // Имя git в обёртке — в любом регистре: разбор его тут не видит.
      "Start-Process GIT.EXE -ArgumentList 'merge','side'",
      'git branch `-D x',
      'git branch \u2013D x',
    ]) {
      expect(`${command} → ${psDestroys(command)}`).toBe(`${command} → true`);
    }
  });

  it('обычная работа из PowerShell — не удаление', () => {
    for (const command of [
      'git status',
      'git push origin HEAD:psplain',
      'git merge --abort',
      'git commit -m "fix; git merge later"',
      'Get-ChildItem -Recurse',
      'Remove-Item -Recurse -Force dist',
    ]) {
      expect(`${command} → ${psDestroys(command)}`).toBe(`${command} → false`);
    }
  });

  it('другие инструменты не судятся', () => {
    expect(gitDestroys('Read', { command: 'git branch -D x' })).toBe(false);
  });
});
