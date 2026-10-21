import { windowWeight, write1hPart } from '../../../analytics/token-audit/window-weight.ts';
import {
  changesTree,
  checkSignature,
  commandSteps,
  gitVerb,
  maskCommand,
} from './check-signature.ts';
import type { LearnedDurations } from './check-signature.ts';
import {
  COLD_RESUME_MARGIN_TOKENS,
  FRESH_BASE_TOKENS,
} from '../../group-continuation/group-continuation.ts';
import type { WatchContext, WatchEvent, WatchState } from './watch.types.ts';

/**
 * Свёртка событий сессии в состояние сторожа. Чистая: ни часов, ни файлов —
 * время приходит в событии, пороги и корень панели — в окружении. Состояние
 * правится на месте и возвращается: событие на сессию — сотни в минуту, копия
 * кольца на каждое стоила бы больше самой оценки.
 */

/** Кольцо вызовов модели на сессию. */
export const CALL_RING = 200;
/** Потолок списков событий-поводов (спавны, записи, чтения панели, циклы, холодные записи). */
const LIST_CAP = 20;
/** Сжатий держим немного: правилу нужны два последних. */
const COMPACT_CAP = 10;
/** Замеры окна — на три часа назад (прогноз берёт последние полчаса-час). */
const LIMIT_KEEP_MS = 3 * 60 * 60_000;
/** Потолок словарей проверок и чтений: вытесняется давнее. */
const MAP_CAP = 100;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SPAWN_TOOLS = new Set(['Task', 'Agent']);
/**
 * Публикация из звена (R6): пуш и создание MR — работа звена доставки. Шаг
 * должен НАЧИНАТЬСЯ с команды: `echo "git push"` или `grep 'gh pr create'` —
 * не публикация. Коммит в копии — своя работа звена, не повод.
 */
const FORGE_MR = /^(?:glab\s+mr\s+create|gh\s+pr\s+create)\b/;
const MCP_MR = /create_merge_request|merge_request_create|create_pull_request/i;
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
    insertChars: {},
    writeOps: [],
    panelReads: [],
    sleepPolls: [],
    coldWrites: [],
    limits: [],
  };
}

/** Путь для сравнения: косые вперёд, без регистра, `/c/…` Git Bash → `c:/…`. */
export function normPath(path: string): string {
  let out = path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const bash = /^\/([a-z])\//.exec(out);
  if (bash) out = `${bash[1]}:/${out.slice(3)}`;
  return out;
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Путь из файлов самой панели, а не из копии звена (R7). Копия внутри корня — своя. */
function panelPath(path: string, ctx: WatchContext): boolean {
  if (!ctx.panelRoot || !path) return false;
  const root = normPath(ctx.panelRoot);
  const own = ctx.cwd ? normPath(ctx.cwd) : undefined;
  const target = normPath(path);
  return under(target, root) && !(own && under(target, own));
}

/** Корень панели упомянут в команде — чтение или поиск по её файлам. */
function panelInCommand(command: string, ctx: WatchContext): string | undefined {
  if (!ctx.panelRoot) return undefined;
  const root = normPath(ctx.panelRoot);
  for (const token of command.split(/[\s"'`=]+/)) {
    if (token.length > root.length && panelPath(token, ctx)) return token;
  }
  return undefined;
}

export function isSleepPoll(command: string): boolean {
  return LOOP.test(command) && SLEEP.test(command) && POLLS_OUTPUT.test(command);
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function capped<T>(list: T[], item: T, cap = LIST_CAP): T[] {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

/** Словарь сверх потолка теряет записи с самым давним `lastAt`. */
function bound(map: Record<string, { lastAt: number }>): void {
  const keys = Object.keys(map);
  if (keys.length <= MAP_CAP) return;
  keys
    .sort((a, b) => (map[a]?.lastAt ?? 0) - (map[b]?.lastAt ?? 0))
    .slice(0, keys.length - MAP_CAP)
    .forEach((key) => delete map[key]);
}

/** Правка файла (свой Edit или субагента): проверки устарели, чтения этого файла — тоже. */
function noteEdit(state: WatchState, t: number, path: string | undefined): void {
  state.checks = {};
  state.lastEditAt = t;
  if (!path) return;
  const key = normPath(path);
  for (const read of Object.keys(state.reads)) {
    if (read === key || read.startsWith(`${key}#`)) delete state.reads[read];
  }
}

/** Пуш или создание MR в одном из шагов команды. */
function publishOp(command: string): 'push' | 'mr' | undefined {
  for (const step of commandSteps(command)) {
    if (gitVerb(step)?.verb === 'push') return 'push';
    if (FORGE_MR.test(step)) return 'mr';
  }
  return undefined;
}

export function reduce(state: WatchState, event: WatchEvent, ctx: WatchContext): WatchState {
  if (event.t > state.lastEventAt) state.lastEventAt = event.t;
  switch (event.kind) {
    case 'start':
      state.awaitingFirstCall = true;
      delete state.endedAt;
      break;
    case 'end':
      state.endedAt = event.t;
      state.openTools = {};
      break;
    case 'call':
      onCall(state, event, ctx);
      break;
    case 'tool':
      if (event.sidechain) onSidechainTool(state, event);
      else {
        onTool(state, event, ctx.learned);
        notePanelRead(state, event, ctx);
      }
      break;
    case 'toolResult':
      delete state.openTools[event.id];
      break;
    case 'compact':
      if (!event.manual) capped(state.compactions, event.t, COMPACT_CAP);
      break;
    case 'limit':
      if (event.rejected) {
        state.rejectedAt = event.t;
        if (event.resetsAt !== undefined) state.rejectedResetsAt = event.resetsAt;
      }
      if (event.utilization !== undefined && event.resetsAt !== undefined) {
        state.limits.push({ t: event.t, utilization: event.utilization, resetsAt: event.resetsAt });
        const keepFrom = event.t - LIMIT_KEEP_MS;
        while ((state.limits[0]?.t ?? keepFrom) < keepFrom) state.limits.shift();
        if (state.limits.length > CALL_RING)
          state.limits.splice(0, state.limits.length - CALL_RING);
      }
      break;
    case 'insert':
      state.insertChars[event.type] = (state.insertChars[event.type] ?? 0) + event.chars;
      break;
  }
  return state;
}

function onCall(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
  ctx: WatchContext,
): void {
  const ctxTokens = event.input + event.cacheRead + event.cacheWrite;
  const cw1h = write1hPart(event.cacheWrite, event.cacheWrite1h);
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
      ...(event.sidechain ? { sidechain: true } : {}),
    },
    CALL_RING,
  );
  if (event.sidechain || ctxTokens === 0) return;
  // Лимит пропускает вызовы снова — исчерпание кончилось.
  delete state.rejectedAt;
  delete state.rejectedResetsAt;
  if (state.awaitingFirstCall && state.lastCallAt !== undefined) {
    const gapMs = event.t - state.lastCallAt;
    const base = state.firstCtx ?? FRESH_BASE_TOKENS;
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
  state.firstCtx ??= ctxTokens;
  state.awaitingFirstCall = false;
  state.lastCallAt = event.t;
}

function onTool(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'tool' }>,
  learned: LearnedDurations | undefined,
): void {
  const input = event.input;
  const timeout = typeof input.timeout === 'number' ? input.timeout : undefined;
  const question = askText(input);
  state.openTools[event.id] = {
    name: event.name,
    startedAt: event.t,
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    ...(input.run_in_background === true ? { background: true } : {}),
    ...(event.name === 'AskUserQuestion' && question ? { question } : {}),
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
    capped(state.subagents, {
      at: event.t,
      description: skill,
      agentType: 'skill',
      ...(event.stage ? { stage: event.stage } : {}),
    });
    return;
  }

  if (MCP_MR.test(event.name)) {
    capped(state.writeOps, {
      at: event.t,
      op: 'mr',
      ...(event.stage ? { stage: event.stage } : {}),
    });
    return;
  }

  if (event.name !== 'Bash') return;
  const command = str(input.command);
  if (!command) return;
  const publish = publishOp(command);
  if (publish) {
    capped(state.writeOps, {
      at: event.t,
      op: publish,
      ...(event.stage ? { stage: event.stage } : {}),
    });
  }
  if (isSleepPoll(command))
    capped(state.sleepPolls, { at: event.t, command: maskCommand(command) });
  if (changesTree(command)) {
    state.checks = {};
    state.reads = {};
  }
  const signature = checkSignature(command, learned);
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
 * Вызов субагента: его поводы (спавн, публикация, циклы) — его, но правка
 * файлов меняет дерево, общее со звеном: прежние проверки и чтения звена устарели.
 */
function onSidechainTool(state: WatchState, event: Extract<WatchEvent, { kind: 'tool' }>): void {
  if (EDIT_TOOLS.has(event.name)) {
    noteEdit(state, event.t, str(event.input.file_path) ?? str(event.input.notebook_path));
    return;
  }
  if (event.name === 'Bash' && changesTree(str(event.input.command) ?? '')) {
    state.checks = {};
    state.reads = {};
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

/** Текст первого вопроса `AskUserQuestion` — в строку сигнала R1b. */
function askText(input: Record<string, unknown>): string | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions)) return str(input.question);
  const first = questions[0] as { question?: unknown } | undefined;
  return str(first?.question);
}
