import { blockLangPattern } from '@agentdeck/contracts/brand';
import { commandSteps, gitVerb, maskCommand } from './check-signature.ts';
import { bypassesDenial, opSubject } from './op-subject.ts';
import { bound, capped, MAP_CAP, str } from './reduce-util.ts';
import {
  bare,
  isKillStep,
  killTargets,
  LOOKUP,
  lookupPortsOf,
  outsideWrites,
  ownPortsOf,
  withoutComments,
} from './shell-targets.ts';
import { launchesOf } from './pipe-kill.ts';
import type { OpenTool, PendingOp, WatchContext, WatchEvent, WatchState } from './watch.types.ts';

export {
  killTargets,
  outsideWrites,
  ownPortsOf,
  sleepInLoopBody,
  withoutComments,
} from './shell-targets.ts';

/**
 * Поводы правил R24–R33 (пробелы покрытия 23.10) и подтверждение публикации R6.
 * Чистые функции над состоянием сессии: `reduce.ts` зовёт их на своих событиях и
 * сам не растёт. Регулярные выражения — только по командам Bash, ошибкам вызовов
 * (около 3% ответов) и хвосту хода, один раз на его конец.
 */

type ToolEvent = Extract<WatchEvent, { kind: 'tool' }>;
type ResultEvent = Extract<WatchEvent, { kind: 'toolResult' }>;

const MINUTE_MS = 60_000;
/**
 * Публикация из звена (R6): пуш и создание MR — работа звена доставки. Шаг
 * должен НАЧИНАТЬСЯ с команды: `echo "git push"` или `grep 'gh pr create'` —
 * не публикация. Коммит в копии — своя работа звена, не повод.
 */
const FORGE_MR = /^(?:glab\s+mr\s+create|gh\s+pr\s+create)\b/;
export const MCP_MR = /create_merge_request|merge_request_create|create_pull_request/i;
/** Хвост хода: сколько знаков текста держим (вопрос в конце, вердикт ревью). */
const TAIL_MAX = 2_000;
const REVIEW_FENCE = new RegExp(`\`\`\`[ \\t]*${blockLangPattern('review')}`);
/** Стык кусков потока: начало блока (```` ``` ```` + язык) может прийти разрезанным. */
const FENCE_OVERLAP = 40;
/** Служебные вставки CLI, которые льются в окно сами (R32): окружение, диагностика, напоминания. */
const SERVICE_INSERTS = new Set(['environment', 'diagnostics', 'silent_turn_reminder']);
/** Корзины вставок — по минуте; потолок покрывает самое длинное окно R32 (60 мин). */
const INSERT_BUCKETS = 60;
/** Падений одной серии держим не больше верхней границы `errorRepeats`. */
const ERROR_ATS_CAP = 10;
const OWN_PORTS_CAP = 20;

export function emptyIncidents(): Pick<
  WatchState,
  | 'pendingOps'
  | 'errors'
  | 'deniedOps'
  | 'bypasses'
  | 'kills'
  | 'ownPorts'
  | 'ownLaunches'
  | 'outsideWrites'
  | 'inserts'
  | 'outages'
  | 'missingTools'
  | 'tail'
> {
  return {
    pendingOps: {},
    errors: {},
    deniedOps: [],
    bypasses: [],
    kills: [],
    ownPorts: [],
    ownLaunches: [],
    outsideWrites: [],
    inserts: [],
    outages: [],
    missingTools: [],
    tail: '',
  };
}

/** Пауза группы: поводы до неё — прошлое (как `quietCauses`). Свои порты и запуски остаются: процессы живы. */
export function quietIncidents(state: WatchState): void {
  state.pendingOps = {};
  state.errors = {};
  state.deniedOps = [];
  state.bypasses = [];
  state.kills = [];
  state.outsideWrites = [];
  state.inserts = [];
  state.outages = [];
  state.missingTools = [];
  delete state.lookupPorts;
  delete state.sidechainLookupPorts;
  delete state.endText;
}

// ─── R25 и R6: защищённое действие и публикация ─────────────────────────────

/** Пуш или создание MR в одном из шагов команды. */
function publishOp(command: string): 'push' | 'mr' | undefined {
  for (const step of commandSteps(command)) {
    if (gitVerb(bare(step))?.verb === 'push') return 'push';
    if (FORGE_MR.test(bare(step))) return 'mr';
  }
  return undefined;
}

/**
 * Защищённое действие вызова (R25): пуш (и силой), догон целевой ветки (`rebase`,
 * `merge`, `pull`, пересоздание ветки `checkout -B`), `reset --hard`, удаление ветки,
 * снос worktree, MR (MCP или CLI форжа). Продолжение начатого (`--continue`, `--abort`) —
 * не новое действие.
 */
export function protectedOp(name: string, input: Record<string, unknown>): string | undefined {
  if (MCP_MR.test(name)) return 'mr';
  if (name !== 'Bash') return undefined;
  for (const raw of commandSteps(str(input.command) ?? '')) {
    const step = bare(raw);
    if (FORGE_MR.test(step)) return 'mr';
    const git = gitVerb(step);
    if (!git) continue;
    const rest = git.rest;
    if (git.verb === 'push') return 'push';
    if (
      ['rebase', 'merge', 'pull'].includes(git.verb) &&
      !/--(?:continue|abort|skip|quit)\b/.test(rest)
    )
      return 'sync';
    if (
      (git.verb === 'checkout' && /\s-B\s/.test(` ${rest} `)) ||
      (git.verb === 'switch' && /\s-C\s/.test(` ${rest} `))
    )
      return 'sync';
    if (git.verb === 'reset' && /--hard\b/.test(rest)) return 'reset-hard';
    if (git.verb === 'branch' && /\s(?:-D|-d|--delete)\b/.test(` ${rest}`)) return 'branch-delete';
    if (git.verb === 'worktree' && /^\s+remove\b/.test(rest)) return 'worktree-remove';
  }
  return undefined;
}

function opText(name: string, input: Record<string, unknown>): string {
  return name === 'Bash'
    ? withoutComments(str(input.command) ?? '')
    : `${name} ${JSON.stringify(input)}`;
}

// ─── Подпись вызова (R24) ───────────────────────────────────────────────────

/** Подпись входа: команда под маской или вход инструмента целиком (обрезан). */
export function inputSig(name: string, input: Record<string, unknown>): string {
  const command = name === 'Bash' ? str(input.command) : undefined;
  return command ? maskCommand(command) : JSON.stringify(input).slice(0, 300);
}

// ─── Хуки свёртки ───────────────────────────────────────────────────────────

/** Вызов инструмента (свой и субагента): ждущее подтверждения действие, остановки, правки вне копии. */
export function noteToolIncidents(state: WatchState, event: ToolEvent, ctx: WatchContext): void {
  const input = event.input;
  const command = event.name === 'Bash' ? (str(input.command) ?? '') : undefined;
  const publish = MCP_MR.test(event.name) ? 'mr' : command ? publishOp(command) : undefined;
  const guarded = protectedOp(event.name, input);
  if ((publish || guarded) && event.id) {
    const pending: PendingOp = {
      at: event.t,
      ...(publish ? { publish } : {}),
      ...(event.stage ? { stage: event.stage } : {}),
      ...(guarded
        ? {
            guarded: {
              op: guarded,
              text: opText(event.name, input),
              subject: opSubject(event.name, input, guarded),
            },
          }
        : {}),
    };
    state.pendingOps[event.id] = pending;
    capPending(state.pendingOps);
  }
  for (const path of outsideWrites(event.name, input, ctx)) {
    capped(state.outsideWrites, { at: event.t, path });
  }
  if (command === undefined) return;
  const slot = event.sidechain ? 'sidechainLookupPorts' : 'lookupPorts';
  // Образец с именем копии — свои процессы; у основной копии панели — нет: там живёт сама панель.
  const copy = ctx.cwd && ctx.cwd !== ctx.panelRoot ? ctx.cwd : undefined;
  const own = { launches: state.ownLaunches, ...(copy ? { copy } : {}) };
  const targets = killTargets(command, state.ownPorts, state[slot], own);
  for (const target of targets) {
    capped(state.kills, { at: event.t, target, command: maskCommand(command) });
  }
  for (const port of ownPortsOf(command)) {
    if (!state.ownPorts.includes(port)) capped(state.ownPorts, port, OWN_PORTS_CAP);
  }
  if (!commandSteps(command).some(isKillStep)) {
    for (const launch of launchesOf(command)) {
      if (!state.ownLaunches.includes(launch)) capped(state.ownLaunches, launch, OWN_PORTS_CAP);
    }
  }
  // Поиск по порту — повод судить PID следующего вызова того же исполнителя (сессии или
  // субагента); любой другой его вызов Bash поиск гасит, чужой — нет (F-108).
  const lookup =
    LOOKUP.test(command) && !commandSteps(command).some(isKillStep) ? lookupPortsOf(command) : [];
  if (lookup.length > 0) state[slot] = lookup;
  else delete state[slot];
}

function capPending(map: Record<string, PendingOp>): void {
  const keys = Object.keys(map);
  if (keys.length <= MAP_CAP) return;
  keys
    .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
    .slice(0, keys.length - MAP_CAP)
    .forEach((key) => delete map[key]);
}

/** Имя сервиса в строке R30: сервер MCP из имени инструмента, веб — `web`. */
function serviceOf(tool: string): string {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp?.[1]) return mcp[1];
  return /^Web(?:Fetch|Search)$/.test(tool) ? 'web' : tool;
}

/**
 * Ответ вызова. Ждущее действие подтверждается, только если вызов НЕ отбит: отбитый
 * пуш не исполнен — не публикация (R6, C17), а повод для обхода (R25). Ошибки своих
 * вызовов идут в серии (R24), в несуществующие инструменты (R29) и сбои связи (R30).
 */
export function noteResultIncidents(
  state: WatchState,
  tool: OpenTool | undefined,
  event: ResultEvent,
  ctx: WatchContext,
): void {
  settlePending(state, event, ctx);
  if (!tool || tool.name === 'AskUserQuestion' || event.denied) return;
  const sig = `${tool.name}|${tool.sig ?? tool.label ?? ''}|`;
  if (!event.isError) {
    // Тот же вызов прошёл — серия падений кончилась.
    for (const key of Object.keys(state.errors)) if (key.startsWith(sig)) delete state.errors[key];
    return;
  }
  if (event.errorKind === 'no-tool') {
    capped(state.missingTools, {
      at: event.t,
      tool: tool.name,
      ...(tool.stage ? { stage: tool.stage } : {}),
      forge: MCP_MR.test(tool.name),
    });
    return;
  }
  // Сеть у MCP и веба — сервис не ответил (R30); у Bash это вывод команды (свой стенд не поднят).
  if (event.errorKind === 'network' && tool.name !== 'Bash') {
    capped(state.outages, {
      at: event.t,
      service: serviceOf(tool.name),
      head: event.errorHead ?? '',
    });
    return;
  }
  if (event.timedOutMs !== undefined || event.errorHead === undefined) return;
  const key = `${sig}${event.errorHead}`;
  const run = (state.errors[key] ??= {
    ats: [],
    lastAt: event.t,
    label: tool.label ?? tool.name,
    head: event.errorHead,
    ...(tool.print ? { print: tool.print } : {}),
  });
  capped(run.ats, event.t, ERROR_ATS_CAP);
  run.lastAt = event.t;
  bound(state.errors);
}

function settlePending(state: WatchState, event: ResultEvent, ctx: WatchContext): void {
  const pending = state.pendingOps[event.id];
  if (!pending) return;
  delete state.pendingOps[event.id];
  const guarded = pending.guarded;
  if (event.denied) {
    if (guarded) {
      capped(state.deniedOps, {
        at: event.t,
        op: guarded.op,
        text: guarded.text,
        subject: guarded.subject,
      });
    }
    return;
  }
  if (pending.publish) {
    capped(state.writeOps, {
      at: pending.at,
      op: pending.publish,
      ...(pending.stage ? { stage: pending.stage } : {}),
    });
  }
  if (!guarded) return;
  const span = ctx.settings.bypassMinutes * MINUTE_MS;
  // Отбитое то же действие ДРУГОЙ командой: повтор той же (с подписью одобрения в комментарии) — не обход;
  // исправленный повтор — другой предмет (цель названа, `-d` вместо `-D`, описание MR поправлено), не обход (F-56).
  const denial = state.deniedOps.findLast(
    (denied) =>
      denied.text !== guarded.text &&
      bypassesDenial(denied, guarded) &&
      pending.at - denied.at <= span &&
      pending.at >= denied.at,
  );
  if (!denial) return;
  capped(state.bypasses, {
    at: pending.at,
    op: guarded.op,
    command: guarded.text.length > 160 ? `${guarded.text.slice(0, 159)}…` : guarded.text,
    afterMs: pending.at - denial.at,
  });
}

/**
 * Начало хода: хвост прошлого хода больше не «последний ответ», и его блок ревью — тоже
 * (F-55): конвейер читает итог из текста хода, которым кончился разговор (R33).
 */
export function noteTurnStart(state: WatchState): void {
  state.tail = '';
  delete state.endText;
  delete state.reviewFenceSeen;
}

/** Конец хода: его хвост — текст, которым ход кончился (R27, R33). */
export function noteTurnEnd(state: WatchState): void {
  if (state.tail.trim()) state.endText = state.tail;
  state.pendingOps = {};
  delete state.lookupPorts;
  delete state.sidechainLookupPorts;
}

/** Текст хода: поток шлёт его кусками (`text_delta`), транскрипт — блоками с пустой строкой после. */
export function noteSay(state: WatchState, text: string): void {
  // Блок ищется в самом куске со стыком прошлого, а не в хвосте: длинный ответ (10k знаков,
  // блок в середине) вытеснил бы начало блока из хвоста в 2000 знаков.
  const joined = `${state.tail.slice(-FENCE_OVERLAP)}${text}`;
  if (!state.reviewFenceSeen && REVIEW_FENCE.test(joined)) state.reviewFenceSeen = true;
  state.tail = `${state.tail}${text}`.slice(-TAIL_MAX);
}

export function noteApiError(state: WatchState, t: number, head: string): void {
  capped(state.outages, { at: t, service: 'model', head });
}

/** Служебная вставка CLI — в корзину своей минуты (R32). */
export function noteInsert(state: WatchState, t: number, type: string, chars: number): void {
  if (!SERVICE_INSERTS.has(type) || !(chars > 0)) return;
  const last = state.inserts.at(-1);
  if (last && Math.floor(last.at / MINUTE_MS) === Math.floor(t / MINUTE_MS)) {
    last.chars += chars;
    last.byType[type] = (last.byType[type] ?? 0) + chars;
  } else capped(state.inserts, { at: t, chars, byType: { [type]: chars } }, INSERT_BUCKETS);
}
