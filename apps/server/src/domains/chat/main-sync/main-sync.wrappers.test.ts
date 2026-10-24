import { describe, expect, it } from 'vitest';
import { GROUP_DANGER_ASK } from '../group-profile/group-profile.ts';
import {
  isUnnamedRef,
  MAIN_SYNC_ASK,
  resolvedSyncText,
  syncCandidate,
  syncsWithTarget,
  syncTarget,
  WRAPPER_SHELLS,
} from './main-sync.ts';

/** Правило `ask` CLI: `*` — любая строка, пустая тоже (как в `main-sync.test.ts`). */
function askMatches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? '';
  const pattern = inner
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
    .replace(/ \.\*$/, '(?: .*)?');
  return new RegExp(`^${pattern}$`).test(command);
}

/** Все правила `ask`, что профиль группы отдаёт CLI (`group-profile.ts`). */
const PROFILE_ASK = [...GROUP_DANGER_ASK, ...MAIN_SYNC_ASK];
const reachesBroker = (command: string): boolean =>
  PROFILE_ASK.some((rule) => askMatches(rule, command));

// Повторная проверка 24.10 (b): догон в обёртке, который разбор узнаёт, должен
// дойти до брокера и в авторежиме — иначе его пропустит классификатор CLI.
// Правила строятся из той же таблицы `WRAPPER_SHELLS`, что и разбор.
describe('MAIN_SYNC_ASK — обёртки, что узнаёт разбор, доходят до брокера', () => {
  const script = "'git rebase origin/main'";
  const corpus = [
    `dash -c ${script}`,
    `ksh -c ${script}`,
    `mksh -c ${script}`,
    `env bash -c ${script}`,
    `timeout 60 sh -c ${script}`,
    `bash.exe -c ${script}`,
    `BASH -c ${script}`,
    `Zsh -c ${script}`,
    `/usr/bin/dash -c ${script}`,
    `C:/msys64/usr/bin/ksh.exe -c ${script}`,
    `eval ${script}`,
    `env eval ${script}`,
    ...WRAPPER_SHELLS.map((shell) => `${shell} -c ${script}`),
  ];

  it.each(corpus)('%s: разбор видит догон, правило ведёт к брокеру', (command) => {
    expect(syncsWithTarget(command)).toBe(true);
    expect(syncTarget(command)).toBe('origin/main');
    expect(reachesBroker(command)).toBe(true);
  });

  it('контроль эмулятора: обычная команда и слово-подстрока не задеты', () => {
    expect(reachesBroker('npm test')).toBe(false);
    expect(reachesBroker('ls dashboard')).toBe(false);
    expect(reachesBroker('cat bashrc.txt')).toBe(false);
  });
});

// Цель через `$(git rev-parse …)` и переменную с буквальной ссылкой — сама ссылка.
describe('resolvedSyncText — цель через rev-parse и переменную', () => {
  it.each([
    ['git rebase $(git rev-parse origin/main)', 'git rebase origin/main'],
    ['git merge $(git rev-parse --verify origin/main^{commit})', 'git merge origin/main'],
    ['T=origin/main; git rebase $T', 'T=origin/main\ngit rebase origin/main'],
    ['git rebase origin/main && git push', 'git rebase origin/main && git push'],
  ])('%s → %s', (command, text) => {
    expect(resolvedSyncText(command)).toBe(text);
    expect(syncTarget(resolvedSyncText(command))).toBe('origin/main');
  });

  it('переприсвоение не буквой снимает подстановку: цель снова не назвать', () => {
    const command = 'T=origin/main; T=$(cat ref); git rebase $T';
    expect(resolvedSyncText(command)).toBe(command);
    expect(isUnnamedRef(syncCandidate(command)!)).toBe(true);
  });
});

// Повторная проверка 24.10 (c): цель, которую не назвать до исполнения.
describe('syncCandidate / isUnnamedRef — цель догона не назвать', () => {
  it('git merge - → прошлая ветка копии @{-1}', () => {
    expect(syncCandidate('git merge -')).toBe('@{-1}');
  });

  it.each([
    'git pull origin "$B"',
    'git pull --rebase origin $(cat ref)',
    'git rebase "$T"',
    'git merge `cat ref`',
  ])('%s → кандидат без имени', (command) => {
    const candidate = syncCandidate(command);
    expect(candidate).toBeDefined();
    expect(isUnnamedRef(candidate!)).toBe(true);
  });

  it.each(['git pull', 'git pull --rebase', 'git pull --ff-only origin'])(
    'не кандидат: %s',
    (command) => {
      expect(syncCandidate(command)).toBeUndefined();
    },
  );

  it.each([
    ['"$T"', true],
    ['$(git rev-parse origin/main)', true],
    ['`cat ref`', true],
    ['origin/main', false],
    ['@{-1}', false],
    ['39d90705abc', false],
  ])('isUnnamedRef(%s) → %s', (ref, unnamed) => {
    expect(isUnnamedRef(ref)).toBe(unnamed);
  });
});
