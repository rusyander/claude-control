import {
  applySplitPlan,
  scanSplitPlanBlocks,
  triageStagePrompt,
  type PredecessorNote,
} from '@agentdeck/contracts/split-plan';
import { safeBranchName, type TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import type { SplitGroupContext } from './ChatSplit.ts';

/**
 * Конвейер уровней разделения (Т1): разбор ПЕРЕД копиями, порции запуска
 * ПОСЛЕ разбора, ожидание предшественников и ответа человека.
 *
 * До него разделение было одним запросом: копии, связи, прогоны — и всё. Теперь
 * между согласием человека и первым прогоном группы стоит разбор на потолке,
 * который видит все группы и код, а группы стартуют не разом, а по его итогу:
 * без ожиданий — сразу, с `after` — когда кончится цепочка предшественников
 * (их копия ветвится ОТ той ветки), с `hold` — когда ответит человек.
 *
 * Три правила.
 *
 * 1. НИЧЕГО НЕ БЛОКИРУЕТ. Разбор не дал блока, упал, не стартовал — группы
 *    заводятся, как заводились бы без него; лента говорит «разбор не получен».
 *    Панель не заставляет человека ждать умную модель ради того, что и так бы
 *    поехало.
 * 2. ПАМЯТЬ — В ХРАНИЛИЩЕ. Разбор идёт минуты, ожидания — часы, и стенд за это
 *    время перезапускается (см. Т4). Всё, что нужно для порции запуска, лежит в
 *    `SplitPlanRecord`, и после рестарта конвейер продолжает с той же записи.
 * 3. ЗАПУСК — СНАРУЖИ. Домен не знает ни git, ни реестра прогонов: копии и
 *    прогоны заводит колбэк маршрута (`launch`), разбор — `startTriage`. Так
 *    всё это проверяется тестами без единого настоящего прогона.
 */

export interface SplitConveyorStore {
  get(parentChatId: string): SplitPlanRecord | undefined;
  set(record: SplitPlanRecord): void;
  findByTriage(chatIds: readonly string[]): SplitPlanRecord | undefined;
  all(): Record<string, SplitPlanRecord>;
}

export interface SplitConveyorDeps {
  store: SplitConveyorStore;
  /**
   * Завести копии и запустить ПЛАН для групп записи (индексы). Одна порция —
   * один контекст: от какой ветки отводить и что группы знают о предшественниках.
   */
  launch: (
    record: SplitPlanRecord,
    groups: number[],
    context?: SplitGroupContext,
  ) => Promise<TaskSplitResult>;
  /** Запустить разбор (уровень 1); `deferred` — дерево на паузе, старт отложен. */
  startTriage: (
    record: SplitPlanRecord,
    prompt: string,
  ) => { chatId: string; started: boolean; deferred: boolean };
  /**
   * Цепочка группы кончилась — самое время сверить ветки (Т6): работа легла, и
   * пересечение с соседями теперь факт, а не прогноз. Не задан — сверки нет, всё
   * остальное работает как раньше.
   */
  watchOverlap?: (parentChatId: string) => void;
  log: (message: string, error?: unknown) => void;
  now?: () => Date;
}

export interface SplitBeginInput {
  parentChatId: string;
  projectPath: string;
  proposal: SplitPlanRecord['proposal'];
  request: SplitPlanRecord['request'];
}

/** Какие группы порции стартовали — для ответа маршруту и записи. */
function absorb(record: SplitPlanRecord, result: TaskSplitResult, at: string): void {
  for (const chat of result.chats) {
    const group = record.groups.find((item) => item.index === chat.index);
    if (!group) continue;
    group.status = chat.started ? 'started' : 'failed';
    group.chatId = chat.chatId;
    group.path = chat.path;
    group.branch = chat.branch;
    group.startedAt = at;
    if (!chat.started) group.error = 'прогон не запустился';
  }
  for (const failure of result.failures) {
    const group = record.groups.find((item) => item.index === failure.index);
    if (!group) continue;
    group.status = 'failed';
    group.error = failure.message;
    group.doneAt = at;
  }
}

export class SplitConveyor {
  private readonly now: () => Date;
  private readonly deps: SplitConveyorDeps;

  constructor(deps: SplitConveyorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Человек согласился на разделение при включённом подборе: записать
   * разделение и запустить разбор. Копий ещё нет — они заводятся по его итогу.
   * Разбор не стартовал (реестр отказал) — группы заводятся сразу, без него.
   */
  async begin(
    input: SplitBeginInput,
  ): Promise<{ record: SplitPlanRecord; result: TaskSplitResult }> {
    const at = this.now().toISOString();
    const record: SplitPlanRecord = {
      parentChatId: input.parentChatId,
      projectPath: input.projectPath,
      createdAt: at,
      order: input.proposal.groups.map((_, index) => index),
      request: input.request,
      proposal: input.proposal,
      groups: input.proposal.groups.map((group, index) => ({
        index,
        title: group.title,
        branch: safeBranchName(group.branch),
        after: [],
        status: 'pending',
      })),
    };

    // Разбор разводит группы по файлам ДО работы. Ревью по ссылкам (Т7) разводить
    // не надо и нечем: каждая группа читает свой чужой MR в своей копии, ничего
    // не правя, — и разбор на потолке был бы минутами ожидания ради пустого
    // ответа. Такое разделение стартует сразу.
    if (record.proposal.groups.every((group) => group.review)) {
      // Записи разбора не оставляем вовсе: «разбор не получен» здесь читалось бы
      // как сбой, а разбора тут не было и не должно быть.
      this.deps.store.set(record);
      return { record, result: await this.launchReady(record) };
    }

    const prompt = triageStagePrompt({
      ...(input.proposal.shared ? { shared: input.proposal.shared } : {}),
      groups: input.proposal.groups.map((group) => ({
        title: group.title,
        branch: group.branch,
        tasks: group.tasks,
        ...(group.brief ? { brief: group.brief } : {}),
        ...(group.kind ? { kind: group.kind } : {}),
      })),
    });
    const triage = this.deps.startTriage(record, prompt);
    record.triageChatId = triage.chatId;
    this.deps.store.set(record);

    if (triage.started || triage.deferred) {
      return {
        record,
        result: {
          chats: [],
          failures: [],
          triage: { chatId: triage.chatId, path: input.projectPath, started: triage.started },
        },
      };
    }

    // Разбор не стартовал — уровень 1 не блокирует: группы идут как есть.
    record.triage = { at, received: false, repairs: [], conflicts: [] };
    this.deps.store.set(record);
    const result = await this.launchReady(record);
    return { record, result };
  }

  /**
   * Чат разбора закончился: применить блок к записи и завести порцию групп без
   * ожиданий. Событие — в ленту разбора, синхронно (планировщик реестра
   * синхронный); сами копии заводятся следом, вне этого вызова.
   */
  onTriageFinished(finished: RunFinished, aliases: readonly string[]): ChatEvent | undefined {
    const record = this.deps.store.findByTriage(aliases);
    if (!record || record.triage) return undefined;

    const at = this.now().toISOString();
    const titles = record.proposal.groups.map((group) => group.title);
    const scan = finished.ok ? scanSplitPlanBlocks(finished.text, titles) : undefined;
    const applied = scan?.plan ? applySplitPlan(record.proposal.groups, scan.plan) : undefined;

    if (applied) {
      record.order = applied.order;
      for (const group of applied.groups) {
        const source = record.proposal.groups[group.index];
        const state = record.groups[group.index];
        if (!source || !state) continue;
        source.tasks = group.tasks;
        if (group.owns.length > 0) source.owns = group.owns;
        else delete source.owns;
        if (group.notes) source.notes = group.notes;
        else delete source.notes;
        state.after = group.after;
        if (group.hold) state.hold = group.hold;
        state.status = group.hold ? 'held' : group.after.length > 0 ? 'waiting' : 'pending';
      }
    }
    record.triage = {
      at,
      received: Boolean(applied),
      repairs: applied?.repairs ?? [],
      conflicts: applied?.conflicts ?? [],
    };
    this.deps.store.set(record);

    // Счёт — ДО запуска порции: она синхронно переводит готовые группы в
    // «стартует», и считать после неё значило бы сообщить «сразу: 0».
    const held = record.groups.filter((group) => group.status === 'held').length;
    const waiting = record.groups.filter((group) => group.status === 'waiting').length;
    const ready = record.groups.filter((group) => group.status === 'pending').length;

    void this.launchReady(record).catch((error) => {
      this.deps.log('split conveyor: launch after triage failed', error);
    });

    const summary = [
      `стартуют сразу: ${ready}`,
      waiting ? `ждут предшественников: ${waiting}` : '',
      held ? `ждут ответа человека: ${held}` : '',
      applied && applied.conflicts.length > 0
        ? `пересечений разведено: ${applied.conflicts.length}`
        : '',
      applied && applied.repairs.length > 0
        ? `поправлено панелью: ${applied.repairs.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');

    return applied
      ? { kind: 'notice', code: 'triageApplied', text: `Разбор применён — ${summary}.` }
      : {
          kind: 'notice',
          code: 'triageMissing',
          text: `Разбор не получен (${finished.ok ? 'блока в ответе нет' : 'прогон не завершился'}) — группы стартуют как предложено: ${summary}.`,
        };
  }

  /**
   * Цепочка группы кончилась (работа → ревью → правки, либо оборвалась):
   * отметить и запустить тех, кто её ждал. Зовётся планировщиком стадий там,
   * где следующего звена нет; повторный вызов по той же ветке ничего не меняет.
   */
  onChainEnded(link: ChatLink, ok: boolean): void {
    if (!link.branch) return;
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return;
    const group = record.groups.find(
      (item) => item.status === 'started' && item.branch === link.branch,
    );
    if (!group) return;

    group.status = ok ? 'done' : 'failed';
    group.doneAt = this.now().toISOString();
    if (!ok) group.error = 'цепочка кончилась ошибкой или остановкой';
    this.deps.store.set(record);

    // Сверка веток (Т6) — до запуска ждавших: работа этой группы уже легла, и
    // считать её пересечения можно прямо сейчас. Оно асинхронное и отдельное:
    // ни один отказ git не должен помешать соседям стартовать.
    this.deps.watchOverlap?.(record.parentChatId);

    void this.launchUnblocked(record).catch((error) => {
      this.deps.log('split conveyor: launch after chain end failed', error);
    });
  }

  /**
   * Ответ человека на вопрос разбора: группа больше не держится. Если она ещё и
   * ждёт предшественников — остаётся ждать, ответ уедет с ней; иначе стартует
   * сейчас. Возвращает, что завелось (пусто — ждёт).
   */
  async answerHold(parentChatId: string, index: number, answer: string): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'held') {
      throw new Error('Группа не ждёт ответа: вопроса нет или на него уже ответили');
    }
    group.holdAnswer = answer;
    group.status = this.unmet(record, group.after).length > 0 ? 'waiting' : 'pending';
    this.deps.store.set(record);

    const ready = await this.launchReady(record);
    const unblocked = await this.launchUnblocked(record);
    return {
      chats: [...ready.chats, ...unblocked.chats],
      failures: [...ready.failures, ...unblocked.failures],
    };
  }

  /** Запись для пульта: по любому разговору дерева, новейшая из подходящих. */
  view(chatIds: readonly string[]): SplitPlanView | undefined {
    const records = Object.values(this.deps.store.all())
      .filter((record) => chatIds.includes(record.parentChatId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const record = records[0];
    if (!record) return undefined;
    return {
      parentChatId: record.parentChatId,
      ...(record.triageChatId ? { triageChatId: record.triageChatId } : {}),
      ...(record.triage ? { triage: record.triage } : {}),
      // Пересечения (Т6) едут в пульт без отметок «о чём уже сказали»: это
      // память сервера о заметках, а не то, что человеку показывают.
      ...(record.overlap
        ? {
            overlap: {
              at: record.overlap.at,
              files: record.overlap.files,
              mergeOrder: record.overlap.mergeOrder,
              counted: record.overlap.counted,
              unread: record.overlap.unread,
            },
          }
        : {}),
      order: record.order,
      groups: record.groups.map((group) => ({
        index: group.index,
        title: group.title,
        branch: group.branch,
        after: group.after,
        status: group.status,
        ...(group.hold ? { hold: group.hold } : {}),
        ...(group.holdAnswer ? { holdAnswer: group.holdAnswer } : {}),
        ...(group.chatId ? { chatId: group.chatId } : {}),
        ...(group.path ? { path: group.path } : {}),
        ...(group.base ? { base: group.base } : {}),
        ...(group.error ? { error: group.error } : {}),
      })),
    };
  }

  /** Предшественники, чья цепочка ещё не кончилась. */
  private unmet(record: SplitPlanRecord, after: readonly number[]): number[] {
    return after.filter((ref) => {
      const dep = record.groups[ref];
      return dep && dep.status !== 'done' && dep.status !== 'failed';
    });
  }

  /** Порция без ожиданий: всё, что `pending` и ни от кого не зависит. */
  private async launchReady(record: SplitPlanRecord): Promise<TaskSplitResult> {
    const ready = record.groups
      .filter((group) => group.status === 'pending' && this.unmet(record, group.after).length === 0)
      .map((group) => group.index);
    if (ready.length === 0) return { chats: [], failures: [] };

    // Группы с ответом человека получают его в заметки — по одной, у каждой
    // свой контекст; остальные — одной порцией.
    const plain = ready.filter((index) => !record.groups[index]?.holdAnswer);
    const answered = ready.filter((index) => record.groups[index]?.holdAnswer);
    const results: TaskSplitResult[] = [];
    if (plain.length > 0) results.push(await this.runPortion(record, plain, undefined));
    for (const index of answered) {
      results.push(await this.runPortion(record, [index], this.contextFor(record, index)));
    }
    return {
      chats: results.flatMap((result) => result.chats),
      failures: results.flatMap((result) => result.failures),
    };
  }

  /**
   * Группы, дождавшиеся предшественников. По одной: у каждой своя база — ветка
   * ПОСЛЕДНЕГО предшественника по порядку разбора (слить две ветки панель не
   * может, слияние остаётся человеку; остальные предшественники названы в
   * заметках, чтобы агент знал, где искать их правки).
   */
  private async launchUnblocked(record: SplitPlanRecord): Promise<TaskSplitResult> {
    const results: TaskSplitResult[] = [];
    for (const group of record.groups) {
      if (group.status !== 'waiting' || this.unmet(record, group.after).length > 0) continue;
      results.push(
        await this.runPortion(record, [group.index], this.contextFor(record, group.index)),
      );
    }
    return {
      chats: results.flatMap((result) => result.chats),
      failures: results.flatMap((result) => result.failures),
    };
  }

  private contextFor(record: SplitPlanRecord, index: number): SplitGroupContext {
    const group = record.groups[index];
    if (!group) return {};
    const ordered = [...group.after].sort(
      (a, b) => record.order.indexOf(a) - record.order.indexOf(b),
    );
    const predecessors: PredecessorNote[] = ordered
      .map((ref) => record.groups[ref])
      .filter((dep): dep is NonNullable<typeof dep> => Boolean(dep))
      .map((dep) => ({
        title: dep.title,
        branch: dep.branch,
        ...(dep.status === 'failed' ? { failed: true } : {}),
      }));
    // База — последний предшественник, у которого копия действительно была.
    const base = [...ordered]
      .reverse()
      .map((ref) => record.groups[ref])
      .find((dep) => dep && dep.chatId)?.branch;
    const question = group.hold;
    return {
      ...(base ? { base } : {}),
      ...(predecessors.length > 0 ? { predecessors } : {}),
      ...(group.holdAnswer && question
        ? { holdAnswer: { question, answer: group.holdAnswer } }
        : {}),
    };
  }

  private async runPortion(
    record: SplitPlanRecord,
    groups: number[],
    context: SplitGroupContext | undefined,
  ): Promise<TaskSplitResult> {
    // Статус «стартует» ставится ДО запуска: копии заводятся секунды, и второй
    // вызов за это время (ещё один конец цепочки) не должен завести те же группы.
    const at = this.now().toISOString();
    for (const index of groups) {
      const group = record.groups[index];
      if (!group) continue;
      group.status = 'started';
      group.startedAt = at;
      if (context?.base) group.base = context.base;
    }
    this.deps.store.set(record);

    let result: TaskSplitResult;
    try {
      result = await this.deps.launch(record, groups, context);
    } catch (error) {
      for (const index of groups) {
        const group = record.groups[index];
        if (!group) continue;
        group.status = 'failed';
        group.error = error instanceof Error ? error.message : String(error);
      }
      this.deps.store.set(record);
      throw error;
    }
    absorb(record, result, at);
    this.deps.store.set(record);
    return result;
  }
}
