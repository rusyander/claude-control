/**
 * Git выбранного проекта: где я сейчас, что изменено, куда переключиться, как
 * завести ветку, закоммитить, подтянуть чужое и отправить своё. Шесть операций —
 * `status`, `checkout`, `checkout -b`, `commit`, `pull`, `push`; ребейзов и
 * удаления веток панель не делает намеренно.
 *
 * Push отправляет ТОЛЬКО текущую ветку и только вперёд: `--force` и явный
 * refspec не передаются нигде, поэтому переписать чужую историю эта кнопка не
 * может. Появился он вместе с приложением на телефоне — коммит с дороги без
 * возможности отправить бессмыслен.
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
 * ПАРАЛЛЕЛЬНЫЕ КОПИИ (`git worktree`) живут отдельным модулем и отвечают на
 * другой вопрос: как несколько агентов работают над одним репозиторием
 * одновременно, каждый в своей ветке и своём каталоге. Слияния копий панель не
 * делает — свести ветку обратно решает человек.
 *
 * Модули: `project-git/exec.ts` — запуск git и его ошибка, `project-git/parse.ts`
 * — разбор вывода, `project-git/read.ts` — состояние репозитория,
 * `project-git/write.ts` — операции записи, `project-git/worktrees.ts` —
 * параллельные рабочие копии.
 */

export { CHANGED_FILES_MAX, COMMIT_MESSAGE_MAX } from './project-git/constants.ts';
export { GitError, stripGitProgress } from './project-git/exec.ts';
export {
  parseBranches,
  parseRemoteBranches,
  parseStatus,
  pickRemote,
} from './project-git/parse.ts';
export { isGitRepo, readProjectGit, requireRepo } from './project-git/read.ts';
export {
  addWorktree,
  listWorktrees,
  parseWorktrees,
  removeWorktree,
  worktreeDirFor,
  worktreeDirName,
} from './project-git/worktrees.ts';
export {
  assertBranchName,
  checkoutBranch,
  commitAll,
  createBranch,
  pullChanges,
  pushBranch,
} from './project-git/write.ts';
