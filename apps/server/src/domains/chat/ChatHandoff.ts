import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io.ts';
import {
  buildHandoffPrompt,
  HANDOFF_MAX_CHAIN,
  HANDOFF_ROOT_TASK_MAX,
  type HandoffProposal,
  type HandoffStarted,
  type HandoffVerdict,
} from '@agentdeck/contracts/chat-handoff';

/**
 * Продолжение работы в чистой сессии — сторона сервера.
 *
 * Всё, что здесь есть, сводится к двум вопросам: МОЖНО ли продолжать само и ЧТО
 * для этого завести. Первый — проверка предохранителей, второй — заведение
 * нового разговора в том же каталоге. Ни одна из этих операций ничего не
 * удаляет: «очистка» тут означает лишь прогон без `--resume`, а закрытый
 * разговор остаётся в транскриптах Claude Code целиком.
 *
 * Предохранители придуманы не из осторожности вообще, а под конкретные способы
 * потерять работу:
 *
 * 1. ФАЙЛ-ОПОРА ОБНОВЛЁН В ЭТОМ ЖЕ ПРОГОНЕ. Новая сессия знает ровно то, что в
 *    нём написано. Агент объявил «готово», а записать забыл — продолжать не по
 *    чему, и автопродолжение отказывает.
 * 2. ПРОГОН ЗАВЕРШИЛСЯ УСПЕШНО. После ошибки, лимита или остановки человеком
 *    очищать разговор нельзя: там осталась работа, а не результат.
 * 3. ПОТОЛОК ЦЕПОЧКИ. Иначе «закончил → продолжил» крутится всю ночь. Считаются
 *    только продолжения в чистой сессии; звенья конвейера идут отдельно.
 * 4. ЧЕКПОЙНТ ИЗМЕНИЛСЯ. Файл-опора слово в слово тот же, что при прошлом
 *    продолжении, — агент ходит по кругу, и следующий круг ничего не добавит.
 *
 * Ручное продолжение (кнопка на карточке) проверяет только каталог: решение
 * человека предохранителями не отменяют — ему их показывают.
 */

/** Состояние одной цепочки продолжений. */
interface ChainState {
  /**
   * Продолжать автоматически, без кнопки. Ставится человеком в разговоре.
   * Не задан — разговор идёт за глобальной настройкой: иначе первое же касание
   * цепочки по любому другому поводу молча заморозило бы её на «выключено».
   */
  auto?: boolean;
  /**
   * Какой это шаг: исходный разговор — 0, первое продолжение — 1. Звено
   * конвейера (ревью, правки) номер не двигает: оно продолжает ту же работу
   * другой моделью, а не стирает контекст.
   */
  depth: number;
  /** Последнее касание — по нему выбрасываются самые старые записи. */
  touchedAt: number;
  /**
   * Исходное задание цепочки — уезжает в каждое продолжение, чтобы третья
   * сессия подряд всё ещё знала границы своей работы. Ставится первым
   * продолжением (задание прогона, который его предложил), дальше наследуется.
   */
  rootTask?: string;
  /**
   * Отпечаток файла-опоры в момент последнего продолжения. Совпал с нынешним —
   * круг: агент перечитал то же самое и снова просит перезапуск.
   */
  checkpointHash?: string;
  /**
   * Окно, при котором о его размере уже говорили. Без этого предложение по
   * порогу повторялось бы после КАЖДОГО хода: окно за порогом само по себе не
   * уменьшается, и человек получал бы то же самое уведомление каждые полминуты.
   */
  noticedContext?: number;
}

/** Чем связь отличается от простого «следующий шаг». */
export interface ChainLinkOptions {
  /** Звено конвейера подбора модели, не продолжение: шаг не растёт. */
  stage?: boolean;
  /** Исходное задание — берётся, только если у цепочки его ещё нет. */
  rootTask?: string;
  /** Отпечаток файла-опоры в момент этого продолжения. */
  checkpointHash?: string;
}

/**
 * Насколько окно должно вырасти, чтобы напомнить о себе снова. Шаг такой же, как
 * у сторожа контекста в хуках, и по той же причине: реже — человек забудет, чаще
 * — это шум.
 */
const NOTICE_STEP = 25_000;

/** Сколько цепочек помним. Пульт держит десятки разговоров, не тысячи. */
const MAX_CHAINS = 200;

/**
 * Старше этого цепочка не восстанавливается. Тот же срок, что у журнала прогонов
 * (`run-ledger.MAX_AGE_MS`), и по той же причине: застарелая цепочка держала бы
 * потолок и предохранитель «чекпойнт не изменился» над работой, к которой она
 * давно не относится.
 */
export const CHAIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Одна цепочка на диске: состояние плюс все ключи, под которыми оно известно. */
export interface PersistedChain extends ChainState {
  aliases: string[];
}

/** Куда цепочки пишутся между перезапусками. Файл знает `HandoffChainStore`. */
export interface HandoffChainSink {
  read(): PersistedChain[];
  write(chains: PersistedChain[]): void;
}

/**
 * Память цепочек продолжений.
 *
 * Переживает перезапуск сервера — с тех пор, как его переживают сами прогоны:
 * живой CLI после перезапуска усыновляется из журнала (`run-ledger`), а
 * `pnpm keepalive` поднимает упавшую половину стенда сам. Пока цепочки жили
 * только в памяти, перезапуск обнулял номер шага (потолок в восемь продолжений
 * начинал считать заново) и терял отпечаток файла-опоры — предохранитель
 * «агент ходит по кругу» пропускал лишний круг.
 *
 * Ключей у одного разговора несколько, и это не небрежность: свежий чат стартует
 * под временным `new-<ts>`, а он же, открытый из списка, известен по `sessionId`
 * — тумблер, поставленный в одном написании, обязан действовать и в другом.
 * Поэтому состояние кладётся под каждый псевдоним ОДНИМ И ТЕМ ЖЕ объектом:
 * глубина, выросшая на продолжении, видна по любому ключу. На диск это едет
 * группами (`aliases` + состояние), иначе общий объект разъехался бы на копии.
 */
export class HandoffChains {
  private states = new Map<string, ChainState>();
  private autoByDefault: () => boolean;
  private sink: HandoffChainSink | undefined;

  /**
   * Значение тумблера для разговора, в котором его не трогали, — настройка
   * «продолжать во всех разговорах». Читается на каждый вопрос, а не при старте:
   * настройку меняют при живом сервере, и запомненное число врало бы до
   * перезапуска. Тумблер конкретного разговора всегда сильнее: выключенный
   * руками остаётся выключенным, что бы ни стояло глобально.
   *
   * `sink` не задан — цепочки живут только в памяти, как до Т-волны: так их
   * заводят тесты, которым диск не нужен.
   */
  constructor(autoByDefault: () => boolean = () => false, sink?: HandoffChainSink) {
    // Node в режиме strip-only не поддерживает parameter properties.
    this.autoByDefault = autoByDefault;
    this.sink = sink;
    if (sink) this.restore(sink.read());
  }

  /**
   * Поднять цепочки с диска. Протухшие пропускаем по тому же правилу возраста,
   * что и записи журнала прогонов; запись без ключей поднимать некуда.
   */
  private restore(chains: PersistedChain[], now = Date.now()): void {
    for (const chain of chains) {
      const { aliases, ...state } = chain;
      if (!Array.isArray(aliases) || aliases.length === 0) continue;
      if (typeof state.depth !== 'number' || typeof state.touchedAt !== 'number') continue;
      if (now - state.touchedAt > CHAIN_MAX_AGE_MS) continue;
      // Один объект на все псевдонимы — ровно та же связь, что и в памяти.
      for (const alias of aliases) if (alias) this.states.set(alias, state);
    }
    this.prune();
  }

  /**
   * Сохранить карту группами по общему состоянию. Идентичность объекта здесь и
   * есть связь «это один и тот же разговор», поэтому группируем по ней, а не по
   * равенству полей: два разных разговора с одинаковой глубиной — не одна цепочка.
   */
  private persist(): void {
    if (!this.sink) return;
    const groups = new Map<ChainState, string[]>();
    for (const [alias, state] of this.states) {
      const aliases = groups.get(state);
      if (aliases) aliases.push(alias);
      else groups.set(state, [alias]);
    }
    const chains: PersistedChain[] = [];
    for (const [state, aliases] of groups) chains.push({ ...state, aliases });
    try {
      this.sink.write(chains);
    } catch {
      // Файл — страховка, а не часть работы: отказ диска не имеет права
      // уронить ни тумблер, ни заведение продолжения.
    }
  }

  /** Включить или выключить автопродолжение для разговора (по всем ключам). */
  setAuto(aliases: string[], auto: boolean): void {
    const state = this.stateOf(aliases) ?? { auto, depth: 0, touchedAt: Date.now() };
    state.auto = auto;
    state.touchedAt = Date.now();
    this.write(aliases, state);
  }

  isAuto(aliases: string[]): boolean {
    return this.stateOf(aliases)?.auto ?? this.autoByDefault();
  }

  depth(aliases: string[]): number {
    return this.stateOf(aliases)?.depth ?? 0;
  }

  /** Исходное задание цепочки, если разговор — уже продолжение. */
  rootTaskOf(aliases: string[]): string | undefined {
    return this.stateOf(aliases)?.rootTask;
  }

  /** Отпечаток файла-опоры при прошлом продолжении; у исходного разговора его нет. */
  lastCheckpointHash(aliases: string[]): string | undefined {
    return this.stateOf(aliases)?.checkpointHash;
  }

  /**
   * Связать продолжение с исходным разговором: новый чат наследует тумблер,
   * исходное задание и получает следующий номер шага. Без наследования цепочка
   * обрывалась бы после первого же продолжения — человек включил автомат один
   * раз, а работает он ровно один переход.
   *
   * `stage` — звено конвейера: наследует всё, но шаг не двигает и отпечаток
   * чекпойнта не трогает — своего продолжения оно не делало.
   */
  link(fromAliases: string[], toChatId: string, options: ChainLinkOptions = {}): number {
    const parent = this.stateOf(fromAliases);
    const depth = (parent?.depth ?? 0) + (options.stage ? 0 : 1);
    const rootTask = parent?.rootTask ?? options.rootTask?.trim().slice(0, HANDOFF_ROOT_TASK_MAX);
    const checkpointHash = options.stage
      ? parent?.checkpointHash
      : (options.checkpointHash ?? parent?.checkpointHash);
    this.write([toChatId], {
      ...(parent?.auto === undefined ? {} : { auto: parent.auto }),
      depth,
      touchedAt: Date.now(),
      ...(rootTask ? { rootTask } : {}),
      ...(checkpointHash ? { checkpointHash } : {}),
    });
    return depth;
  }

  /**
   * Запомнить отпечаток файла-опоры ЗА САМИМ разговором, а не за его
   * продолжением.
   *
   * `link` пишет отпечаток новому звену: следующее продолжение сравнит свой с
   * ним и узнает круг. Этого хватало, пока продолжение заводилось из конца
   * прогона — дважды один и тот же прогон не кончается. Перенос работы к другому
   * CLI (П6.1) человек жмёт руками и может нажать второй раз, и тогда сравнивать
   * оказывается не с чем: у исходного разговора отпечатка нет вовсе.
   *
   * Поэтому перенос отмечает исходный разговор тем же полем и тем же смыслом
   * («вот с этим содержимым опоры отсюда уже уходили»), и второй перенос
   * нетронутой работы отказывает существующей причиной `checkpoint_unchanged`.
   * Второго предохранителя от петли здесь нет намеренно.
   */
  noteCheckpoint(aliases: string[], checkpointHash: string): void {
    const state = this.stateOf(aliases) ?? { depth: 0, touchedAt: Date.now() };
    state.checkpointHash = checkpointHash;
    state.touchedAt = Date.now();
    this.write(aliases, state);
  }

  /**
   * Пора ли снова говорить о размере окна. Первый раз — да, дальше — только
   * когда окно подросло ещё на шаг. Ответ ЗАПОМИНАЕТСЯ: метод и спрашивает, и
   * отмечает, потому что второго вызова с тем же смыслом в потоке нет.
   */
  shouldNoticeContext(aliases: string[], tokens: number): boolean {
    const state = this.stateOf(aliases) ?? { depth: 0, touchedAt: Date.now() };
    const previous = state.noticedContext;
    if (previous !== undefined && tokens < previous + NOTICE_STEP) return false;
    state.noticedContext = tokens;
    state.touchedAt = Date.now();
    this.write(aliases, state);
    return true;
  }

  /** Забыть разговор: цепочка закрыта человеком. */
  forget(aliases: string[]): void {
    for (const alias of aliases) this.states.delete(alias);
    this.persist();
  }

  private stateOf(aliases: string[]): ChainState | undefined {
    for (const alias of aliases) {
      const state = this.states.get(alias);
      if (state) return state;
    }
    return undefined;
  }

  private write(aliases: string[], state: ChainState): void {
    for (const alias of aliases) {
      if (alias) this.states.set(alias, state);
    }
    this.prune();
    this.persist();
  }

  /** Самые давние записи выбрасываем: карта не должна расти бесконечно. */
  private prune(): void {
    if (this.states.size <= MAX_CHAINS) return;
    const sorted = [...this.states.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of sorted.slice(0, this.states.size - MAX_CHAINS)) this.states.delete(key);
  }
}

/** Имя файла цепочек — рядом с журналом прогонов, в каталоге данных панели. */
export const HANDOFF_CHAINS_FILE = 'handoff-chains.json';

/**
 * Цепочки на диске. Форма и правила те же, что у журнала прогонов: свой файл в
 * каталоге данных, битый или отсутствующий — пустой список без крика (потерять
 * номер шага не страшнее, чем не иметь его вовсе, а вот упасть на старте — да).
 */
export class HandoffChainStore implements HandoffChainSink {
  private readonly path: string;

  constructor(appDataDir: string, file: string = HANDOFF_CHAINS_FILE) {
    this.path = join(appDataDir, file);
  }

  read(): PersistedChain[] {
    try {
      if (!existsSync(this.path)) return [];
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as PersistedChain[]) : [];
    } catch {
      return [];
    }
  }

  write(chains: PersistedChain[]): void {
    writeJsonFile(this.path, chains);
  }
}

/** Время правки файла или undefined, если его нет. Подменяется в тестах. */
export type StatFile = (path: string) => number | undefined;

/** Настоящая файловая система — время последней записи в миллисекундах. */
export const statMtime: StatFile = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/** Отпечаток содержимого файла или undefined, если его нет. Подменяется в тестах. */
export type HashFile = (path: string) => string | undefined;

/** sha1 содержимого: сравниваем «тот же ли файл», а не защищаемся от подделки. */
export const hashFile: HashFile = (path) => {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
};

export interface HandoffCheckInput {
  /** Предложение из блока ответа; его отсутствие — обычный конец хода. */
  proposal?: HandoffProposal;
  /** Каталог разговора. Пусто — чат вне проекта, продолжать негде. */
  cwd?: string;
  /** Прогон закончился успешно (не ошибка, не лимит, не остановка). */
  ok: boolean;
  /** Момент старта прогона (мс): чекпойнт обязан быть свежее него. */
  startedAt: number;
  /** Автопродолжение включено человеком в этом разговоре. */
  auto: boolean;
  /** Длина цепочки на текущий момент. */
  depth: number;
  /**
   * Отпечаток файла-опоры при ПРОШЛОМ продолжении. Совпадение с нынешним —
   * отказ: новая сессия прочитала бы ровно то же, что и предыдущая.
   */
  previousHash?: string;
  /** Потолок цепочки: у группы разделения он свой, короче (`HANDOFF_GROUP_MAX_CHAIN`). */
  maxDepth?: number;
  stat?: StatFile;
  hash?: HashFile;
}

/**
 * Свой блок продолжения группы разделения панель исполняет без тумблера
 * (журнал 42c, 45b, 59c). Тумблер — решение человека в ЕГО разговоре, а у
 * группы человека нет по построению: он включил разделение и ушёл. Блок группы,
 * оставленный без хода, значил группу, стоящую до утра с `next: коммит, пуш,
 * MR` в последнем ответе, — и хаб писал про неё «готово».
 *
 * План и разбор не в счёт: за планом работа заводится всегда, а разбор
 * продолжений не имеет вовсе. Прочие предохранители (свежий файл-опора,
 * потолок цепочки, «ходит по кругу») действуют и здесь.
 */
export function splitOwnsHandoff(link?: { parentChatId?: string; stage?: string }): boolean {
  return Boolean(link?.parentChatId) && link?.stage !== 'plan' && link?.stage !== 'triage';
}

/**
 * Можно ли продолжать САМО. Порядок проверок — от самой частой причины к самой
 * редкой, чтобы отказ назывался тем словом, которое человек ожидает увидеть:
 * «блока не было» встречается на каждом ходу, а несвежий чекпойнт — раз в день.
 */
export function evaluateHandoff({
  proposal,
  cwd,
  ok,
  startedAt,
  auto,
  depth,
  previousHash,
  maxDepth = HANDOFF_MAX_CHAIN,
  stat = statMtime,
  hash = hashFile,
}: HandoffCheckInput): HandoffVerdict {
  if (!proposal) return { ok: false, reason: 'no_block' };
  if (!auto) return { ok: false, reason: 'auto_off', proposal };
  if (!ok) return { ok: false, reason: 'run_failed', proposal };
  if (!cwd) return { ok: false, reason: 'no_project', proposal };
  if (depth >= maxDepth) return { ok: false, reason: 'chain_cap', proposal };

  const target = checkpointInside(cwd, proposal.checkpoint);
  if (!target) return { ok: false, reason: 'checkpoint_missing', proposal };

  const mtime = stat(target);
  if (mtime === undefined) return { ok: false, reason: 'checkpoint_missing', proposal };
  // Ровно момент старта тоже считаем свежестью: файл, записанный в ту же
  // миллисекунду, что и старт, записан этим прогоном.
  if (mtime < startedAt) return { ok: false, reason: 'checkpoint_stale', proposal };

  // Свежая запись, но слово в слово прошлая: агент переписал файл тем же текстом
  // и снова просит перезапуск. Это круг, и третий заход его не разомкнёт.
  if (previousHash !== undefined && hash(target) === previousHash) {
    return { ok: false, reason: 'checkpoint_unchanged', proposal };
  }

  return { ok: true, proposal };
}

/**
 * Абсолютный путь чекпойнта, если он и правда внутри каталога разговора.
 *
 * Разбор в контрактах уже отбрасывает `..` и абсолютные пути, но проверка
 * повторяется здесь намеренно: разбор описывает ФОРМАТ, а этот модуль трогает
 * настоящую файловую систему, и полагаться в таком на чужую валидацию нельзя.
 */
export function checkpointInside(cwd: string, checkpoint: string): string | undefined {
  const root = resolve(cwd);
  const target = resolve(root, checkpoint);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return undefined;
  }
  return target;
}

/** Запуск прогона продолжения; `false` — под этим ключом прогон уже идёт. */
export type HandoffStart = (input: {
  chatId: string;
  prompt: string;
  cwd: string;
  /**
   * Название для разговора, который придётся ЗАВЕСТИ. У Claude не нужно вовсе —
   * там продолжение живёт под ключом, а имя приходит из транскрипта; у чужого
   * CLI разговор заводится панелью, и без имени в списке оказывался бы ключ
   * вида `new-1758…`. Знает его не всякий зовущий, поэтому необязательно.
   */
  title?: string;
}) => boolean;

export interface StartHandoffInput {
  proposal: HandoffProposal;
  /** Каталог закрытого разговора: продолжение идёт в нём же, ветку не меняем. */
  cwd: string;
  /** Ключи закрытого разговора — от них наследуются тумблер и номер шага. */
  fromAliases: string[];
  chains: HandoffChains;
  /** Запускать прогон сразу или только завести чат с готовым заданием. */
  startRun: boolean;
  start: HandoffStart;
  /** Часы — в тесте фиксируются, чтобы ключ чата был предсказуем. */
  now?: () => number;
  /**
   * Задание, с которого началась вся работа, — на случай, если цепочка только
   * начинается и своего у неё ещё нет. У продолжения наследство сильнее.
   */
  rootTask?: string;
  /** Отпечаток файла-опоры сейчас — для предохранителя «чекпойнт не изменился». */
  checkpointHash?: string;
  /** Продолжение группы разделения: задание в промпте — граница, а не ориентир. */
  group?: boolean;
}

/**
 * Завести продолжение: новый разговор в том же каталоге с заданием из
 * предложения. Копий репозитория здесь не заводится и ветка не меняется —
 * работа та же самая, меняется только окно контекста.
 */
export function startHandoff({
  proposal,
  cwd,
  fromAliases,
  chains,
  startRun,
  start,
  now = Date.now,
  rootTask,
  checkpointHash,
  group = false,
}: StartHandoffInput): HandoffStarted {
  // Ключ чата — тот же временный вид, что и у разговора, начатого из панели:
  // настоящим id он станет, когда CLI выдаст сессию.
  const chatId = `new-${now()}`;
  // Задание в промпте и задание в памяти цепочки — одно и то же: иначе второе
  // продолжение получило бы не тот текст, что первое.
  const task = chains.rootTaskOf(fromAliases) ?? rootTask?.trim().slice(0, HANDOFF_ROOT_TASK_MAX);
  const prompt = buildHandoffPrompt(proposal, task, { group });
  const chainDepth = chains.link(fromAliases, chatId, {
    ...(task ? { rootTask: task } : {}),
    ...(checkpointHash ? { checkpointHash } : {}),
  });
  const started = startRun ? start({ chatId, prompt, cwd }) : false;
  return { chatId, path: cwd, started, prompt, chainDepth };
}
