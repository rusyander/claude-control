import {
  buildHandoffPrompt,
  HANDOFF_MAX_CHAIN,
  scanHandoffBlocks,
  scanHandoffProse,
  type HandoffProposal,
  type HandoffRefusal,
} from '@agentdeck/contracts/chat-handoff';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { RunOptions } from '../chat/ChatRunner.ts';
import type { RunMeta } from '../chat/ChatRunRegistry.ts';
import type { TreeStartGate } from '../chat/tree-pause.ts';
import {
  checkpointInside,
  evaluateHandoff,
  hashFile,
  type HandoffChains,
  type HashFile,
  type StatFile,
} from '../chat/ChatHandoff.ts';
import type { ProviderChatCascade } from './store.ts';

/**
 * Продолжение работы в чистой сессии у ЧУЖОГО CLI (Т7 партии «автономия у чужих
 * CLI»).
 *
 * Ручное продолжение по блоку у чужих провайдеров работало и раньше — карточка
 * в ленте и маршрут `/api/chat/handoff`. Не работала НАДСТРОЙКА, ради которой
 * продолжение вообще заводили: слова агента вместо блока, автоматический
 * перезапуск без человека у панели, потолок цепочки и остановка круга, когда
 * файл-опора не изменился. Всё это лежит в `domains/chat/ChatHandoff.ts` и
 * провайдера не знает вовсе — здесь только подключение и то единственное, чем
 * чужой CLI отличается.
 *
 * А отличается он одним: СЕССИИ У НЕГО НЕТ. У Claude «чистая сессия» означает
 * прогон без `--resume` — тот же чат, новое окно. У чужого CLI каждый запуск и
 * так одноразовый, а переписка живёт в файле панели, поэтому продолжение — это
 * НОВЫЙ разговор в том же каталоге с заданием из предложения и исходной задачей
 * цепочки. Обещать человеку «продолжим с того же места» тут нельзя, и панель
 * этого не обещает — ни текстом кнопки, ни заметкой в ленте.
 */

/** Что панель знает о закрывшемся разговоре. */
export interface ForeignHandoffInput {
  providerId: string;
  /** Идентификатор закрывшегося разговора в хранилище провайдера. */
  chatId: string;
  ok: boolean;
  text: string;
  /** Момент старта прогона: файл-опора обязан быть свежее него. */
  startedAt: number;
  /** Рабочий каталог разговора; без него продолжать негде. */
  cwd?: string;
  /** Название закрывшегося разговора — от него называется продолжение. */
  title: string;
  /** Первая реплика человека: исходное задание цепочки, если своего ещё нет. */
  task: string;
  /** Назначение разговора: продолжение идёт тем же, чем шла работа. */
  model?: string;
  effort?: string;
  /** Шапка звена: продолжение остаётся тем же звеном той же группы. */
  cascade?: ProviderChatCascade;
  /** Связь разговора: продолжение наследует её целиком. */
  link?: ChatLink;
}

/** Чем панель заводит продолжение; всё, что пишет, подаётся снаружи. */
export interface ForeignHandoffDeps {
  chains: HandoffChains;
  /**
   * Завести разговор продолжения и вернуть его идентификатор. Пусто — хранилище
   * отказало, и продолжения не будет.
   */
  open: (input: {
    title: string;
    cwd: string;
    model?: string;
    effort?: string;
    cascade?: ProviderChatCascade;
  }) => string | undefined;
  /** Отправить задание в заведённый разговор. */
  run: (chatId: string, prompt: string, cascade?: ProviderChatCascade) => void;
  /** Связь продолжения: та же группа, тот же родитель, та же стадия. */
  saveLink?: (chatKey: string, link: ChatLink) => void;
  /** Ворота паузы дерева (Т5): стоящее дерево продолжений не запускает. */
  gate?: TreeStartGate;
  stat?: StatFile;
  hash?: HashFile;
}

/** Чем кончилась попытка продолжить. */
export interface ForeignHandoffOutcome {
  /** Разговор продолжения заведён. */
  chatId?: string;
  chainDepth?: number;
  /** Дерево стоит: разговор заведён, запуск в очереди. */
  deferred?: boolean;
  /** Почему продолжения не будет. */
  reason?: HandoffRefusal;
  /** Строка в ленту закрывшегося разговора; пусто — говорить не о чем. */
  notice?: string;
}

/**
 * Название продолжения. Суффикс не копится: «Группа · работа · продолжение 3»
 * читается, «… · продолжение · продолжение · продолжение» — нет.
 */
export function continuationTitle(title: string, depth: number): string {
  const base = title.replace(/\s*·\s*продолжение(\s+\d+)?\s*$/u, '').trim() || 'Разговор';
  return `${base} · продолжение${depth > 1 ? ` ${depth}` : ''}`;
}

/**
 * Отказ, о котором человек должен узнать. Молчим ровно о двух: блока в ответе не
 * было (это каждый второй ход) и автомат выключен (человек его сам и выключил).
 * Остальное — предохранители, и сработавший предохранитель без объяснения
 * выглядит как «панель ничего не сделала».
 */
export function refusalNotice(reason: HandoffRefusal): string | undefined {
  switch (reason) {
    case 'chain_cap':
      return 'Продолжений подряд накопилось слишком много — цепочка остановлена. Продолжите вручную, если работа не закончена.';
    case 'checkpoint_unchanged':
      return 'Файл-опора не изменился с прошлого продолжения: агент ходит по кругу, и новый разговор прочитал бы ровно то же. Цепочка остановлена.';
    case 'checkpoint_stale':
      return 'Файл-опора не обновлён в этом прогоне — продолжать не по чему. Попросите агента записать состояние и повторите.';
    case 'checkpoint_missing':
      return 'Файл-опора не найден в рабочем каталоге — продолжать не по чему.';
    case 'run_failed':
      return 'Прогон не завершился успешно — продолжение не заводится: в разговоре осталась работа, а не результат.';
    case 'no_project':
      return 'У разговора нет рабочего каталога — новый разговор заводить негде.';
    default:
      return undefined;
  }
}

/**
 * Продолжать ли — и если да, завести продолжение.
 *
 * Предохранители те же самые и в том же порядке, что у Claude: их считает
 * `evaluateHandoff`, и второй их копии здесь нет намеренно — разойдясь, они
 * означали бы, что «те же пределы» у двух провайдеров на самом деле разные.
 */
export function planForeignHandoff(
  input: ForeignHandoffInput,
  deps: ForeignHandoffDeps,
): ForeignHandoffOutcome | undefined {
  const aliases = [foreignChatKey(input.providerId, input.chatId)];
  // Блок сильнее прозы: он называет, что закрыто и чем продолжить. Проза —
  // «перезапустите сессию», «/clear», «продолжай по .agent/PROGRESS.md» — то же
  // предложение словами, и дальше его ждут ровно те же предохранители.
  const proposal = scanHandoffBlocks(input.text).proposals.at(-1) ?? scanHandoffProse(input.text);
  const previousHash = deps.chains.lastCheckpointHash(aliases);
  const verdict = evaluateHandoff({
    ...(proposal ? { proposal } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ok: input.ok,
    startedAt: input.startedAt,
    auto: deps.chains.isAuto(aliases),
    depth: deps.chains.depth(aliases),
    ...(previousHash !== undefined ? { previousHash } : {}),
    ...(deps.stat ? { stat: deps.stat } : {}),
    ...(deps.hash ? { hash: deps.hash } : {}),
  });

  if (!verdict.ok) {
    const notice = refusalNotice(verdict.reason);
    return notice ? { reason: verdict.reason, notice } : undefined;
  }
  return startForeignHandoff(
    { ...input, cwd: input.cwd as string, proposal: verdict.proposal },
    deps,
  );
}

/**
 * Завести продолжение: новый разговор в ТОМ ЖЕ каталоге, тем же назначением и с
 * той же связью. Копий репозитория тут не заводится и ветка не меняется — работа
 * та же самая, меняется только окно контекста.
 *
 * Отдельная функция, потому что зовут её двое: планировщик (сам, по ответу
 * агента) и кнопка «Перезапустить сессию» в шапке разговора. Два пути к одному и
 * тому же разошлись бы на первой же правке.
 */
export function startForeignHandoff(
  input: ForeignHandoffInput & { cwd: string; proposal: HandoffProposal },
  deps: ForeignHandoffDeps,
): ForeignHandoffOutcome | undefined {
  const aliases = [foreignChatKey(input.providerId, input.chatId)];
  // Задание в промпте и задание в памяти цепочки — одно и то же: иначе второе
  // продолжение получило бы не тот текст, что первое. Наследство сильнее.
  const task = (deps.chains.rootTaskOf(aliases) ?? input.task.trim()) || undefined;
  const prompt = buildHandoffPrompt(input.proposal, task);
  const depth = deps.chains.depth(aliases) + 1;

  const created = deps.open({
    title: continuationTitle(input.title, depth),
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.cascade ? { cascade: input.cascade } : {}),
  });
  if (!created) return undefined;

  const nextKey = foreignChatKey(input.providerId, created);
  // Отпечаток файла-опоры сейчас: следующее продолжение сравнит с ним свой и
  // поймёт, что агент ходит по кругу.
  const target = checkpointInside(input.cwd, input.proposal.checkpoint);
  const checkpointHash = target ? (deps.hash ?? hashFile)(target) : undefined;
  const chainDepth = deps.chains.link(aliases, nextKey, {
    ...(task ? { rootTask: task } : {}),
    ...(checkpointHash ? { checkpointHash } : {}),
  });
  // Связь — до запуска и целиком: продолжение остаётся тем же звеном той же
  // группы, иначе дерево потеряет работу на первом же перезапуске.
  if (input.link) {
    deps.saveLink?.(nextKey, { ...input.link, createdAt: new Date().toISOString() });
  }

  // Дерево на паузе — продолжение заведено, но не запущено: старт лёг в очередь
  // и уйдёт по «Продолжить всё».
  if (
    deps.gate?.defer(
      'handoff',
      nextKey,
      { prompt, cwd: input.cwd } as RunOptions,
      { projectPath: input.cwd } as RunMeta,
    )
  ) {
    return {
      chatId: created,
      chainDepth,
      deferred: true,
      notice: `Продолжение заведено («${continuationTitle(input.title, depth)}»), но дерево на паузе — запуск ждёт «Продолжить всё».`,
    };
  }

  deps.run(created, prompt, input.cascade);
  return {
    chatId: created,
    chainDepth,
    // У чужого CLI сессии нет, и заметка обязана говорить именно это: новый
    // разговор, контрольная точка и исходное задание — а не «продолжили с того
    // же места», чего панель обеспечить не может.
    notice: `Работа продолжена в новом разговоре «${continuationTitle(input.title, depth)}» (продолжение ${chainDepth} из ${HANDOFF_MAX_CHAIN}): сессии у CLI нет, поэтому продолжение — новый разговор с контрольной точкой и исходным заданием.`,
  };
}
