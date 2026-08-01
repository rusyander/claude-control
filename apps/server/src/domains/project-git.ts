/**
 * Git выбранного проекта: где я сейчас, что изменено, куда переключиться, как
 * завести ветку, закоммитить и подтянуть чужое. Пять операций — `status`,
 * `checkout`, `checkout -b`, `commit`, `pull`; пуши, ребейзы и удаление веток
 * панель не делает намеренно.
 *
 * `pull` — единственная сетевая операция и единственная, после которой рабочее
 * дерево может остаться в конфликте. Панель его не разрешает и не откатывает:
 * она передаёт вывод git как есть, дальше человек идёт в терминал. Обрезать это
 * до `--ff-only` было бы честнее, но выбор сделан в пользу поведения обычного
 * `git pull` — так кнопка не врёт про то, чем она является.
 *
 * ПОЯВЛЯЕТСЯ ТОЛЬКО ПРИ `.git` в каталоге проекта. Проверяем именно вхождение
 * `.git`, а не запуском git: в рабочем дереве worktree это ФАЙЛ, а не каталог,
 * поэтому `existsSync` без `isDirectory`. Нет `.git` — `isRepo:false`, и клиент
 * не рисует пульт вовсе (не «пустой git», а отсутствие раздела).
 *
 * БЕЗОПАСНОСТЬ. Оболочки нет нигде: `execFile('git', [...])` передаёт аргументы
 * массивом, поэтому ни имя ветки, ни текст коммита не могут стать командой.
 * Сверх этого имя ветки проходит через `git check-ref-format --branch` — это
 * задокументированная проверка самого git, и придумывать свою грамматику имён
 * поверх неё незачем. Переключение разрешено только на СУЩЕСТВУЮЩУЮ локальную
 * ветку из списка: иначе `checkout <что угодно>` отцепил бы HEAD на произвольный
 * коммит, чего никто не просил.
 *
 * Модули: `project-git/exec.ts` — запуск git и его ошибка, `project-git/parse.ts`
 * — разбор вывода, `project-git/read.ts` — состояние репозитория,
 * `project-git/write.ts` — операции записи.
 */

export { CHANGED_FILES_MAX, COMMIT_MESSAGE_MAX } from './project-git/constants.ts';
export { GitError } from './project-git/exec.ts';
export {
  parseBranches,
  parseRemoteBranches,
  parseStatus,
  pickRemote,
} from './project-git/parse.ts';
export { isGitRepo, readProjectGit } from './project-git/read.ts';
export {
  assertBranchName,
  checkoutBranch,
  commitAll,
  createBranch,
  pullChanges,
} from './project-git/write.ts';
