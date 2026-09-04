import {
  buildGroupPrompt,
  // Приведение имени ветки живёт в контрактах: по нему же панель узнаёт, что
  // предложение уже разделено, и второй реализации быть не должно.
  safeBranchName,
  type TaskSplitFailure,
  type TaskSplitProposal,
  type TaskSplitResult,
  type TaskSplitStarted,
} from '@claude-control/contracts/task-split';
import { addWorktree, isGitRepo, listWorktrees, readProjectGit } from '../project-git.ts';

/**
 * Разделение списка задач по нескольким чатам: под каждую группу — своя ветка,
 * своя рабочая копия и свой разговор.
 *
 * Оркестрация живёт на сервере, а не циклом в браузере, и это решение владельца:
 * последовательность «завести копию → запустить прогон» одна на всех, её можно
 * покрыть тестом, и телефон получает разделение тем же запросом, ничего не
 * повторяя у себя.
 *
 * Три правила, которые здесь держатся.
 *
 * 1. КОПИИ ЗАВОДЯТСЯ ПО ОЧЕРЕДИ. `git worktree add` пишет в служебные файлы
 *    одного репозитория, и три параллельных вызова дерутся за них. Прогоны после
 *    этого идут одновременно — но заводятся копии строго друг за другом.
 * 2. СБОЙ ОДНОЙ ГРУППЫ НЕ ОТКАТЫВАЕТ ОСТАЛЬНЫЕ. Упавшая на третьей из четырёх
 *    группа уходит в `failures`, а три готовых чата остаются: сносить чужую
 *    заведённую работу ради красоты отчёта нельзя.
 * 3. ЗАНЯТОЕ ИМЯ ВЕТКИ ПОЛУЧАЕТ СУФФИКС, а не отказ. Модель называет ветки
 *    очевидно (`feature/auth`), и на втором разделении того же проекта имя
 *    повторяется — это норма, а не ошибка человека.
 *
 * Слияния здесь нет и не будет: свести ветки обратно — шаг владельца.
 */

/** Ровно то, что разделению нужно от git. Отдельным типом — ради теста без репозитория. */
export interface SplitGit {
  isRepo(dir: string): boolean;
  /** Занятые имена веток: локальные плюс те, что держат копии. */
  takenBranches(dir: string): Promise<string[]>;
  /** Завести копию под ветку; возвращает её каталог. */
  addWorktree(dir: string, branch: string): Promise<string>;
}

/** Настоящий git — тот же, которым работает пульт репозитория. */
export const splitGit: SplitGit = {
  isRepo: isGitRepo,
  async takenBranches(dir) {
    const [info, worktrees] = await Promise.all([readProjectGit(dir), listWorktrees(dir)]);
    return [
      ...info.branches,
      ...worktrees.worktrees.map((item) => item.branch ?? '').filter(Boolean),
    ];
  },
  async addWorktree(dir, branch) {
    const created = await addWorktree(dir, branch);
    return created.path;
  },
};

/** Запуск прогона группы; `false` — под этим ключом прогон уже идёт. */
export type SplitStart = (input: { chatId: string; prompt: string; cwd: string }) => boolean;

/**
 * Чат группы заведён, прогон ещё НЕ запущен — место для связи с родителем.
 *
 * Отдельным крючком, и это не красота: связь обязана лечь ДО старта. Прогон
 * называет свой настоящий `sessionId` через пару секунд после запуска, и перенос
 * связи на него ищет запись по временному ключу — не найдя, он молча ничего не
 * делает. Пока связи писались после всего разделения, копии больших репозиториев
 * заводились дольше, чем стартовал первый CLI: 3 сентября из четырёх детей
 * родство сохранил только последний, остальные разъехались по списку как чужие
 * разговоры, вместе со своими вопросами к человеку.
 */
export type SplitLink = (chat: {
  chatId: string;
  title: string;
  branch: string;
  path: string;
}) => void;

export interface SplitTasksInput {
  /** Каталог проекта, из которого делят. Не репозиторий — чаты идут в нём же. */
  projectPath: string;
  proposal: TaskSplitProposal;
  /** Запускать прогоны сразу или только завести чаты с готовым заданием. */
  startRuns: boolean;
  start: SplitStart;
  /** Связь с родителем — пишется на каждой удавшейся группе, до её запуска. */
  link?: SplitLink;
  git?: SplitGit;
  /** Часы — в тесте фиксируются, чтобы ключи чатов были предсказуемы. */
  now?: () => number;
}

/** Свободное имя: занятое получает суффикс `-2`, `-3`, … — как вкладки проводника. */
function freeBranchName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${wanted}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}

/**
 * Развести группы по чатам. Возвращает и удачи, и неудачи: карточка в панели
 * показывает то и другое, потому что «завелось два чата из четырёх» — это
 * результат, а не ошибка запроса.
 */
export async function splitTasks({
  projectPath,
  proposal,
  startRuns,
  start,
  link,
  git = splitGit,
  now = Date.now,
}: SplitTasksInput): Promise<TaskSplitResult> {
  const chats: TaskSplitStarted[] = [];
  const failures: TaskSplitFailure[] = [];

  const isRepo = git.isRepo(projectPath);
  // Занятые имена читаем ОДИН раз и дальше пополняем сами: перечитывать список
  // после каждой копии — три лишних запуска git ради того, что мы и так знаем.
  const taken = new Set<string>(isRepo ? await git.takenBranches(projectPath) : []);

  const stamp = now();

  for (const [index, group] of proposal.groups.entries()) {
    const wanted = safeBranchName(group.branch);
    const branch = isRepo ? freeBranchName(wanted, taken) : wanted;
    const prompt = buildGroupPrompt(group, proposal.shared);

    let cwd = projectPath;
    let isWorktree = false;

    if (isRepo) {
      try {
        cwd = await git.addWorktree(projectPath, branch);
        isWorktree = true;
        taken.add(branch);
      } catch (error) {
        failures.push({
          title: group.title,
          branch,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    // Ключ чата — тот же временный вид, что и у разговора, начатого из панели:
    // настоящим id разговор станет, когда CLI выдаст сессию. Иначе вкладка
    // помнила бы ключ, которого в истории никогда не появится.
    const chatId = `new-${stamp}-${index}`;
    // Родство — ПЕРЕД запуском: прогон назовёт настоящий ключ сессии сам, и к
    // этому моменту переносить должно быть что (см. `SplitLink`).
    link?.({ chatId, title: group.title, branch, path: cwd });
    const started = startRuns ? start({ chatId, prompt, cwd }) : false;

    chats.push({ title: group.title, branch, chatId, path: cwd, isWorktree, started, prompt });
  }

  return { chats, failures };
}
