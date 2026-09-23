import {
  applySplitPlan,
  scanSplitPlanBlocks,
  triageStagePrompt,
  type PredecessorNote,
} from '@agentdeck/contracts/split-plan';
import { safeBranchName, type TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { SplitGroupCleaned, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import type { SplitGroupContext } from './ChatSplit.ts';
import { coded } from '../../lib/server-text.ts';
import { matchText, serverText } from '../../lib/server-texts.ts';

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
   *
   * `claimBranch` зовётся, как только у группы появилось НАСТОЯЩЕЕ имя ветки, и
   * ДО старта её прогона — той же причины, что и `claim` у `startTriage`:
   * занятое имя получает суффикс (`feature/auth-2`), а цепочка группы может
   * кончиться раньше, чем вернётся вся порция. Конец цепочки ищет группу по
   * ветке, и без этого вызова он искал бы по имени, которого в git нет: группа
   * не закрывалась бы никогда, а её преемники с `after` стояли бы вечно.
   */
  launch: (
    record: SplitPlanRecord,
    groups: number[],
    context: SplitGroupContext | undefined,
    claimBranch: (index: number, branch: string) => void,
  ) => Promise<TaskSplitResult>;
  /**
   * Запустить разбор (уровень 1); `deferred` — дерево на паузе, старт отложен.
   *
   * `claim` зовётся, как только у разговора появился ключ, и ДО его запуска.
   * Иначе разбор, ответивший мгновенно (у чужого CLI это обычное дело — прогон
   * может кончиться ошибкой на первом же вздохе), искал бы свою запись в
   * хранилище раньше, чем она туда попала, и его итог пропал бы молча.
   */
  startTriage: (
    record: SplitPlanRecord,
    prompt: string,
    claim: (chatId: string) => void,
  ) => { chatId: string; started: boolean; deferred: boolean };
  /**
   * Цепочка группы кончилась — самое время сверить ветки (Т6): работа легла, и
   * пересечение с соседями теперь факт, а не прогноз. Не задан — сверки нет, всё
   * остальное работает как раньше.
   */
  watchOverlap?: (parentChatId: string) => void;
  /**
   * Сколько групп разделения работает одновременно (настройка проекта). Не
   * задан — без ограничения. Сверх него готовые группы ждут в очереди
   * (`pending`) и стартуют, как только у работающей кончится ход.
   */
  parallel?: (record: SplitPlanRecord) => number;
  log: (message: string, error?: unknown) => void;
  now?: () => Date;
}

/** Что конец хода значит для группы (Д3). */
export interface ChainOutcome {
  status: 'done' | 'failed' | 'awaiting' | 'background';
  waitingFor?: SplitPlanRecord['groups'][number]['waitingFor'];
  /** Хвост ответа — строке группы в хабе (Д16). */
  tail?: string;
  /** Ссылка на MR, названная в ответе (доставка группы). */
  mr?: string;
  /** Что сделано по фактам копии (Д5). */
  result?: SplitPlanRecord['groups'][number]['result'];
  error?: string;
  /** Сколько раз надзор уже повторил упавший ход группы (Д10). */
  retries?: number;
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
    group.chatId = chat.chatId;
    group.path = chat.path;
    group.branch = chat.branch;
    group.startedAt = at;
    // Цепочка группы могла кончиться РАНЬШЕ, чем вернулся её запуск: у чужого
    // CLI ответ приходит в собственном темпе, и короткая работа успевает
    // закрыться, пока порция ещё заводит соседние копии. Написать поверх этого
    // «стартует» значило бы потерять факт: ждавшие её группы стояли бы вечно.
    if (group.status === 'done' || group.status === 'failed') continue;
    group.status = chat.started ? 'started' : 'failed';
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

/**
 * Код вопроса, стоящего перед группой, — чтобы панель показала его на языке
 * интерфейса, а не по-русски.
 *
 * Читается ИЗ ГОТОВОЙ СТРОКИ, а не хранится рядом с ней, по двум причинам.
 * Вопрос обычно пишет агент — свободный текст, шаблоном он не читается и кода
 * не получает, и поле рядом с ним стояло бы пустым у всех записей, кроме одной.
 * А та одна, панельная, лежит на диске с прежних запусков: запись пережила
 * перезапуск, который её и породил, и поле, заведённое сегодня, ей взяться
 * неоткуда. Разбор же узнаёт её и там.
 *
 * Русская строка едет рядом и остаётся запасной: чужому CLI родительская лента
 * умеет только строку, да и клиент постарше кода не знает.
 */
function holdCode(text: string): Pick<SplitPlanView['groups'][number], 'holdCode' | 'holdParams'> {
  const matched = matchText(text);
  if (!matched) return {};
  return {
    holdCode: matched.messageCode,
    ...(matched.params ? { holdParams: matched.params } : {}),
  };
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
    const triage = this.deps.startTriage(record, prompt, (chatId) => {
      record.triageChatId = chatId;
      this.deps.store.set(record);
    });
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
   *
   * От прогона нужны только исход и текст, и потому тип сужен: у чужого CLI
   * прогона в реестре нет вовсе — есть законченный ответ его хранилища.
   */
  onTriageFinished(
    finished: Pick<RunFinished, 'ok' | 'text'> & Partial<RunFinished>,
    aliases: readonly string[],
  ): ChatEvent | undefined {
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
   * Разбор, оборванный перезапуском панели: разморозить разделение.
   *
   * Итог разбора применяет РОВНО ОДИН вызов — завершение его прогона. Штатное
   * закрытие панели гасит CLI (`chatRuns.stopAll`), журнал прогонов на старте
   * выбрасывает запись без живого pid, и завершение не приедет уже никогда:
   * запись остаётся с `triage: undefined`, все группы — `pending`, копий нет, и
   * сдвинуть это нечем (ответ на вопрос отвечает 409 — группы не `held`).
   *
   * Поэтому на старте, когда живые прогоны уже усыновлены, каждая такая запись
   * закрывается: «разбор не получен» — и группы встают на вопрос ЧЕЛОВЕКУ.
   * Автоматически здесь не заводится ничего: разбор обещал развести границы,
   * его нет, и запустить группы за человека значило бы принять за него решение,
   * которое он полчаса назад доверил умной модели. Возраст записи не при чём
   * ровно потому, что без его клика ничего не стартует.
   *
   * `alive` — жив ли чат разбора (усыновлённый прогон). Повторный запуск панели
   * ничего не повторяет: `record.triage` уже стоит.
   */
  recoverInterruptedTriage(
    alive: (chatId: string) => boolean,
  ): { parentChatId: string; event: ChatEvent }[] {
    const notices: { parentChatId: string; event: ChatEvent }[] = [];
    const at = this.now().toISOString();

    for (const record of Object.values(this.deps.store.all())) {
      if (!record.triageChatId || record.triage) continue;
      if (alive(record.triageChatId)) continue;

      let frozen = 0;
      for (const group of record.groups) {
        // Трогаем только нерешённые: всё остальное разбор и не держал.
        if (group.status !== 'pending') continue;
        group.status = 'held';
        group.hold = serverText('split-triage-interrupted-hold');
        frozen += 1;
      }
      record.triage = { at, received: false, interrupted: true, repairs: [], conflicts: [] };
      this.deps.store.set(record);

      notices.push({
        parentChatId: record.parentChatId,
        event: {
          kind: 'notice',
          code: 'triageMissing',
          text: serverText('split-triage-interrupted-notice', { groups: frozen }),
          textCode: 'split-triage-interrupted-notice',
          textParams: { groups: frozen },
        },
      });
    }

    return notices;
  }

  /**
   * Ход звена группы кончился, и следующего звена нет. Что это значит для
   * группы, решает `outcome` (Д3): явный итог (`done`), сбой (`failed`) или
   * пауза, которая группу НЕ закрывает — вопрос человеку, решение по ревью,
   * фоновая команда. Раньше любой конец хода был `done`: хаб писал «готово»,
   * ждавшие группы стартовали от недоделанной ветки, а статус больше не менялся,
   * даже когда человек продолжил ребёнка.
   *
   * Ждущих отпускают только `done` и `failed`. Закрытую группу конец хода не
   * трогает: снова открывает её только новый прогон (`onChainResumed`).
   */
  onChainEnded(link: ChatLink, outcome: ChainOutcome): void {
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return;
    const group = this.groupOf(record, link, ['started', 'awaiting', 'background']);
    if (!group) return;

    const at = this.now().toISOString();
    group.status = outcome.status;
    if (outcome.waitingFor) group.waitingFor = outcome.waitingFor;
    else delete group.waitingFor;
    if (outcome.tail) group.tail = outcome.tail;
    // Ссылку не стираем ходом без неё: вопрос после создания MR MR не отменяет.
    if (outcome.mr) group.mr = outcome.mr;
    if (outcome.result) group.result = outcome.result;
    if (outcome.retries) group.retries = outcome.retries;
    if (outcome.status === 'failed') {
      group.error = outcome.error ?? 'цепочка кончилась ошибкой или остановкой';
    } else delete group.error;
    const closed = outcome.status === 'done' || outcome.status === 'failed';
    if (closed) group.doneAt = at;
    else delete group.doneAt;
    this.deps.store.set(record);
    if (!closed) {
      // Группа ждёт человека и не работает — её место в очереди свободно.
      // Ждавших её это не отпускает: они стоят до `done`/`failed`.
      void this.launchNext(record).catch((error) => {
        this.deps.log('split conveyor: launch from queue failed', error);
      });
      return;
    }

    // Сверка веток (Т6) — до запуска ждавших: работа этой группы уже легла, и
    // считать её пересечения можно прямо сейчас. Оно асинхронное и отдельное:
    // ни один отказ git не должен помешать соседям стартовать.
    this.deps.watchOverlap?.(record.parentChatId);

    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after chain end failed', error);
    });
  }

  /**
   * Освободилось место: сперва дождавшиеся предшественников (их работа уже
   * отстояла очередь раз), потом готовые из очереди.
   */
  private async launchNext(record: SplitPlanRecord): Promise<void> {
    await this.launchUnblocked(record);
    await this.launchReady(record);
  }

  /**
   * В чате группы снова идёт прогон — человек ответил, продолжил ребёнка или
   * панель повторила упавший ход: группа снова «работает» (Д3). Итог прошлого
   * хода больше не правда; ждавших, уже отпущенных, это не возвращает.
   *
   * `chatId` — чат, в котором пошёл прогон: он и есть теперь чат группы. У
   * группы с конвейером первым был чат ПЛАНА, и без этой записи слово родителя
   * (Д7) и сводка ему (Д6) вели в план, а не в работу (живой прогон 23.09).
   */
  onChainResumed(link: ChatLink, chatId?: string): void {
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return;
    const group = this.groupOf(record, link, [
      'started',
      'awaiting',
      'background',
      'done',
      'failed',
    ]);
    if (!group) return;
    if (chatId) group.chatId = chatId;
    group.status = 'started';
    delete group.waitingFor;
    delete group.doneAt;
    delete group.error;
    this.deps.store.set(record);
  }

  /** Запись группы по номеру из связи (Д12), у старых связей — по ветке. */
  private groupOf(
    record: SplitPlanRecord,
    link: ChatLink,
    statuses: readonly SplitPlanRecord['groups'][number]['status'][],
  ): SplitPlanRecord['groups'][number] | undefined {
    const fit = (item: SplitPlanRecord['groups'][number]) => statuses.includes(item.status);
    if (typeof link.groupIndex === 'number') {
      const byIndex = record.groups.find((item) => item.index === link.groupIndex);
      if (byIndex) return fit(byIndex) ? byIndex : undefined;
    }
    if (!link.branch) return undefined;
    return record.groups.find((item) => fit(item) && item.branch === link.branch);
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
      throw coded(
        new Error('Группа не ждёт ответа: вопроса нет или на него уже ответили'),
        'split-hold-not-waiting',
      );
    }
    group.holdAnswer = answer;
    group.status = this.unmet(record, group).length > 0 ? 'waiting' : 'pending';
    this.deps.store.set(record);

    const ready = await this.launchReady(record);
    const unblocked = await this.launchUnblocked(record);
    return {
      chats: [...ready.chats, ...unblocked.chats],
      failures: [...ready.failures, ...unblocked.failures],
    };
  }

  /**
   * Человек отпускает группу, не дожидаясь предшественников.
   *
   * Единственная дверь у группы со статусом `waiting`: ответ на вопрос разбора
   * работает только с `held`, а цепочка предшественника может не кончиться
   * никогда — его остановили, чат удалили, прогон умер вместе с панелью. До
   * 18.09.2026 такая группа стояла вечно и сдвинуть её было нечем.
   *
   * Панель здесь ничего не решает за человека и ничего не скрывает от агента:
   * копия по-прежнему отводится от ветки предшественника, а в задание уезжает
   * прямым текстом, что та работа не закончена (`contextFor` → `unfinished`).
   */
  async release(parentChatId: string, index: number): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'waiting') {
      throw coded(
        new Error('Группа не ждёт предшественников: отпускать нечего'),
        'split-release-not-waiting',
      );
    }
    group.released = true;
    this.deps.store.set(record);
    return this.launchUnblocked(record);
  }

  /**
   * Убрать копию закрытой группы (Д19) — только по кнопке человека: панель сама
   * не удаляет ничего. Без этого копии копились десятками (в живом проекте — 30), и
   * ветки `…-2`, заведённые впустую, висели на `main` годами.
   *
   * Git здесь, как и запуск, снаружи (`remove`): домен решает только, можно ли.
   * Нельзя — группа не закрыта, копии нет или её уже убрали, и ещё одно: в той
   * же копии живёт другая, не закрытая группа (ревью и правки MR делят копию).
   */
  async cleanup(
    parentChatId: string,
    index: number,
    remove: (target: {
      projectPath: string;
      path: string;
      branch: string;
      chatId?: string;
    }) => Promise<SplitGroupCleaned['branch']>,
  ): Promise<SplitGroupCleaned> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    const closed = (status: string): boolean => status === 'done' || status === 'failed';
    if (!record || !group || !group.path || group.cleaned || !closed(group.status)) {
      throw coded(
        new Error('Убирать нечего: группа не закрыта, копии нет или она уже убрана'),
        'split-cleanup-nothing',
      );
    }
    const path = group.path;
    const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
    const shared = record.groups.some(
      (other) =>
        other !== group && other.path && norm(other.path) === norm(path) && !closed(other.status),
    );
    if (shared) {
      throw coded(
        new Error('В этой копии ещё работает другая группа — уберите копию, когда закроется и она'),
        'split-cleanup-shared',
      );
    }
    const branch = await remove({
      projectPath: record.projectPath,
      path,
      branch: group.branch,
      ...(group.chatId ? { chatId: group.chatId } : {}),
    });
    group.cleaned = { at: this.now().toISOString(), branch };
    this.deps.store.set(record);
    return group.cleaned;
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
        ...(group.hold ? { hold: group.hold, ...holdCode(group.hold) } : {}),
        ...(group.holdAnswer ? { holdAnswer: group.holdAnswer } : {}),
        ...(group.chatId ? { chatId: group.chatId } : {}),
        ...(group.path ? { path: group.path } : {}),
        ...(group.base ? { base: group.base } : {}),
        ...(group.error ? { error: group.error } : {}),
        ...(group.waitingFor ? { waitingFor: group.waitingFor } : {}),
        ...(group.result ? { result: group.result } : {}),
        ...(group.tail ? { tail: group.tail } : {}),
        ...(group.mr ? { mr: group.mr } : {}),
        ...(group.retries ? { retries: group.retries } : {}),
        ...(group.cleaned ? { cleaned: group.cleaned } : {}),
      })),
    };
  }

  /** Предшественники, чья цепочка ещё не кончилась. */
  private unmet(record: SplitPlanRecord, group: SplitPlanRecord['groups'][number]): number[] {
    // Отпущенную руками группу не держит никто: человек решил, что ждать не
    // будет, и то, что предшественник не доработал, уезжает ей в заметки.
    if (group.released) return [];
    return group.after.filter((ref) => {
      const dep = record.groups[ref];
      return dep && dep.status !== 'done' && dep.status !== 'failed';
    });
  }

  /**
   * Сколько групп ещё можно завести сейчас. Работающая — та, у которой идёт
   * прогон (`started`) или фоновая команда (`background`); ждущая человека
   * места не занимает. Ответ человека может ненадолго поднять число работающих
   * над потолком — останавливать уже идущий разговор ради очереди нельзя.
   */
  private slots(record: SplitPlanRecord): number {
    const limit = this.deps.parallel?.(record);
    if (!limit || limit < 1) return Number.POSITIVE_INFINITY;
    const running = record.groups.filter(
      (group) => group.status === 'started' || group.status === 'background',
    ).length;
    return Math.max(0, limit - running);
  }

  /** Номера групп в порядке разбора — очередь стартует в нём. */
  private ordered(record: SplitPlanRecord): SplitPlanRecord['groups'] {
    const position = (index: number): number => {
      const at = record.order.indexOf(index);
      return at < 0 ? record.order.length + index : at;
    };
    return [...record.groups].sort((a, b) => position(a.index) - position(b.index));
  }

  /** Порция без ожиданий: всё, что `pending` и ни от кого не зависит, — сколько влезает. */
  private async launchReady(record: SplitPlanRecord): Promise<TaskSplitResult> {
    const ready = this.ordered(record)
      .filter((group) => group.status === 'pending' && this.unmet(record, group).length === 0)
      .map((group) => group.index)
      .slice(0, this.slots(record))
      .sort((a, b) => a - b);
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
    for (const group of this.ordered(record)) {
      if (group.status !== 'waiting' || this.unmet(record, group).length > 0) continue;
      // Места нет — группа остаётся `waiting` без неудовлетворённых
      // предшественников и стартует со следующим освободившимся местом.
      if (this.slots(record) === 0) break;
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
        // Отпущенная группа идёт по ветке, где работа ещё пишется: сказать об
        // этом обязаны заданию, а не только карточке.
        ...(group.released && dep.status !== 'done' && dep.status !== 'failed'
          ? { unfinished: true }
          : {}),
        ...this.touchedBy(record, dep.index),
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

  /**
   * Настоящее имя ветки — в запись, ДО старта прогона группы.
   *
   * Запись заводится с ИМЕНЕМ ИЗ ПРЕДЛОЖЕНИЯ (`safeBranchName`), а git выдаёт
   * занятому имени суффикс, и до 18.09.2026 разница узнавалась только из ответа
   * всей порции. Между этими двумя моментами цепочка группы успевала кончиться
   * (у чужого CLI прогон падает на первом же вздохе), `onChainEnded` не находил
   * группу по ветке, и всё, что её ждало, стояло навсегда.
   */
  private claimBranch(record: SplitPlanRecord, index: number, branch: string): void {
    const group = record.groups[index];
    if (!group || !branch || group.branch === branch) return;
    group.branch = branch;
    this.deps.store.set(record);
  }

  /**
   * Что предшественник уже задел — из сверки веток (Т6).
   *
   * Порядок тут правильный сам собой: сверка зовётся по концу цепочки ДО
   * запуска ждавших, — но считается она асинхронно и может не успеть или
   * отказать вовсе. Поэтому отсутствие счёта — законное состояние: заметка
   * тогда просто не называет файлов, а не срывает запуск группы.
   */
  private touchedBy(
    record: SplitPlanRecord,
    index: number,
  ): { files?: string[]; filesTotal?: number } {
    const counted = record.overlap?.counted.find((item) => item.index === index);
    if (!counted) return {};
    return {
      ...(counted.names && counted.names.length > 0 ? { files: counted.names } : {}),
      filesTotal: counted.files,
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
      result = await this.deps.launch(record, groups, context, (index, branch) =>
        this.claimBranch(record, index, branch),
      );
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
