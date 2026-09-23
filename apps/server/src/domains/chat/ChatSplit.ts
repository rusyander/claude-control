import { mergeRequestWorkPreamble, reviewLinkPrompt } from '@agentdeck/contracts/model-cascade';
import {
  buildGroupPrompt,
  environmentPreamble,
  // Приведение имени ветки живёт в контрактах: по нему же панель узнаёт, что
  // предложение уже разделено, и второй реализации быть не должно.
  safeBranchName,
  type TaskSplitFailure,
  type TaskSplitGroup,
  type TaskSplitProposal,
  type TaskSplitResult,
  type TaskSplitReview,
  type TaskSplitStarted,
} from '@agentdeck/contracts/task-split';
import type { CascadePlan } from '@agentdeck/contracts/model-cascade';
import type { WorktreeBootstrapState, WorktreeMirrorSettings } from '@agentdeck/contracts';
import {
  addWorktree,
  describeMirror,
  isGitRepo,
  listWorktrees,
  readProjectGit,
} from '../project-git.ts';

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

/** Заведённая копия: каталог и что в него перенёс локальный слой (для преамбулы задания). */
export interface SplitCopy {
  path: string;
  mirror?: string;
}

/** Ровно то, что разделению нужно от git. Отдельным типом — ради теста без репозитория. */
export interface SplitGit {
  isRepo(dir: string): boolean;
  /** Занятые имена веток: локальные плюс те, что держат копии. */
  takenBranches(dir: string): Promise<string[]>;
  /**
   * Завести копию под ветку; возвращает её каталог и строку отчёта зеркала.
   * `base` — от какой ветки отвести новую (группа, ждавшая предшественников).
   */
  addWorktree(dir: string, branch: string, base?: string): Promise<SplitCopy>;
  /**
   * Подготовить копию до старта агента (установка зависимостей). Ждётся;
   * `undefined` — команды нет. Провал — состояние, не исключение.
   */
  bootstrap?(dir: string, copy: string): Promise<WorktreeBootstrapState | undefined>;
}

/**
 * Настоящий git — тот же, которым работает пульт репозитория. `mirrorFor` — что
 * человек дописал к зеркалу копий этого проекта (хранилище панели); копия из
 * разделения получает тот же локальный слой, что и заведённая руками.
 */
export function makeSplitGit(
  mirrorFor: (dir: string) => WorktreeMirrorSettings | undefined = () => undefined,
  bootstrapFor?: (dir: string, copy: string) => Promise<WorktreeBootstrapState | undefined>,
  /** Путь к `.claude.json`: копия разделения получает запись доступа оригинала. */
  claudeJsonPath?: string,
): SplitGit {
  return {
    ...(bootstrapFor ? { bootstrap: bootstrapFor } : {}),
    isRepo: isGitRepo,
    async takenBranches(dir) {
      const [info, worktrees] = await Promise.all([readProjectGit(dir), listWorktrees(dir)]);
      return [
        ...info.branches,
        ...worktrees.worktrees.map((item) => item.branch ?? '').filter(Boolean),
      ];
    },
    async addWorktree(dir, branch, base) {
      const created = await addWorktree(dir, branch, mirrorFor(dir), base, claudeJsonPath);
      return {
        path: created.path,
        ...(created.mirror ? { mirror: describeMirror(created.mirror) } : {}),
      };
    },
  };
}

export const splitGit: SplitGit = makeSplitGit();

/** Запуск прогона группы; `false` — под этим ключом прогон уже идёт. */
export type SplitStart = (input: {
  chatId: string;
  /**
   * Название группы. Нужно чужому провайдеру: разговор заводит его собственное
   * хранилище, и без названия он лёг бы в список под служебным ключом (`new-…`)
   * — до правки от 07.09.2026 так и было.
   */
  title: string;
  prompt: string;
  cwd: string;
  /**
   * Ветка копии. Нужна конвейеру у чужого провайдера: связей панели у его
   * разговоров нет, и ветку, в которой работал ребёнок, кроме как отсюда взять
   * негде — а ревью читает дифф именно её.
   */
  branch: string;
  /** Чем эту группу решено делать; нет — подбор в проекте выключен. */
  assignment?: CascadePlan;
  /** С какого звена стартует чат: `plan` — сперва план на потолке (Т1). */
  stage: 'plan' | 'work';
  /** Сама группа — границы (`owns`, `notes`) и класс уезжают в связь и в план. */
  group: TaskSplitGroup;
  /** Позиция группы в предложении. */
  index: number;
  /** Что группа знает о предшественниках и от какой ветки отведена копия. */
  context?: SplitGroupContext;
  /** Группа ревьюит MR по ссылке (Т7) — стадия и карточка решения у неё свои. */
  review?: SplitReviewTarget;
}) => boolean;

/**
 * Ревью-группа глазами разделения (Т7): что ревьюим и на чьей ветке стоит копия.
 *
 * `onMrBranch: false` значит «ветку MR получить не удалось» — копия отведена от
 * базы. Это не отказ: ревью пойдёт, но по ссылке, а не по диффу копии, и знать
 * об этом должны и агент (в задании), и человек (на карточке).
 */
export interface SplitReviewTarget {
  url: string;
  branch?: string;
  onMrBranch: boolean;
}

/** Что группа, ждавшая своей очереди, знает о тех, кто работал раньше (Т1). */
export interface SplitGroupContext {
  /** От какой ветки отведена копия. */
  base?: string;
  predecessors?: { title: string; branch: string; failed?: boolean }[];
  /** Вопрос разбора и ответ человека, если группу держали. */
  holdAnswer?: { question: string; answer: string };
}

/**
 * Чем делать группу. Считает МАРШРУТ, а не разделение: там известен потолок
 * разговора (оверрайд шапки поверх настроек) и правило проекта, а здесь — только
 * ветки и копии. Разделение переносит ответ в три места сразу, чтобы связь,
 * прогон и карточка не разошлись в том, что кому назначено.
 */
export type SplitAssign = (
  group: TaskSplitGroup,
  prompt: string,
  /** Номер группы в предложении — под ним приезжают ручные замены с карточки. */
  index: number,
) => CascadePlan | undefined;

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
  /** Назначение группы: по нему второе сообщение ребёнку не теряет модель. */
  assignment?: CascadePlan;
  stage: 'plan' | 'work';
  group: TaskSplitGroup;
  index: number;
  /** Задание группы целиком — в связь: из него после плана собирается работа. */
  prompt: string;
  context?: SplitGroupContext;
  /** Ревью по ссылке (Т7): уезжает в связь — по ней рисуется карточка решения. */
  review?: SplitReviewTarget;
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
  /** Подбор модели под группу; нет — правило проекта выключено. */
  assign?: SplitAssign;
  git?: SplitGit;
  /** Часы — в тесте фиксируются, чтобы ключи чатов были предсказуемы. */
  now?: () => number;
  /**
   * Какие группы предложения заводить — индексы. Нет — все. Конвейер уровней
   * (Т1) заводит группы порциями: сразу те, что без ожиданий, потом по одной,
   * когда кончилась цепочка предшественников или ответил человек.
   */
  groups?: number[];
  /** С какого звена стартуют чаты; нет — с работы. */
  stage?: 'plan' | 'work';
  /**
   * Настоящее имя ветки группы — тому, кто ведёт учёт (конвейер уровней).
   * Зовётся ПОСЛЕ того, как копия заведена, и ДО старта прогона: занятое имя
   * получает суффикс, а цепочка группы вправе кончиться раньше, чем вернётся
   * вся порция, — и искать её тогда будут по этому имени.
   */
  claimBranch?: (index: number, branch: string) => void;
  /** От какой ветки отвести копии этой порции и что группы знают о предшественниках. */
  context?: SplitGroupContext;
  /**
   * Спросить у форджа ветку MR ревью-группы (Т7). Нет — спрашивать некому
   * (интеграция не настроена), и в дело идёт ветка из блока агента, а без неё
   * копия отводится от базы с пометкой. Отказ форджа не роняет разделение:
   * колбэк обязан вернуть `undefined`, а не бросить.
   */
  resolveReview?: (review: TaskSplitReview) => Promise<{ branch?: string } | undefined>;
}

/**
 * На какой ветке заводить копию ревью-группы (Т7).
 *
 * Порядок источников — по надёжности, и он же порядок падения: фордж (ветку
 * знает он один) → ветка из блока агента (он называет её по памяти и ошибается)
 * → ничего, копия от базы с пометкой. Отказ форджа разделение не роняет: ревью
 * по ссылке всё равно возможно, а вот молча отвести копию не от той ветки —
 * это уверенные замечания не про тот код.
 */
async function reviewTargetOf(
  review: TaskSplitReview,
  resolve?: SplitTasksInput['resolveReview'],
): Promise<SplitReviewTarget> {
  let fromForge: string | undefined;
  try {
    fromForge = (await resolve?.(review))?.branch;
  } catch {
    fromForge = undefined;
  }
  // Ветку форджа берём КАК ЕСТЬ: она уже настоящее имя ветки, а приведение
  // срезало бы длинную и увело копию на ветку, которой в MR нет.
  if (fromForge) return { url: review.url, branch: fromForge, onMrBranch: true };
  if (review.branch) {
    return { url: review.url, branch: safeBranchName(review.branch), onMrBranch: true };
  }
  return { url: review.url, onMrBranch: false };
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
  assign,
  git = splitGit,
  now = Date.now,
  groups: selected,
  stage = 'work',
  context,
  resolveReview,
  claimBranch,
}: SplitTasksInput): Promise<TaskSplitResult> {
  const chats: TaskSplitStarted[] = [];
  const failures: TaskSplitFailure[] = [];

  const isRepo = git.isRepo(projectPath);
  // Занятые имена читаем ОДИН раз и дальше пополняем сами: перечитывать список
  // после каждой копии — три лишних запуска git ради того, что мы и так знаем.
  const taken = new Set<string>(isRepo ? await git.takenBranches(projectPath) : []);

  const stamp = now();

  // Три фазы, а не одна петля: копии заводятся по очереди (занятые имена
  // пополняются по ходу), подготовка идёт ПАРАЛЛЕЛЬНО (установка зависимостей
  // в четырёх копиях подряд — это четыре раза по минуте), запуск — снова по
  // порядку групп, чтобы ключи чатов и связи шли предсказуемо.
  const prepared: {
    index: number;
    group: TaskSplitGroup;
    branch: string;
    cwd: string;
    isWorktree: boolean;
    /** Строка отчёта зеркала — в преамбулу задания. */
    mirror?: string;
    /** Ревью по ссылке (Т7): предмет и на чьей ветке в итоге стоит копия. */
    review?: SplitReviewTarget;
  }[] = [];

  const chosen = (selected ?? proposal.groups.map((_, index) => index)).filter(
    (index) => index >= 0 && index < proposal.groups.length,
  );
  for (const index of chosen) {
    const group = proposal.groups[index] as TaskSplitGroup;
    // Ревью-группа (Т7) ветку не выдумывает: её копия обязана стоять на ветке
    // MR, иначе читать нечего. Имя такой ветки суффиксом НЕ разводится — с
    // суффиксом это была бы другая ветка, то есть другой дифф.
    const review = group.review ? await reviewTargetOf(group.review, resolveReview) : undefined;
    const wanted = review?.branch ?? safeBranchName(group.branch);
    const exact = Boolean(review?.onMrBranch);
    const branch = isRepo && !exact ? freeBranchName(wanted, taken) : wanted;

    let cwd = projectPath;
    let isWorktree = false;
    let mirror: string | undefined;

    if (isRepo) {
      try {
        const copy = await git.addWorktree(projectPath, branch, context?.base);
        cwd = copy.path;
        mirror = copy.mirror;
        isWorktree = true;
        taken.add(branch);
      } catch (error) {
        failures.push({
          index,
          title: group.title,
          branch,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    prepared.push({ index, group, branch, cwd, isWorktree, mirror, ...(review ? { review } : {}) });
    // Имя ветки известно и больше не изменится — отдаём его СЕЙЧАС, до
    // подготовки копии и до старта прогона: дальше начинается время, за которое
    // цепочка группы успевает и начаться, и кончиться.
    claimBranch?.(index, branch);
  }

  const bootstraps = await Promise.all(
    prepared.map(async (item) => {
      if (!item.isWorktree || !git.bootstrap) return undefined;
      try {
        return await git.bootstrap(projectPath, item.cwd);
      } catch {
        // Подготовка не отклоняется по договору; на всякий случай — как «нет команды».
        return undefined;
      }
    }),
  );

  for (const [position, item] of prepared.entries()) {
    const { index, group, branch, cwd, isWorktree, mirror, review: target } = item;
    const bootstrap = bootstraps[position];
    // Работа в MR (конфликты, замечания) ветку берёт у MR, а дальше — обычная
    // группа: своё задание, свои стадии, без карточки решения по замечаниям.
    const review = target && !group.review?.work ? target : undefined;
    // Ревью по ссылке (Т7) — другое задание и другая стадия: план группе,
    // которая ничего не делает, не нужен, а понижать её нечем (класс `review`
    // держится на потолке).
    const base = review
      ? reviewLinkPrompt({
          url: review.url,
          ...(review.branch ? { branch: review.branch } : {}),
          onMrBranch: review.onMrBranch,
          tasks: group.tasks,
          ...(proposal.shared ? { shared: proposal.shared } : {}),
        })
      : target
        ? `${mergeRequestWorkPreamble({
            url: target.url,
            ...(target.branch ? { branch: target.branch } : {}),
            onMrBranch: target.onMrBranch,
          })}\n\n${buildGroupPrompt(group, proposal.shared)}`
        : buildGroupPrompt(group, proposal.shared);
    const groupStage = review ? 'work' : stage;
    // Копии — преамбула панели первым абзацем: что зазеркалено и установлено,
    // провал подготовки (с хвостом лога) и прямое «начинай с задачи». Группа в
    // общем каталоге работает в окружении человека — ей преамбула не нужна.
    const prompt = isWorktree
      ? `${environmentPreamble({ ...(mirror ? { mirror } : {}), ...(bootstrap ? { bootstrap } : {}) })}\n\n${base}`
      : base;

    // Ключ чата — тот же временный вид, что и у разговора, начатого из панели:
    // настоящим id разговор станет, когда CLI выдаст сессию. Иначе вкладка
    // помнила бы ключ, которого в истории никогда не появится.
    const chatId = `new-${stamp}-${index}`;
    // Чем делать эту группу — решается ОДИН раз и уходит сразу в связь, в
    // прогон и в ответ: три расчёта одного и того же разошлись бы, и человек
    // видел бы в карточке не то, что запустилось.
    const assignment = assign?.(group, prompt, index);
    // Родство — ПЕРЕД запуском: прогон назовёт настоящий ключ сессии сам, и к
    // этому моменту переносить должно быть что (см. `SplitLink`).
    link?.({
      chatId,
      title: group.title,
      branch,
      path: cwd,
      ...(assignment ? { assignment } : {}),
      stage: groupStage,
      group,
      index,
      prompt,
      ...(context ? { context } : {}),
      ...(review ? { review } : {}),
    });
    const started = startRuns
      ? start({
          chatId,
          title: group.title,
          prompt,
          cwd,
          branch,
          ...(assignment ? { assignment } : {}),
          stage: groupStage,
          group,
          index,
          ...(context ? { context } : {}),
          ...(review ? { review } : {}),
        })
      : false;

    chats.push({
      index,
      title: group.title,
      branch,
      chatId,
      path: cwd,
      isWorktree,
      started,
      prompt,
      stage: groupStage,
      ...(assignment
        ? {
            model: assignment.model,
            effort: assignment.effort,
            ...(assignment.kind ? { kind: assignment.kind } : {}),
          }
        : {}),
    });
  }

  return { chats, failures };
}
