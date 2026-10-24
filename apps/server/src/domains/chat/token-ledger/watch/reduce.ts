import { windowWeight, write1hPart } from '../../../analytics/token-audit/window-weight.ts';
import {
  changesTree,
  checkSignature,
  commandPrint,
  expectedMs,
  isFullGate,
  maskCommand,
} from './check-signature.ts';
import {
  emptyIncidents,
  inputSig,
  MCP_MR,
  noteApiError,
  noteInsert,
  noteResultIncidents,
  noteSay,
  noteToolIncidents,
  noteTurnEnd,
  noteTurnStart,
  quietIncidents,
  sleepInLoopBody,
} from './reduce-incidents.ts';
import { absolutePath, bound, capped, normPath, str, under } from './reduce-util.ts';
import {
  closeFresh,
  editIntentOf,
  noteCommitResult,
  noteEditIntent,
  noteFreshCall,
  noteFreshStart,
  noteGitWork,
  noteModelSwitch,
} from './reduce-autonomy.ts';
import type { LearnedDurations } from './check-signature.ts';
import {
  COLD_RESUME_MARGIN_TOKENS,
  FRESH_BASE_TOKENS,
} from '../../group-continuation/group-continuation.ts';
import type {
  ColdCacheRule,
  OpenTool,
  WatchContext,
  WatchEvent,
  WatchState,
} from './watch.types.ts';

/**
 * Свёртка событий сессии в состояние сторожа. Чистая: ни часов, ни файлов —
 * время приходит в событии, пороги и корень панели — в окружении. Состояние
 * правится на месте и возвращается: событие на сессию — сотни в минуту, копия
 * кольца на каждое стоила бы больше самой оценки.
 */

/**
 * Кольцо вызовов модели САМОЙ сессии. Вызовы субагентов сюда не идут: их
 * десятки в минуту вытесняли бы окно сессии (R2 берёт модель последнего своего
 * вызова). Расход группы (R8) и замеры окна (R9) живут у сторожа своими
 * списками со своими потолками (`group-watcher.ts`).
 */
export const CALL_RING = 200;
/** Сжатий держим немного: правилу нужны два последних. */
const COMPACT_CAP = 10;
/** Корзины расхода субагентов — по минуте; потолок покрывает самое длинное окно R13 (240 мин). */
const SUB_BURN_CAP = 240;
const MINUTE_MS = 60_000;
/** Срок короче — нарочно короткая проба (`timeout 5s`), а не вызов, упёршийся в стену (R15). */
const MIN_TIMEOUT_MS = 2 * 60_000;
/** Сохранённый CLI вывод вызова: перечитать его — второй раз внести тот же объём в окно (R14). */
const PERSISTED_OUTPUT = /tool-results[\\/]|hook-toolu_/;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SPAWN_TOOLS = new Set(['Task', 'Agent']);
/** Цикл опроса со сном над файлами или выводом (R11, карточка 32). */
const LOOP = /(^|[\s;&|(])(for|while|until)\s/;
const SLEEP = /\bsleep\s+\d/;
const POLLS_OUTPUT = /\[\s+-[a-z]\s|\btest\s+-[a-z]\b|\b(grep|tail|cat|ls|wc|find|stat|head)\b/;

export function createWatchState(now: number): WatchState {
  return {
    calls: [],
    lastEventAt: now,
    awaitingFirstCall: false,
    openTools: {},
    compactions: [],
    checks: {},
    reads: {},
    subagents: [],
    skills: [],
    insertChars: {},
    writeOps: [],
    panelReads: [],
    sleepPolls: [],
    coldWrites: [],
    subBurn: [],
    bigResults: [],
    timeouts: [],
    denials: [],
    actions: [],
    heavyChecks: [],
    freshRewrites: [],
    editIntents: [],
    pendingCommits: {},
    commitFacts: [],
    ...emptyIncidents(),
  };
}

/** Действий держим больше прочих поводов: число в строке R20 — сколько сделано на паузе. */
const ACTIONS_CAP = 100;

/** Начало хода или вызов инструмента — действие сессии (R20). */
function noteAction(state: WatchState, t: number, label?: string): void {
  capped(state.actions, label ? { at: t } : { at: t, start: true }, ACTIONS_CAP);
  if (label) state.lastActionLabel = label;
}

/**
 * Группа на паузе: поводы правил до неё — прошлое. Человек остановил группу и
 * смотрит сам; после снятия паузы прежний упор в срок или повтор проверки не
 * поднимается заново вторым рядом. Остаются база окна и время вызовов (R2),
 * действия (R20 — ради них и пауза) и тяжёлые проверки (R21 считает их на группу).
 */
export function quietCauses(state: WatchState): void {
  state.compactions = [];
  state.checks = {};
  state.reads = {};
  state.subagents = [];
  state.skills = [];
  state.writeOps = [];
  state.panelReads = [];
  state.sleepPolls = [];
  state.coldWrites = [];
  state.subBurn = [];
  state.bigResults = [];
  state.timeouts = [];
  state.denials = [];
  delete state.rejectedAt;
  delete state.rejectedResetsAt;
  delete state.firstCallAt;
  state.freshRewrites = [];
  quietIncidents(state);
}

export { normPath };

/** Путь из файлов самой панели (голый корень тоже), а не из копии звена (R7). Копия внутри корня — своя. */
function panelPath(path: string, ctx: WatchContext): boolean {
  if (!ctx.panelRoot || !path) return false;
  const target = absolutePath(path, ctx);
  if (!target) return false;
  const root = normPath(ctx.panelRoot);
  const own = ctx.cwd ? normPath(ctx.cwd) : undefined;
  return under(target, root) && !(own && under(target, own));
}

/** CLI блока «Тесты» панели: его запускают из любого проекта, так велит подсказка самой панели. */
const TESTS_CLI = 'tools/tests-cli.mjs';
const RUNS_NODE = /(?:^|[\s;&|(])node(?:\.exe)?\s/;

/**
 * Запуск CLI тестов панели из копии — работа звена, а не чтение исходников
 * панели (вырезка карточки 22: `node "$T" list` при `T=<панель>/tools/tests-cli.mjs`).
 * Чтение того же файла (`grep`, `sed` без `node`) по-прежнему R7.
 */
function runsPanelTestsCli(token: string, command: string, ctx: WatchContext): boolean {
  if (!ctx.panelRoot || !RUNS_NODE.test(command)) return false;
  return absolutePath(token, ctx) === `${normPath(ctx.panelRoot)}/${TESTS_CLI}`;
}

/** Путь к файлам панели в команде — чтение или поиск по ним (`cd <корень> && grep …` тоже). */
function panelInCommand(command: string, ctx: WatchContext): string | undefined {
  if (!ctx.panelRoot) return undefined;
  for (const token of command.split(/[\s"'`=;|&()<>]+/)) {
    if (panelPath(token, ctx) && !runsPanelTestsCli(token, command, ctx)) return token;
  }
  return undefined;
}

/** Опрос: цикл, сон в его теле (не после `done`, C18) и чтение файлов или вывода. */
export function isSleepPoll(command: string): boolean {
  return (
    LOOP.test(command) &&
    SLEEP.test(command) &&
    POLLS_OUTPUT.test(command) &&
    sleepInLoopBody(command)
  );
}

/**
 * Правка дерева из Bash (`sed -i`, `git checkout`, генератор): какие файлы тронуты, не
 * видно — устарели все проверки и чтения, а падения до неё — уже другая попытка (R24, F-105).
 */
function noteTreeChange(state: WatchState, t: number): void {
  state.checks = {};
  state.reads = {};
  state.errors = {};
  state.lastEditAt = t;
}

/** Правка файла (свой Edit или субагента): проверки устарели, чтения этого файла — тоже. */
function noteEdit(state: WatchState, t: number, path: string | undefined): void {
  state.checks = {};
  // Правка между падениями — уже другая попытка (R24).
  state.errors = {};
  state.lastEditAt = t;
  if (!path) return;
  const key = normPath(path);
  for (const read of Object.keys(state.reads)) {
    if (read === key || read.startsWith(`${key}#`)) delete state.reads[read];
  }
}

export function reduce(state: WatchState, event: WatchEvent, ctx: WatchContext): WatchState {
  if (event.t > state.lastEventAt) state.lastEventAt = event.t;
  switch (event.kind) {
    case 'start':
      state.awaitingFirstCall = true;
      delete state.endedAt;
      noteAction(state, event.t);
      noteTurnStart(state);
      // Новый разговор с нуля: его первый вызов — первый запрос сессии (R19). Окно прошлого
      // разговора под тем же ключом к нему не относится.
      if (event.fresh) {
        state.fresh = true;
        delete state.firstCtx;
        delete state.firstCallAt;
      }
      noteFreshStart(state, event, ctx);
      break;
    case 'end':
      state.endedAt = event.t;
      closeFresh(state);
      state.openTools = {};
      noteTurnEnd(state);
      break;
    case 'say':
      noteSay(state, event.text);
      break;
    case 'apiError':
      noteApiError(state, event.t, event.head);
      break;
    case 'call':
      onCall(state, event, ctx);
      break;
    case 'tool':
      if (event.sidechain) onSidechainTool(state, event);
      else onTool(state, event, ctx.learned);
      noteToolIncidents(state, event, ctx);
      noteGitWork(state, event, ctx);
      noteEditIntent(state, editIntentOf(event, ctx));
      noteAction(state, event.t, actionLabel(event));
      // Копия группы — вместе с её субагентами: их чтение панели — тоже R7.
      notePanelRead(state, event, ctx);
      break;
    case 'toolResult':
      onToolResult(state, event, ctx);
      noteCommitResult(state, event);
      break;
    case 'compact':
      if (!event.manual) capped(state.compactions, event.t, COMPACT_CAP);
      // Сжатие меняет начало разговора: следующий вызов кэш не читает и без паузы —
      // падение чтения после него не след остывания (R2 у чужого CLI).
      delete state.lastCacheRead;
      break;
    case 'limit':
      // Замер загрузки окна — дело всего аккаунта (R9 у сторожа), здесь — только исчерпание.
      if (event.rejected) {
        state.rejectedAt = event.t;
        if (event.resetsAt !== undefined) state.rejectedResetsAt = event.resetsAt;
      }
      break;
    case 'insert':
      state.insertChars[event.type] = (state.insertChars[event.type] ?? 0) + event.chars;
      noteInsert(state, event.t, event.type, event.chars);
      break;
  }
  return state;
}

function onCall(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
  ctx: WatchContext,
): void {
  // Вызов субагента — в расход группы (у сторожа) и в расход субагентов сессии (R13), не в окно сессии.
  // Остаток сверки — только в расход группы: чей он, поток не сказал.
  if (event.sidechain) {
    if (!event.remainder) noteSubBurn(state, event.t, windowWeight(event, event.model));
    return;
  }
  const ctxTokens = event.input + event.cacheRead + event.cacheWrite;
  const cw1h = write1hPart(event.cacheWrite, event.cacheWrite1h);
  const prevCall = state.calls.at(-1);
  noteFreshCall(state, event);
  capped(
    state.calls,
    {
      t: event.t,
      ctx: ctxTokens,
      cacheRead: event.cacheRead,
      cw1h,
      cw5m: event.cacheWrite - cw1h,
      out: event.output,
      ...(event.model ? { model: event.model } : {}),
      weight: windowWeight(event, event.model),
    },
    CALL_RING,
  );
  if (ctxTokens === 0) return;
  // Лимит пропускает вызовы снова — исчерпание кончилось.
  delete state.rejectedAt;
  delete state.rejectedResetsAt;
  // Новый разговор кэша не продолжает: остывать нечему, его запись — база, не холодное продолжение (R2).
  if (state.awaitingFirstCall && state.lastCallAt !== undefined && !state.fresh) {
    // Пинг тёплого кэша освежил окно позже последнего вызова — пауза кэша от него.
    const gapMs = event.t - Math.max(state.lastCallAt, state.warmedAt ?? 0);
    const base = state.firstCtx ?? FRESH_BASE_TOKENS;
    if (ctx.cold) {
      noteForeignCold(state, event, ctx.cold, gapMs, base);
    } else if (prevCall && switchedModel(prevCall.model, event, ctx, gapMs, base)) {
      noteModelSwitch(state, event, prevCall.ctx);
    } else {
      noteClaudeCold(state, event, ctx, gapMs, base);
    }
  }
  // Время первого вызова — только у разговора, начатого на глазах сторожа (R19): у `--resume`,
  // форка и начала транскрипта первый увиденный вызов — середина чужой истории.
  if (state.firstCtx === undefined) {
    state.firstCtx = ctxTokens;
    if (state.fresh) state.firstCallAt = event.t;
  }
  state.fresh = false;
  state.awaitingFirstCall = false;
  state.lastCallAt = event.t;
  state.lastCacheRead = event.cacheRead;
}

/**
 * Тёплое продолжение другой моделью (R34): пауза короче срока остывания, а окно
 * записано заново выше базы + запас — кэш прежней модели новой не читается.
 */
function switchedModel(
  before: string | undefined,
  event: Extract<WatchEvent, { kind: 'call' }>,
  ctx: WatchContext,
  gapMs: number,
  base: number,
): boolean {
  if (!before || !event.model || before === event.model) return false;
  if (gapMs >= ctx.settings.coldGapMinutes * 60_000) return false;
  return event.cacheWrite >= base + COLD_RESUME_MARGIN_TOKENS;
}

/** Холодное продолжение Claude: запись кэша выше базы + запас или пауза дольше срока при большом окне. */
function noteClaudeCold(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
  ctx: WatchContext,
  gapMs: number,
  base: number,
): void {
  const ctxTokens = event.input + event.cacheRead + event.cacheWrite;
  const cw1h = write1hPart(event.cacheWrite, event.cacheWrite1h);
  const rewrote = event.cacheWrite >= base + COLD_RESUME_MARGIN_TOKENS;
  const coldGap =
    gapMs >= ctx.settings.coldGapMinutes * 60_000 && ctxTokens >= ctx.settings.coldContextTokens;
  if (rewrote || coldGap) {
    capped(state.coldWrites, {
      at: event.t,
      write: event.cacheWrite,
      write1h: cw1h,
      ctx: ctxTokens,
      gapMs,
      base,
    });
  }
}

/**
 * Холодное продолжение чужого CLI: кэш его провайдера остывает за свой срок
 * (`afterMs`), а записи кэша провайдер не сообщает. След — чтение кэша: до
 * паузы оно было (провайдер кэш считает), после паузы упало, и вход полной
 * ценой выше базы + запас — продолжение обошлось дороже нового разговора. Чего-то
 * из этого нет — сигнала нет: ложная тревога хуже пропущенной.
 */
function noteForeignCold(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
  rule: ColdCacheRule,
  gapMs: number,
  base: number,
): void {
  if (rule.kind !== 'readDrop') return;
  // Чтения до паузы не было (0 или неизвестно) — упасть ему некуда: сигнала нет.
  const before = state.lastCacheRead ?? 0;
  if (event.cacheRead >= before || gapMs < rule.afterMs) return;
  if (event.input < base + COLD_RESUME_MARGIN_TOKENS) return;
  capped(state.coldWrites, {
    at: event.t,
    // Потеря — только то, что выпало из кэша: новый вход хода (свежий ответ
    // инструмента) был бы полной ценой и с тёплым кэшем.
    write: Math.min(event.input, before - event.cacheRead),
    write1h: 0,
    ctx: event.input + event.cacheRead + event.cacheWrite,
    gapMs,
    base,
    uncached: true,
  });
}

function onTool(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'tool' }>,
  learned: LearnedDurations | undefined,
): void {
  const input = event.input;
  const timeout = typeof input.timeout === 'number' ? input.timeout : undefined;
  const question = askText(input);
  const command = event.name === 'Bash' ? str(input.command) : undefined;
  const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const expect = command ? expectedMs(command, learned) : undefined;
  const signature = command ? checkSignature(command, learned) : undefined;
  const fullGate = command ? isFullGate(command) : false;
  const print = command ? commandPrint(command) : undefined;
  state.openTools[event.id] = {
    name: event.name,
    startedAt: event.t,
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    ...(input.run_in_background === true ? { background: true } : {}),
    ...(event.name === 'AskUserQuestion' && question ? { question } : {}),
    label: toolLabel(event.name, command, target),
    ...(PERSISTED_OUTPUT.test(command ?? target ?? '') ? { persisted: true } : {}),
    ...(expect !== undefined ? { expectMs: expect } : {}),
    ...(signature || fullGate ? { check: true } : {}),
    ...(fullGate ? { fullGate: true } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    sig: inputSig(event.name, input),
    ...(print ? { print } : {}),
  };

  if (EDIT_TOOLS.has(event.name)) {
    noteEdit(state, event.t, str(input.file_path) ?? str(input.notebook_path));
    return;
  }

  if (event.name === 'Read') {
    const path = str(input.file_path);
    if (!path) return;
    // Чтение кусками (`offset`) — не повтор: ключ — путь вместе с куском. `offset` 0 — с начала, как без него.
    const offset = input.offset === 0 ? '' : String(input.offset ?? '');
    const key = `${normPath(path)}#${offset}:${String(input.limit ?? '')}`;
    const read = (state.reads[key] ??= { count: 0, lastAt: event.t });
    read.count += 1;
    read.lastAt = event.t;
    bound(state.reads);
    return;
  }

  if (SPAWN_TOOLS.has(event.name)) {
    capped(state.subagents, {
      at: event.t,
      description: str(input.description) ?? '',
      agentType: str(input.subagent_type) ?? '',
      ...(event.stage ? { stage: event.stage } : {}),
    });
    return;
  }

  if (event.name === 'Skill') {
    const skill = str(input.skill) ?? str(input.name) ?? '';
    capped(state.skills, {
      at: event.t,
      description: skill,
      agentType: 'skill',
      ...(event.stage ? { stage: event.stage } : {}),
    });
    return;
  }

  // MCP создания MR — повод R6 и R25 (`noteToolIncidents`), больше в нём смотреть нечего.
  if (MCP_MR.test(event.name)) return;

  if (!command) return;
  if (isSleepPoll(command))
    capped(state.sleepPolls, { at: event.t, command: maskCommand(command) });
  if (changesTree(command)) noteTreeChange(state, event.t);
  if (signature) {
    const check = (state.checks[signature] ??= {
      runs: 0,
      lastAt: event.t,
      command: maskCommand(command),
    });
    check.runs += 1;
    check.lastAt = event.t;
    bound(state.checks);
  }
}

/**
 * Вызов субагента: его спавны, циклы и повторы проверок — его. Но копия группы
 * — вместе с субагентами: пуш или MR субагента — тоже публикация звена (R6,
 * `noteToolIncidents`), а правка файлов меняет дерево, общее со звеном: прежние
 * проверки и чтения звена устарели.
 */
function onSidechainTool(state: WatchState, event: Extract<WatchEvent, { kind: 'tool' }>): void {
  if (EDIT_TOOLS.has(event.name)) {
    noteEdit(state, event.t, str(event.input.file_path) ?? str(event.input.notebook_path));
    return;
  }
  if (event.name === 'Bash' && changesTree(str(event.input.command) ?? '')) {
    noteTreeChange(state, event.t);
  }
}

/** Чтение файлов панели из копии (R7): Read/Grep/Glob по пути или Bash с её корнем. */
function notePanelRead(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'tool' }>,
  ctx: WatchContext,
): void {
  const input = event.input;
  let path: string | undefined;
  if (event.name === 'Read' || event.name === 'Grep' || event.name === 'Glob') {
    const target = str(input.file_path) ?? str(input.path);
    if (target && panelPath(target, ctx)) path = target;
  } else if (event.name === 'Bash') {
    path = panelInCommand(str(input.command) ?? '', ctx);
  }
  if (path) capped(state.panelReads, { at: event.t, path });
}

/** Что за вызов в строке сигнала: команда под маской, инструмент с путём или имя инструмента. */
function toolLabel(name: string, command: string | undefined, target: string | undefined): string {
  if (command) return maskCommand(command);
  return target ? `${name} ${target}` : name;
}

/** Расход субагента — в корзину своей минуты (R13). */
function noteSubBurn(state: WatchState, t: number, weight: number): void {
  if (!(weight > 0)) return;
  const last = state.subBurn.at(-1);
  if (last && Math.floor(last.at / MINUTE_MS) === Math.floor(t / MINUTE_MS)) last.weight += weight;
  else capped(state.subBurn, { at: t, weight }, SUB_BURN_CAP);
}

/**
 * Результат вызова: вызов закрыт; его объём (R14), упор в срок (R15) и отказ
 * стража (R18) — в поводы. Только свои вызовы сессии: результат без открытого
 * вызова — субагента или вызова до подхвата, его не с чем сопоставить.
 */
function onToolResult(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'toolResult' }>,
  ctx: WatchContext,
): void {
  const tool = state.openTools[event.id];
  delete state.openTools[event.id];
  // Подтверждение публикации и отказы — и у вызовов субагентов: открытого вызова у них нет.
  noteResultIncidents(state, tool, event, ctx);
  if (!tool) return;
  const label = tool.label ?? tool.name;
  const persisted = tool.persisted === true;
  // Ответ субагента — его итог, ради него и звали: не подмес.
  const big =
    event.chars >= ctx.settings.bigResultChars ||
    (persisted && event.chars >= ctx.settings.persistedChars);
  if (big && !SPAWN_TOOLS.has(tool.name)) {
    capped(state.bigResults, {
      at: event.t,
      chars: event.chars,
      tool: tool.name,
      label,
      persisted,
    });
  }
  if (event.timedOutMs !== undefined && event.timedOutMs >= MIN_TIMEOUT_MS) {
    capped(state.timeouts, {
      at: event.t,
      timeoutMs: event.timedOutMs,
      label,
      ...(tool.print ? { print: tool.print } : {}),
    });
  }
  // Ответ на вопрос карточкой приходит ошибкой с тем же видом — это не стена.
  if (event.denied && tool.name !== 'AskUserQuestion' && !firstDeferral(state, tool, event)) {
    capped(state.denials, { at: event.t, guard: event.denied });
  }
  noteHeavyCheck(state, tool, event, ctx);
}

const DEFERRED_CALLS_CAP = 200;

/**
 * Вызов впервые отложен человеку (D-n) — законное ожидание, а не стена R18: агент
 * сделал ровно то, что велит отказ, — поставил вызов и пошёл дальше; пять разных
 * D-n одного хода не повод (холодное ревью 23.10, D-L08). Тот же вызов снова —
 * «уже стоит как D-n» или «человек отказал» — уже повтор в стену и считается.
 * Ключ — отпечаток всей команды: подпись режет её на 200 знаках и прячет секреты,
 * по ней две разные длинные команды совпали бы.
 */
function firstDeferral(
  state: WatchState,
  tool: OpenTool,
  event: Extract<WatchEvent, { kind: 'toolResult' }>,
): boolean {
  if (event.denied !== 'deferred') return false;
  const key = `${tool.name}|${tool.print ?? tool.sig ?? tool.label ?? ''}`;
  const seen = (state.deferredCalls ??= []);
  if (seen.includes(key)) return false;
  // Потолок — как у списка самих D-n (`deferred-asks/store.ts`, 200 записей):
  // общий потолок в 20 вытеснял ключи, и стена на вытесненном вызове
  // замечалась на повтор позже (RF-DL-14).
  capped(seen, key, DEFERRED_CALLS_CAP);
  return true;
}

/**
 * Тяжёлая проверка (R21) — та, что ДЕЙСТВИТЕЛЬНО шла: на переднем плане не короче
 * порога `heavyCheckMinutes`. Классификатор полного гейта щедр (прогон mustfail и
 * `git commit-tree` за секунду он тоже узнаёт), поэтому одной подписи мало — решает
 * длительность. Фоновый прогон длительности хода не меряет: тяжёлый, если это полный
 * гейт или очередь помнит его дольше порога. Отбитый стражем вызов не шёл вовсе.
 */
function noteHeavyCheck(
  state: WatchState,
  tool: OpenTool,
  event: Extract<WatchEvent, { kind: 'toolResult' }>,
  ctx: WatchContext,
): void {
  if (!tool.check || event.denied) return;
  const thresholdMs = ctx.settings.heavyCheckMinutes * MINUTE_MS;
  const ranMs = tool.background ? (tool.expectMs ?? 0) : event.t - tool.startedAt;
  const heavy = (tool.background && tool.fullGate === true) || ranMs >= thresholdMs;
  if (!heavy) return;
  capped(state.heavyChecks, {
    at: tool.startedAt,
    endedAt: event.t,
    minutes: ranMs / MINUTE_MS,
    label: tool.label ?? tool.name,
    ...(tool.stage ? { stage: tool.stage } : {}),
  });
}

/** Что за действие в строке R20: свой вызов или субагента — команда под маской или путь. */
function actionLabel(event: Extract<WatchEvent, { kind: 'tool' }>): string {
  const input = event.input;
  const command = event.name === 'Bash' ? str(input.command) : undefined;
  const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  return toolLabel(event.name, command, target);
}

/** Текст первого вопроса `AskUserQuestion` — в строку сигнала R1b. */
function askText(input: Record<string, unknown>): string | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions)) return str(input.question);
  const first = questions[0] as { question?: unknown } | undefined;
  return str(first?.question);
}
