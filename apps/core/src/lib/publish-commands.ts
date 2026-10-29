/**
 * Дороги публикации — ОДИН список для обоих замков (core-s2 F-04): оверлей CLI
 * (`adapters/deny-overlay.ts`, префиксы argv в правилах запрета) и судья (`policy/permit/exec-argv`,
 * формы git, равные push). Два своих списка расходились: судья знал `send-email`/`lfs push`, оверлей —
 * нет. Лежит в `lib/`, потому что переходник не импортирует части, а часть — соседей (depcruise
 * core-adapters-below-parts / core-parts-apart); `publish-commands.test.ts` сверяет оба замка.
 */

/** Подкоманды git, которые публикуют так же, как `push`: «подкоманда» или «подкоманда действие». */
export const GIT_PUSH_EQUIVALENT: readonly (readonly string[])[] = [
  // Те же пакеты другим транспортом: http-push — WebDAV, receive-pack — приёмная сторона в
  // репозиторий на диске, subtree push — push поддерева.
  ['http-push'],
  ['send-pack'],
  ['receive-pack'],
  ['send-email'],
  ['cvsexportcommit'],
  ['subtree', 'push'],
  ['lfs', 'push'],
  ['svn', 'dcommit'],
  ['p4', 'submit'],
];

/**
 * Префиксы argv, запрещённые каждому сеансу: push и его равные, смена адреса push, запись форджа.
 * Чтение форджа сессии получают через прокси только для чтения (03), поэтому `gh api` /
 * `glab api` запрещены целиком: префикс argv не отличает чтение от записи.
 */
export const PUBLISH_COMMANDS: readonly (readonly string[])[] = [
  ['git', 'push'],
  ...GIT_PUSH_EQUIVALENT.map((form) => ['git', ...form]),
  // Адрес push меняется в `.git/config` командой, а не правкой файла: следующий push ядра уйдёт
  // туда (спека 06: запись pushurl закрыта).
  ['git', 'remote', 'set-url', '--push'],
  ['git', 'remote', 'set-url', '--add', '--push'],
  ['gh', 'pr', 'create'],
  ['gh', 'pr', 'edit'],
  ['gh', 'pr', 'merge'],
  ['gh', 'pr', 'review'],
  ['gh', 'pr', 'comment'],
  ['gh', 'pr', 'close'],
  ['gh', 'pr', 'reopen'],
  ['gh', 'pr', 'ready'],
  ['gh', 'pr', 'update-branch'],
  ['gh', 'issue', 'create'],
  ['gh', 'issue', 'comment'],
  ['gh', 'issue', 'edit'],
  ['gh', 'issue', 'close'],
  ['gh', 'issue', 'reopen'],
  ['gh', 'release', 'create'],
  ['gh', 'api'],
  ['glab', 'mr', 'create'],
  ['glab', 'mr', 'update'],
  ['glab', 'mr', 'merge'],
  ['glab', 'mr', 'approve'],
  ['glab', 'mr', 'note'],
  ['glab', 'mr', 'close'],
  ['glab', 'mr', 'reopen'],
  ['glab', 'mr', 'rebase'],
  ['glab', 'issue', 'create'],
  ['glab', 'issue', 'note'],
  ['glab', 'issue', 'update'],
  ['glab', 'issue', 'close'],
  ['glab', 'issue', 'reopen'],
  ['glab', 'release', 'create'],
  ['glab', 'api'],
];
