import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';
import type { ServerContext } from '../../context.ts';
import type { SplitPlanGroupRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunSnapshot } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunMeta } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.types.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import {
  allowMainCopyPrompt,
  allowResumePrompt,
  denyResumePrompt,
  outcomesPrompt,
  sameScope,
  type DeferredAskRecord,
  type OutcomeItem,
} from '../../domains/chat/deferred-asks/deferred-asks.ts';
import {
  decideDeferred,
  deferredAsksOf,
  setDeferredResumer,
  type DeferredResumeOutcome,
} from '../../routes/chat/deferred-routes/deferred-store.ts';
import { stageOf } from '../../domains/chat/ChatCascadeStages/ChatCascadeStages.ts';
import { groupDeliverAhead } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import type { PanelDecision } from './rejudge.ts';

/** Через сколько после старта панели продолжать разрешённое: реестр успевает подхватить прогоны. */
const BOOT_REDRIVE_MS = 5_000;
/** Как часто повторять попытку продолжить то, что не удалось завести сразу. */
const REDRIVE_EVERY_MS = 60_000;

export interface DeferredWiringDeps {
  ctx: ServerContext;
  runs: {
    isRunning(chatId: string): boolean;
    describe(chatId: string): RunSnapshot | undefined;
    describeIdle(chatId: string): RunSnapshot | undefined;
    start(chatId: string, options: RunOptions, meta: RunMeta): boolean;
    /**
     * Фоновые субагенты живого процесса разговора между ходами: продолжение с
     * другой подписью закрыло бы процесс вместе с ними (F1, d9869abf), поэтому
     * слово ждёт их конца, как ждёт конца идущего хода.
     */
    liveAgentsOf?(chatId: string): number;
  };
  /**
   * Слово группе её текущим разговором (`runtime.ts` `resumeGroup`): идущий ход
   * — в очередь до его конца, пауза дерева — через ворота, остывшая сессия — с
   * вводной. Ровно тот путь, каким панель продолжает группы и без D-n.
   */
  resumeGroup: (
    group: SplitPlanGroupRecord,
    prompt: string,
    /** Слово ДОШЛО до разговора: «в очереди» ещё не доставка (D-L02). */
    onSent?: () => void,
    /**
     * Текст слова — в миг доставки (`child-tell.ts`); `undefined` — сказать
     * уже нечего, слово не уходит.
     */
    render?: () => string | undefined,
  ) => 'sent' | 'queued' | 'refused';
  /**
   * Повторный суд ждущей записи группы при старте (`rejudge.ts`): правило,
   * по которому вызов ушёл человеку, могло с тех пор научиться решать его само
   * (D-1). `undefined` — по-прежнему человеку. Нет — записи ждут как есть.
   */
  rejudge?: (record: DeferredAskRecord) => Promise<PanelDecision | undefined>;
  /**
   * Ждущая запись группы, исполнять которую негде (`rejudge.ts` `staleFolderOfAsk`):
   * каталог или папка `cd` пропали. Судится каждую минуту, не только при старте (F7).
   */
  staleFolder?: (record: DeferredAskRecord) => PanelDecision | undefined;
  setTimer?: (run: () => void, ms: number) => void;
  /** Повторный обход (по умолчанию каждую минуту) — для проверок он задаётся. */
  setInterval?: (run: () => void, ms: number) => void;
}

export interface DeferredWiring {
  /** Конец хода разговора: отложенные до него продолжения одиночного чата — сейчас. */
  finished(keys: readonly string[]): void;
  /**
   * Обход при старте: сначала повторный суд ждущих записей групп, затем
   * исходы, о которых разговорам не сказано (перезапуск между ними).
   */
  reDrive(): Promise<void>;
}

function promptOf(record: DeferredAskRecord): string {
  if (record.state !== 'allowed') return denyResumePrompt(record);
  return record.kind === 'branchGate' ? allowMainCopyPrompt(record) : allowResumePrompt(record);
}

const groupKey = (scope: Extract<DeferredScope, { kind: 'group' }>): string =>
  `${scope.parentChatId}\u0000${scope.groupIndex}`;

/**
 * Продолжение разговора после исхода D-n (решение 7, D-L12). Группа — своим
 * текущим разговором, ОДНИМ словом обо всех исходах, о которых ей ещё не
 * сказано (разрешено, отказано, истекло); одиночный чат — тем же разговором с
 * параметрами реестра. Параметры прогона на диск не пишутся (в них окружение с
 * ключами), поэтому одиночный чат, которого реестр после перезапуска не знает,
 * сам не продолжается: разрешение живёт свой срок, и следующий ход его
 * использует.
 *
 * «Сказано» — на диске (`toldAt` записи): очередь слов живёт в памяти, и
 * перезапуск панели до доставки иначе терял отказ и истечение навсегда
 * (RF-DL-04). Обход при старте и каждую минуту говорит всё несказанное.
 */
export function wireDeferredAsks(deps: DeferredWiringDeps): DeferredWiring {
  const { ctx, runs } = deps;
  const asks = deferredAsksOf(ctx);
  /**
   * Старт этого процесса. Разрешение, о котором сказал ПРЕЖНИЙ процесс, но
   * вызов которого так и не случился, говорится заново один раз: перезапуск
   * между словом и вызовом отказывал вызову («прогон не в реестре»), и
   * разрешение человека пропадало (RF-DL-06). Часы те же, что у `toldAt`
   * записи (`Date.now` стора).
   */
  const bootAt = Date.now();
  /** Одиночный чат с идущим ходом: номер D-n → ключи, продолжение — на его конце. */
  const parked = new Map<string, string[]>();
  /**
   * Группы, чьё слово лежит в очереди ЭТОГО процесса. Новые исходы второго
   * слова не заводят — их скажет то же слово: текст складывается в миг
   * доставки (`render`). Снимается, когда слово уходит из очереди.
   */
  const queuedGroups = new Set<string>();

  const told = (record: DeferredAskRecord): boolean =>
    record.toldAt !== undefined &&
    (record.state !== 'allowed' || Date.parse(record.toldAt) >= bootAt);

  /** Исход записи разговору ещё не сказан. Истечение говорится только группе. */
  const owed = (record: DeferredAskRecord): record is DeferredAskRecord & OutcomeItem => {
    if (told(record)) return false;
    if (record.state === 'allowed') return true;
    if (record.scope.kind !== 'group') return false;
    return record.state === 'denied' || record.state === 'expired';
  };

  const resumeChat = (record: DeferredAskRecord): DeferredResumeOutcome => {
    const keys = record.scope.kind === 'chat' ? record.scope.chatKeys : record.runKeys;
    // «Ход кончился» — ещё не «свободен»: процесс с фоновыми агентами ждёт их
    // конца, его пробуждение (`finished`) и продолжит (F1).
    const busy = (key: string): boolean =>
      runs.isRunning(key) || (runs.liveAgentsOf?.(key) ?? 0) > 0;
    if (keys.some(busy)) {
      parked.set(record.id, [...keys]);
      return 'parked';
    }
    for (const key of keys) {
      const held = runs.describe(key) ?? runs.describeIdle(key);
      if (!held) continue;
      const options: RunOptions = {
        ...held.options,
        prompt: promptOf(record),
        ...(held.sessionId ? { sessionId: held.sessionId } : {}),
      };
      // Продолжается тот же разговор: разветвление и «придержать» — от прошлого хода.
      delete options.fork;
      delete options.hold;
      const started = runs.start(held.key, options, {
        ...held.meta,
        ...(held.sessionId ? { sessionId: held.sessionId } : {}),
      });
      if (started) asks.markTold([record.id]);
      return started ? 'sent' : 'none';
    }
    return 'none';
  };

  const groupOf = (scope: Extract<DeferredScope, { kind: 'group' }>) =>
    ctx.store.getSplitPlan(scope.parentChatId)?.groups.find((e) => e.index === scope.groupIndex);

  /**
   * План отменён или группу убрал человек: говорить некому. Отзыв закрывает
   * ждущие и разрешённые записи, но отказ или истечение, ещё не сказанные к
   * этому мигу, будили бы закрытую группу словом — решением, обходом или
   * после перезапуска (RF-DL-10).
   */
  const removed = (scope: Extract<DeferredScope, { kind: 'group' }>): boolean =>
    Boolean(ctx.store.getSplitPlan(scope.parentChatId)?.cancelledAt || groupOf(scope)?.droppedAt);

  /** Стадия разговора по его ключам — первая найденная связь. */
  const stageOfKeys = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const link = ctx.store.getChatLink(key);
      if (link) return stageOf(link);
    }
    return undefined;
  };

  /**
   * Своя ли у группы сейчас MR: её ведёт звено доставки, а без звена доставки —
   * сама цепочка. Ревью отчётом и работа до доставки MR не держат, и слово «снимите
   * черновик, доведите доставку» вело оркестратор ревью к чужой работе (F1, d9869abf).
   */
  const ownsMr = (scope: Extract<DeferredScope, { kind: 'group' }>): boolean => {
    const group = groupOf(scope);
    if (!group) return true;
    if (group.chatId && stageOfKeys([group.chatId]) === 'deliver') return true;
    return !groupDeliverAhead(group);
  };

  /**
   * Что сказать группе сейчас: все несказанные исходы её записей. Одни
   * истечения при ещё ждущей записи — молчание: группа и так стоит на ней, а
   * исход ждущей скажет и про истёкшие.
   */
  const compose = (scope: Extract<DeferredScope, { kind: 'group' }>) => {
    // И слово, уже лежащее в очереди, не уходит: текст складывается в миг доставки.
    if (removed(scope)) return undefined;
    const mine = asks.all().filter((record) => sameScope(record.scope, scope));
    const items = mine.filter(owed);
    const waiting = mine.filter((record) => record.state === 'waiting').map((r) => r.id);
    const speaks =
      items.some((record) => record.state !== 'expired') ||
      (items.length > 0 && waiting.length === 0);
    if (!speaks) return undefined;
    return {
      text: outcomesPrompt(items, waiting, ownsMr(scope)),
      states: new Map(items.map((record) => [record.id, record.state])),
    };
  };

  const tellGroup = (scope: Extract<DeferredScope, { kind: 'group' }>): DeferredResumeOutcome => {
    const key = groupKey(scope);
    if (queuedGroups.has(key)) return 'queued';
    const group = groupOf(scope);
    // Группу поставил на паузу человек — слово её не снимает: исход ждёт на
    // диске, и обход после паузы его скажет (RF-DL-05).
    if (!group || group.status === 'paused') return 'none';
    const first = compose(scope);
    if (!first) return 'none';
    let rendered: typeof first | undefined;
    // Разговор, которому слово сказано. Слово могло ждать (конец хода, фоновые
    // агенты, F1), а группа за это время ушла в следующее звено: будить
    // закончившееся звено — второй агент в той же копии. Тогда слово говорится
    // заново — текущему разговору группы.
    const addressed = group.chatId;
    const render = (): string | undefined => {
      // Слово уходит из очереди: дальше его судьба — доставка или отказ, и
      // повторный обход снова вправе говорить (RF-DL-13).
      queuedGroups.delete(key);
      if (groupOf(scope)?.chatId !== addressed) {
        (deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref?.()))(() => {
          tellGroup(scope);
        }, 0);
        return undefined;
      }
      rendered = compose(scope);
      return rendered?.text;
    };
    // Пометка «сказано» — по факту доставки: до неё слово может лежать в
    // очереди в памяти и пропасть с перезапуском (D-L02).
    const outcome = deps.resumeGroup(
      group,
      first.text,
      () => {
        const said = rendered ?? first;
        asks.markTold([...said.states.keys()], said.states);
      },
      render,
    );
    if (outcome === 'queued') queuedGroups.add(key);
    return outcome === 'refused' ? 'none' : outcome;
  };

  const resume = async (record: DeferredAskRecord): Promise<DeferredResumeOutcome> =>
    record.scope.kind === 'chat' ? resumeChat(record) : tellGroup(record.scope);

  setDeferredResumer(ctx, resume);

  /**
   * Срок записи вышел без ответа человека (или разрешение — неиспользованным):
   * это тоже исход, и группе нужно слово, иначе разговор стоял бы ожиданием
   * записи, которой уже нет, а MR остался бы черновиком навсегда (D-L12).
   * Слово — после того, как уборка кончилась: истекают часто несколько записей
   * разом, и первое слово скажет про все (RF-DL-03).
   */
  asks.onExpired((record) => {
    const { scope } = record;
    if (scope.kind !== 'group') return;
    queueMicrotask(() => {
      tellGroup(scope);
    });
  });

  /** Всё несказанное: группам — по слову, одиночным чатам — разрешённое. */
  const driveAll = (): void => {
    const groups = new Map<string, Extract<DeferredScope, { kind: 'group' }>>();
    for (const record of asks.all()) {
      if (!owed(record)) continue;
      if (record.scope.kind === 'group') groups.set(groupKey(record.scope), record.scope);
      else resumeChat(record);
    }
    for (const scope of groups.values()) tellGroup(scope);
  };

  /**
   * Ждущие записи групп, которые панель теперь решает сама: решение — тем же
   * путём, что ответ человека (`decideDeferred`), с пометкой `auto`, и слово
   * группе говорит, что решила панель. Сбой суда одной записи оставляет её
   * человеку и не мешает остальным.
   */
  const rejudgeWaiting = async (
    rejudge: NonNullable<DeferredWiringDeps['rejudge']>,
  ): Promise<void> => {
    for (const record of asks.all()) {
      if (record.state !== 'waiting' || record.scope.kind !== 'group') continue;
      if (removed(record.scope)) continue;
      const decision = await rejudge(record).catch(() => undefined);
      if (!decision) continue;
      await decideDeferred(ctx, record.id, { ...decision, via: 'auto' });
      console.info(`deferred: ${record.id} decided by the panel re-check (${decision.behavior})`);
    }
  };

  /**
   * Ждущие записи групп, исполнять которые больше некому или негде (F7, split
   * d9869abf): стадия, спросившая вызов, кончилась (ревью сдало отчёт, а D-9 его
   * пересборки ждал человека до вечера и держал MR черновиком), или пропала папка.
   * Отказ — тем же путём, что ответ человека, с пометкой `auto` и причиной агенту.
   */
  const closeStale = async (): Promise<void> => {
    for (const record of asks.all()) {
      if (record.state !== 'waiting' || record.scope.kind !== 'group') continue;
      if (removed(record.scope)) continue;
      const decision = staleStage(record) ?? deps.staleFolder?.(record);
      if (!decision) continue;
      await decideDeferred(ctx, record.id, { ...decision, via: 'auto' });
      console.info(`deferred: ${record.id} closed as stale (${decision.message ?? ''})`);
    }
  };

  /** Стадия, где спросили, уже не текущая стадия группы. */
  const staleStage = (record: DeferredAskRecord): PanelDecision | undefined => {
    if (record.scope.kind !== 'group') return undefined;
    const group = groupOf(record.scope);
    if (!group?.chatId) return undefined;
    const asked = stageOfKeys(record.runKeys);
    const now = stageOfKeys([group.chatId]);
    if (!asked || !now || asked === now) return undefined;
    return {
      behavior: 'deny',
      message:
        `Nothing ran: the ${asked} stage that asked for it has ended (the work is now in the ` +
        `${now} stage). Redo the step in this stage if it is still needed.`,
    };
  };

  /**
   * Повторный обход: исход, который некуда было сказать (пауза группы, разговор
   * не в реестре, занятый старт, отказ очереди), иначе ждал перезапуска панели —
   * человек разрешил, а группа узнавала об этом только после рестарта (D-L05).
   */
  const everyMinute = deps.setInterval ?? ((run, ms) => setInterval(run, ms).unref?.());
  everyMinute(() => {
    void closeStale()
      .catch(() => undefined)
      .then(() => {
        try {
          driveAll();
        } catch {
          // Сбой обхода не роняет сервер: следующий обход через минуту.
        }
      });
  }, REDRIVE_EVERY_MS);

  return {
    finished(keys) {
      for (const [id, waiting] of [...parked]) {
        if (!waiting.some((key) => keys.includes(key))) continue;
        parked.delete(id);
        const record = asks.get(id);
        if (!record || (record.state !== 'allowed' && record.state !== 'denied')) continue;
        // Конец хода ещё держит прогон в реестре «идущим» — продолжение на следующем тике.
        (deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref?.()))(() => {
          resumeChat(record);
        }, 0);
      }
    },
    async reDrive() {
      if (deps.rejudge) await rejudgeWaiting(deps.rejudge);
      await closeStale().catch(() => undefined);
      driveAll();
    },
  };
}

/** Обход при старте — с задержкой: реестр подхватывает прогоны из журнала не сразу. */
export function scheduleDeferredReDrive(wiring: DeferredWiring, ms = BOOT_REDRIVE_MS): void {
  const timer = setTimeout(() => {
    void wiring.reDrive().catch(() => undefined);
  }, ms);
  timer.unref?.();
}
