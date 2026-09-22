import {
  buildHandoffPrompt,
  HANDOFF_DEFAULT_CHECKPOINT,
  HANDOFF_MAX_CHAIN,
  restartHandoffProposal,
} from '@agentdeck/contracts/chat-handoff';
import type {
  CarryCandidate,
  CarryOutcome,
  CarryTargetFailure,
} from '@agentdeck/contracts/portable-carry';
import {
  CHAIN_MAX_AGE_MS,
  checkpointInside,
  evaluateHandoff,
  hashFile,
  type HandoffChains,
  type HashFile,
  type StatFile,
} from '../chat/ChatHandoff.ts';
import { continuationTitle } from '../provider-chat/handoff.ts';

/**
 * Незакрытая работа переезжает вместе со средой (П6.1).
 *
 * Среду панель переносит записями канона; работу перенести нечем — транскрипта в
 * чужом формате не существует ни у одного CLI. Но переносить его и не нужно:
 * рабочий каталог у всех CLI один и тот же, файл-опора лежит в нём, и «перенести
 * работу» означает ОТКРЫТЬ у нового CLI разговор, который этот файл прочитает.
 * Ровно это делает продолжение в чистой сессии, и здесь нет ни одного своего
 * механизма — только выбор разговоров и сборка того же продолжения.
 *
 * Что взято готовым и почему именно так:
 *
 * - **Предохранители — `evaluateHandoff`.** Потолок цепочки и «файл-опора слово в
 *   слово тот же» считает он же, что и автопродолжение. Свой список причин здесь
 *   означал бы, что «те же пределы» у двух дорог к одному и тому же на самом деле
 *   разные, и разойтись им ничего не мешает.
 * - **Промпт — `buildHandoffPrompt`.** Новый разговор получает тот же текст, что
 *   получает чистая сессия: прочитай опору, делай следующий шаг, вот исходное
 *   задание. Второй грамматики задания в проекте быть не должно.
 * - **Название — `continuationTitle`.** Суффикс «· продолжение N» не копится, и
 *   переносу незачем знать об этом отдельно.
 *
 * Своего у переноса три вещи, и все три — из-за того, что кнопку жмёт человек, а
 * не конец прогона:
 *
 *  1. **Свежесть опоры не проверяется** (`startedAt: 0`). Прогона, относительно
 *     которого её меряют, тут нет вовсе: человек уходит на другой CLI посреди
 *     работы, и требовать, чтобы опора была записана именно последним прогоном,
 *     значило бы отказывать в переносе ровно тогда, когда он и нужен.
 *  2. **Тумблер автопродолжения не спрашивается** (`auto: true`). Решение уже
 *     принято человеком — оно и есть нажатая кнопка.
 *  3. **Исходный разговор помечается отпечатком опоры** (`noteCheckpoint`): иначе
 *     второй перенос той же нетронутой работы сравнивать не с чем, и петля
 *     закрылась бы только на стороне продолжений.
 */

/** Разговор глазами переноса — чей бы он ни был. */
export interface CarrySourceChat {
  /**
   * Ключ в памяти цепочек: `sessionId` у Claude, `foreignChatKey` у чужого CLI.
   * Второго написания у разговора для цепочек не бывает, поэтому ключ один.
   */
  readonly key: string;
  readonly providerId: string;
  /** Имя провайдера для человека — уезжает в заметку нового разговора. */
  readonly providerName: string;
  /** Идентификатор внутри хранилища провайдера. */
  readonly chatId: string;
  readonly title: string;
  /** Рабочий каталог; без него переносить некуда. */
  readonly cwd?: string;
  /** Последнее касание, мс. */
  readonly updatedAt: number;
  /** Первая реплика человека: исходное задание, если у цепочки своего нет. */
  readonly task: string;
}

/** Что переносу нужно, чтобы СОСТАВИТЬ список. Ничего не пишет. */
export interface CarryPlanDeps {
  readonly chains: HandoffChains;
  readonly stat?: StatFile;
  readonly hash?: HashFile;
  readonly now?: () => number;
}

/** Что переносу нужно, чтобы его ВЫПОЛНИТЬ. */
export interface CarryDeps extends CarryPlanDeps {
  /** Имя нового CLI для человека — уезжает в заметку исходного разговора. */
  readonly targetName: string;
  /**
   * Завести разговор у нового CLI и отправить в него задание. Удача — ключ (для
   * памяти цепочек) и идентификатор хранилища; отказ НАЗЫВАЕТСЯ: три ветки цели
   * (прогон не пошёл, хранилище не завело, задание не ушло) приезжали одним
   * пустым ответом, и исход переноса оставался без единого слова.
   */
  readonly open: (input: {
    title: string;
    cwd: string;
    prompt: string;
  }) => { ok: true; key: string; chatId: string } | { ok: false; failure: CarryTargetFailure };
  /**
   * Заметка в ленту разговора по его ключу. `false` — сказать было некуда: у
   * Claude лента это транскрипт самого CLI, и панель говорит только в живой
   * прогон. Ответ не выбрасывается, а едет в исход.
   */
  readonly notice: (key: string, text: string) => boolean;
}

/**
 * Кандидаты на перенос.
 *
 * Отбор ровно двойной: у разговора есть рабочий каталог и его трогали внутри
 * окна цепочек. Всё остальное решают предохранители, и решают ВСЛУХ — непригодный
 * разговор остаётся в списке с названной причиной. Молча укоротившийся список
 * читается человеком как «переносить нечего», а это другое утверждение.
 *
 * Окно — то же `CHAIN_MAX_AGE_MS`, по которому живёт сама цепочка: разговор,
 * чьё состояние уже забыто, переносить было бы не с чем — ни потолка, ни
 * отпечатка у него больше нет.
 */
export function planCarry(
  sources: readonly CarrySourceChat[],
  deps: CarryPlanDeps,
): CarryCandidate[] {
  const now = (deps.now ?? Date.now)();
  const candidates: CarryCandidate[] = [];

  for (const source of sources) {
    if (!source.cwd) continue;
    if (now - source.updatedAt > CHAIN_MAX_AGE_MS) continue;

    const verdict = verdictFor(source, source.cwd, deps);
    candidates.push({
      key: source.key,
      providerId: source.providerId,
      chatId: source.chatId,
      title: source.title,
      cwd: source.cwd,
      updatedAt: new Date(source.updatedAt).toISOString(),
      checkpoint: HANDOFF_DEFAULT_CHECKPOINT,
      chainDepth: deps.chains.depth([source.key]),
      ready: verdict.ok,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
    });
  }

  // Свежие сверху: человек переносит то, над чем работал только что.
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Перенести один разговор.
 *
 * Приговор считается ЗАНОВО, а не берётся из показанного плана: между показом и
 * нажатием проходит время, за которое цепочка могла дорасти до потолка, а опора
 * — исчезнуть. План — снимок для глаз, решение принимается здесь.
 */
export function carryChat(source: CarrySourceChat, deps: CarryDeps): CarryOutcome {
  const aliases = [source.key];
  if (!source.cwd)
    return { key: source.key, carried: false, reason: 'no_project', noticedSource: false };

  const verdict = verdictFor(source, source.cwd, deps);
  if (!verdict.ok) {
    return { key: source.key, carried: false, reason: verdict.reason, noticedSource: false };
  }

  // Наследство сильнее: задание в промпте и задание в памяти цепочки — одно и то
  // же, иначе второй перенос получил бы не тот текст, что первый.
  const task = (deps.chains.rootTaskOf(aliases) ?? source.task.trim()) || undefined;
  const prompt = buildHandoffPrompt(verdict.proposal, task);
  const depth = deps.chains.depth(aliases) + 1;
  const title = continuationTitle(source.title, depth);

  const opened = deps.open({ title, cwd: source.cwd, prompt });
  // Отказ цели НАЗЫВАЕТСЯ. Прежде три разные беды — прогон не пошёл, хранилище
  // не завело разговор, задание в заведённый разговор не ушло — приезжали одним
  // «не перенесено» без причины, и человеку нечем было отличить неполадку CLI
  // от неполадки панели.
  if (!opened.ok)
    return { key: source.key, carried: false, failure: opened.failure, noticedSource: false };

  const target = checkpointInside(source.cwd, verdict.proposal.checkpoint);
  const checkpointHash = target ? (deps.hash ?? hashFile)(target) : undefined;
  const chainDepth = deps.chains.link(aliases, opened.key, {
    ...(task ? { rootTask: task } : {}),
    ...(checkpointHash ? { checkpointHash } : {}),
  });
  // Исходный разговор помнит, с каким содержимым опоры от него уходили: второй
  // перенос нетронутой работы откажет причиной `checkpoint_unchanged`.
  if (checkpointHash) deps.chains.noteCheckpoint(aliases, checkpointHash);

  // Обе ленты, и обе — о том, что произошло на самом деле. Переписка не
  // переносится, исходный разговор не закрывается, и ни одна из двух строк этого
  // не обещает.
  deps.notice(
    opened.key,
    `Работа продолжена из разговора «${source.title}» (${source.providerName}): переписка не переносится, ` +
      `новый разговор читает ${verdict.proposal.checkpoint} и знает исходное задание.`,
  );
  const noticedSource = deps.notice(
    source.key,
    `Работа перенесена к «${deps.targetName}»: заведён разговор «${title}» (перенос ${chainDepth} из ${HANDOFF_MAX_CHAIN}). ` +
      `Этот разговор не закрыт и не изменён — вернуться в него можно в любой момент.`,
  );

  return {
    key: source.key,
    carried: true,
    chatId: opened.chatId,
    chainDepth,
    noticedSource,
  };
}

/** Перенести выбранные разговоры. Порядок ответа — порядок запроса. */
export function carryChats(
  sources: readonly CarrySourceChat[],
  keys: readonly string[],
  deps: CarryDeps,
): CarryOutcome[] {
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const outcomes: CarryOutcome[] = [];
  for (const key of keys) {
    const source = byKey.get(key);
    // Разговора нет — его удалили между показом и нажатием. Это не «не
    // перенесли по причине», это отсутствие предмета, и причины у него нет.
    if (!source) {
      outcomes.push({ key, carried: false, noticedSource: false });
      continue;
    }
    outcomes.push(carryChat(source, deps));
  }
  return outcomes;
}

/**
 * Приговор предохранителей для одного разговора. Три поля заданы переносом, а не
 * прогоном, и объяснены в шапке модуля: `ok`, `startedAt`, `auto`.
 */
function verdictFor(source: CarrySourceChat, cwd: string, deps: CarryPlanDeps) {
  const previousHash = deps.chains.lastCheckpointHash([source.key]);
  return evaluateHandoff({
    proposal: restartHandoffProposal(HANDOFF_DEFAULT_CHECKPOINT, {
      foreign: source.providerId !== 'claude',
    }),
    cwd,
    ok: true,
    startedAt: 0,
    auto: true,
    depth: deps.chains.depth([source.key]),
    ...(previousHash !== undefined ? { previousHash } : {}),
    ...(deps.stat ? { stat: deps.stat } : {}),
    ...(deps.hash ? { hash: deps.hash } : {}),
  });
}
