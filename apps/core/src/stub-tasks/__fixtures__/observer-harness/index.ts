import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { RouteLease, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../../adapters/index.ts';
import { sessionPermitDeny } from '../../../adapters/deny-overlay.ts';
import { readToolOutcome } from '../../../adapters/sdk-stream/outcome.ts';
import { answerHookCall } from '../../../api/session-hook.ts';
import { pendingHints } from '../../../bootstrap/conductor-wiring/observer.ts';
import { STEP_DENY } from '../../../bootstrap/conductor-wiring/session-start.ts';
import { createEconomyWiring } from '../../../bootstrap/economy-wiring/index.ts';
import { createActivityBook } from '../../../bootstrap/observer-wiring/activity.ts';
import { attachObserver } from '../../../bootstrap/observer-wiring/attach.ts';
import { composeTaps } from '../../../bootstrap/observer-wiring/index.ts';
import { createStallWatch } from '../../../bootstrap/observer-wiring/stall.ts';
import { createToolEventTap } from '../../../bootstrap/observer-wiring/tool-events.ts';
import { createSessionRuntime } from '../../../bootstrap/session-runtime.ts';
import { releaseTaskLeases } from '../../../bootstrap/session-road/lease-release.ts';
import { journalRecorder } from '../../../bootstrap/session-road/recorder.ts';
import { seedRequirements, toolDeps } from '../../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../../conductor/model-tools/binding.ts';
import { handleModelTool } from '../../../conductor/model-tools/model-tools.ts';
import type { SessionBinding } from '../../../conductor/model-tools/model-tools.types.ts';
import { ESTIMATE_HISTORY_SIGNAL } from '../../../conductor/estimate/estimate.ts';
import { decideNext } from '../../../conductor/next/next.ts';
import { createTaskRegistry } from '../../../conductor/tasks.ts';
import {
  CREATED,
  deps,
  FIRST_ROUND,
  MINI_SCENARIO,
  SOLO_UNIT,
  tempDir,
} from '../../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { decisionClasses, undeclaredDecisions } from '../decision-outcomes.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { readHookCall } from '../../../mcp/hook.ts';
import { createLivenessProbe, fakeProcessTable } from '../../../platform/process-identity.ts';
import type { PermitContext } from '../../../policy/permit/permit.types.ts';
import type { RouteRegistry } from '../../../routes/registry.ts';
import { fill, TURN_END_TEXT } from '../script.ts';
import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import {
  CLI_FACTS,
  callFor,
  hookStdin,
  resultBlock,
  type Effect,
  type HarnessCli,
} from './vocabulary.ts';

export { clisOf, type HarnessCli } from './vocabulary.ts';

/**
 * Стенд наблюдателя (этап 8, зона M, P33): задача библиотеки идёт ходами через ПОДДЕЛЬНЫЙ CLI —
 * поток событий переходника, — а всё за ним настоящее: рантайм сессии (`createSessionRuntime`),
 * хук ядра на каждый вызов (stdin хука → `readHookCall` → `answerHookCall` → `policy/permit`),
 * инструменты модели (`handleModelTool`), журнал на диске, краны наблюдателя (`tool.event` зоны W,
 * книга активности и тик тишины зоны T), кран экономики (`turn.usage`, `window.state`), снятие
 * аренды маршрута в конце задачи (`releaseTaskLeases`), подписчик наблюдателя (`attachObserver` — реестр
 * предикатов и каталог ядра), свёртка и `decideNext`. Подменены только внешние границы: процесс CLI
 * (его поток и тексты результатов — `vocabulary.ts`), часы (рабочее монотонное время стенда) и
 * таблица процессов (проба жизни видит живой хост).
 *
 * Шаг, который `decideNext` снимает (`stop-step`), кончает поток — так дирижёр останавливает
 * сессию; ходы после остановки не играются.
 */

export interface HarnessOptions {
  /** Тишина с ходом в работе до `quiet`; прогон библиотеки — ниже 30 с, выше секунды. */
  silentAfterMs?: number;
  /** Порог тишины без выученного p95. */
  stallDefaultMs?: number;
}

export const HARNESS_SILENT_AFTER_MS = 5_000;
export const HARNESS_STALL_MS = 20_000;
/** Шаг часов на ход модели и на вызов: длительность вызова — не ноль. */
const MOVE_MS = 100;
/** Шаг тика тишины во время задержки хода. */
const TICK_MS = 1_000;

export interface FiredSignal {
  signal: string;
  severity: string;
  action: string | null;
  seq: number;
}

export interface HarnessRun {
  taskId: string;
  cli: HarnessCli;
  /** Строки `signal` журнала задачи (любой писатель) по порядку. */
  signals: FiredSignal[];
  /** Id сработавших сигналов без повторов. */
  fired: string[];
  /** Номер хода, после которого `decideNext` снял шаг; `null` — шаг не снимали. */
  stoppedAt: number | null;
  /** Номер хода, после которого шаг ждёт человека (дальше стенд не играет); `null` — не ждал. */
  waitingAt: number | null;
  /** Действие `decideNext` после последнего сыгранного хода. */
  next: string;
  /** Подсказки, ждущие конца хода сессии (одно сообщение на все). */
  hintMessages: number;
  /** Решения хука ядра: разрешено / отказано. */
  permits: { allow: number; deny: number };
  /** Виды строк журнала по порядку. */
  kinds: string[];
  /** Решения журнала без объявленного исхода для панели (этап 9, F1); пусто — все объявлены. */
  undeclared: string[];
  /** Классы решений, которые этот прогон записал. */
  decisionClasses: string[];
  /** Сбои кранов, предикатов и рантайма — любой здесь дефект стенда или кода. */
  notes: string[];
}

interface Seeded {
  stepId: string;
  sessionId: string;
}

/** Маршрут сессии стенда: его окно контекста и его аренда (если задача её берёт). */
const HARNESS_ROUTE = 'stub-1';

/**
 * Живая сессия шага теми строками, какими их пишет ядро, — с cwd копии и переходником стенда.
 * `lease` — аренда маршрута: её ресурс пишет рекордер маршрута (`journalRecorder`), сессия
 * называет её в `session.started.lease`, как запуск дорогой сессии.
 */
function seed(
  task: LiveTask,
  cli: HarnessCli,
  stepKind: string,
  cwd: string,
  lease?: { leaseId: string; rid: string },
): Seeded {
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(0, 8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  task.append({
    kind: 'unit.transition',
    actor: 'core',
    unitId,
    data: { unitId, event: 'start', from: 'planned', to: 'running' },
  });
  const stepId = newId();
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind, budgetMs: 600_000, ...FIRST_ROUND },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  const sessionId = newId();
  if (lease) {
    journalRecorder(task).created({
      rid: lease.rid,
      kind: 'process',
      ref: `${HARNESS_ROUTE} server`,
      release: 'task-end',
    });
  }
  task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter: cli,
      cliVersion: cli === 'claude' ? '2.1.310' : '0.24.3',
      route: { kind: 'stub', id: HARNESS_ROUTE },
      ...(lease ? { lease: { leaseId: lease.leaseId, rids: [lease.rid] } } : {}),
      hops: [],
      credentialKind: 'none',
      modelAsked: 'stub-model',
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: `start-${process.pid}`,
      cliPid: null,
      cliStart: null,
      cwd,
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  task.append({
    kind: 'session.transition',
    actor: 'core',
    sessionId,
    data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
  });
  return { stepId, sessionId };
}

/** Копия единицы: файлы первого коммита в настоящем репозитории (запреты `.git` ищут его). */
function makeCopy(task: StubTask): string {
  const copy = realpathSync.native(tempDir('obs-copy-'));
  for (const [path, text] of Object.entries(task.input.repo.files)) {
    const file = join(copy, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const init = spawnSync('git', ['init', '-q', '-b', task.input.repo.baseBranch], {
    cwd: copy,
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(`git init: ${String(init.stderr)}`);
  return copy;
}

function contextFor(
  copyRoot: string,
  coreHome: string,
  grantRequired: PermitContext['grantRequired'] = [],
): PermitContext {
  // Запреты судьи — тот же набор, что оверлей CLI получает при запуске (F-11).
  const permitDeny = sessionPermitDeny({ coreHome, tokenFiles: [] }, STEP_DENY, copyRoot);
  return {
    copyRoot,
    ownedPaths: [],
    deny: permitDeny.deny,
    platformPaths: permitDeny.platformPaths,
    endpointSources: [],
    grantRequired,
    grants: [],
  };
}

const lineWindow = (text: string, range?: { offset: number; limit: number }) => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!range) return { lines: lines.slice(0, 2000), from: 1 };
  return {
    lines: lines.slice(range.offset - 1, range.offset - 1 + range.limit),
    from: range.offset,
  };
};

/** Сыграть одну задачу библиотеки на одном CLI. */
export async function runStubTask(
  stub: StubTask,
  cli: HarnessCli,
  opts: HarnessOptions = {},
): Promise<HarnessRun> {
  const home = tempDir('obs-home-');
  const copy = makeCopy(stub);
  const registry = createTaskRegistry(home, deps());
  const notes: string[] = [];
  const note = (event: string, data?: Record<string, unknown>) =>
    notes.push(`${event} ${JSON.stringify(data ?? {})}`);
  try {
    const task = await registry.create(CREATED);
    // Числа оценки запуска — той же строкой, что пишет оценка дирижёра на создании (F3).
    const estimateSeq = stub.estimate
      ? task.append({
          kind: 'signal',
          actor: 'core',
          data: {
            signal: ESTIMATE_HISTORY_SIGNAL,
            severity: 'info',
            subject: 'estimate',
            detail: JSON.stringify(stub.estimate),
          },
        }).seq
      : null;
    seedRequirements(
      task,
      stub.input.requirements.map((r) => r.id),
    );
    const lease = stub.lease ? { leaseId: `lease-${newId()}`, rid: newId() } : undefined;
    const { stepId, sessionId } = seed(task, cli, stub.input.stepKind, copy, lease);
    const facts = CLI_FACTS[cli];
    const context = contextFor(copy, home, stub.grantRequired);
    const clock = { t: 0 };
    const now = () => clock.t;
    const windowTokens = stub.routeWindowTokens ?? null;

    const observer = attachObserver(task, {
      ctx: { windowOf: (routeId) => (routeId === HARNESS_ROUTE ? windowTokens : null), now },
      note,
    });
    const book = createActivityBook({ now, note });
    const watch = createStallWatch({
      activity: book,
      now,
      probe: createLivenessProbe(
        fakeProcessTable([
          { pid: process.pid, ppid: 1, start: `start-${process.pid}`, startMs: 1, cpuMs: 10 },
        ]),
        0,
        now,
      ),
      // Живой хост дерево не снимает; снятие здесь — дефект, его видно в заметках.
      stop: async (_t, sid) => {
        notes.push(`stall.stop ${sid}`);
      },
      note,
      options: {
        silentAfterMs: opts.silentAfterMs ?? HARNESS_SILENT_AFTER_MS,
        stallDefaultMs: opts.stallDefaultMs ?? HARNESS_STALL_MS,
      },
    });
    watch.attach(task);
    const toolEvents = createToolEventTap({
      sessionOf: () => ({ mapPermission: facts.mapPermission, cwd: copy }),
      now,
    });
    const runtime = createSessionRuntime({
      note,
      // Кран экономики: `usage` потока → `turn.usage`, `window` → `window.state` (часы стенда).
      economy: createEconomyWiring({ now }),
      observer: composeTaps([toolEvents, book.tap], note),
    });

    const bound = bindingOf(task, sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const b: SessionBinding = bound.binding;
    const brief = { stepId, copyRoot: copy, request: stub.input.request };
    const values = { stepId, copy };
    const permits = { allow: 0, deny: 0 };
    // Записи проверок, которые задача кладёт своим пробам инструментов модели (фаза 2).
    const records = Object.assign(
      {},
      ...stub.phase2.flatMap((p) => (p.kind === 'model-tool' && p.records ? [p.records] : [])),
    ) as Record<string, 'pass' | 'pass-flaky' | 'fail' | 'no-verdict'>;
    const modelDeps = toolDeps(records);
    let stoppedAt: number | null = null;
    let waitingAt: number | null = null;

    const advance = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0; left -= TICK_MS) {
        clock.t += Math.min(TICK_MS, left);
        await watch.tick();
      }
    };
    const nextAction = () =>
      decideNext({
        state: task.state,
        scenario: MINI_SCENARIO,
        workNowMs: now(),
        live: { [stepId]: { sessionId, turnEnd: null, ended: false, safe: true } },
      }).action;

    /** Исход хода: отказ хука, иначе действие CLI над копией. */
    const effectOf = async (
      move: TimedMove,
      call: { name: string; input: Record<string, unknown> },
      streamId: string,
    ): Promise<Effect> => {
      const hook = readHookCall(hookStdin(cli, call, streamId));
      if (!hook) throw new Error('hook stdin unreadable');
      const answer = answerHookCall(task, b, hook, {
        mapPermission: facts.mapPermission,
        context,
      });
      if (!answer.allow) {
        permits.deny += 1;
        return { kind: 'denied', reason: answer.reason };
      }
      permits.allow += 1;
      switch (move.op) {
        case 'shell':
          return {
            kind: 'shell',
            command: String(call.input.command ?? ''),
            exit: move.exit ?? 0,
            background: move.background === true,
            // У каждого запуска свой номер группы процессов — как у настоящего CLI.
            pgid: 10_000 + Math.floor(Math.random() * 50_000),
          };
        case 'read': {
          const path = fill(move.path, values);
          const window = lineWindow(readFileSync(path, 'utf8'), move.range);
          return { kind: 'read', path, ...window };
        }
        case 'write': {
          const path = fill(move.path, values);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, move.content);
          return { kind: 'write', path };
        }
        case 'model-tool': {
          const reply = await handleModelTool(task, b, move.tool, call.input, modelDeps);
          return { kind: 'model-tool', ok: reply.ok, body: reply };
        }
        case 'text':
          throw new Error('text has no effect');
      }
    };

    const turnStarted: AdapterEvent = {
      type: 'turn.started',
      attribution: 'harness',
      origin: 'sequence',
    };
    let numTurns = 0;
    const turnEnded = (): AdapterEvent => {
      numTurns += 1;
      return {
        type: 'turn.ended',
        attribution: 'harness',
        origin: 'sequence',
        isError: false,
        numTurns,
        text: TURN_END_TEXT,
      };
    };

    /** Факты ответа хода, которые CLI сообщает потоком: расход и окно подписки. */
    function* streamFacts(move: TimedMove, index: number): Generator<AdapterEvent> {
      const { usage, window } = move;
      if (usage) {
        yield {
          type: 'usage',
          messageId: `msg_harness_${index}`,
          input: usage.input,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          output: usage.output ?? 2,
          ...(usage.subagent ? { subagent: true } : {}),
          ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
        };
      }
      if (window) {
        yield {
          type: 'window',
          limitKind: 'window',
          usedPct: window.usedPct,
          resetAt: now() + window.resetInMs,
          warning: window.status === 'allowed_warning',
          refusal: window.status === 'rejected',
          window: 'five_hour',
        };
      }
    }

    async function* stream(): AsyncGenerator<AdapterEvent> {
      yield { type: 'init', conversationId: newId(), model: 'stub-model', tools: [], mcp: [] };
      yield turnStarted;
      for (const [index, move] of stub.moves.entries()) {
        await advance((move.holdMs ?? 0) + (move.stallMs ?? 0));
        clock.t += MOVE_MS;
        const call = callFor(move, cli, brief);
        if (!call) {
          yield { type: 'text.delta', text: move.op === 'text' ? move.text : '' };
        } else {
          const streamId = `${cli === 'claude' ? 'toolu' : 'call'}_harness_${index}`;
          yield {
            type: 'tool.requested',
            toolUseId: streamId,
            name: call.name,
            input: call.input,
            cliInitiated: false,
            parentToolUseId: null,
          };
          const effect = await effectOf(move, call, streamId);
          clock.t += MOVE_MS;
          const block = resultBlock(cli, effect);
          yield {
            type: 'tool.result',
            toolUseId: streamId,
            isError: block.is_error,
            cliInitiated: false,
            outcome: readToolOutcome(block, facts.outcome),
          };
        }
        yield* streamFacts(move, index);
        if (move.turnEnd) {
          yield turnEnded();
          yield turnStarted;
        }
        const action = nextAction();
        if (action.kind === 'stop-step' && action.stepId === stepId) {
          // Дирижёр снимает шаг — сессия останавливается, поток кончается.
          stoppedAt = index;
          return;
        }
        if (task.state.steps[stepId]?.state === 'waiting-human') {
          // Шаг ждёт человека: ход CLI кончается, следующие ходы задачи — после ответа, которого
          // стенд не даёт (ответ человека — не ход сессии).
          waitingAt = index;
          yield turnEnded();
          return;
        }
      }
      yield turnEnded();
    }

    const adapter = {
      id: cli,
      events: () => stream(),
      mapPermission: facts.mapPermission,
    } as unknown as CliAdapter;
    await runtime.attach({
      task,
      binding: b,
      adapter,
      handle: { sessionId } as SessionHandle,
      context,
      onEvent: () => {},
    }).done;

    if (stub.lease && lease) {
      // Конец задачи: аренду из журнала снимает настоящий `releaseTaskLeases`; подменён только
      // сервер маршрута — он снимает и подтверждает или отказывает причиной задачи.
      const fault = stub.lease;
      const routes = {
        get: (id: string) =>
          id !== HARNESS_ROUTE
            ? undefined
            : {
                release: async (taken: RouteLease, record: RouteRecorder) => {
                  if (fault.release === 'refused') throw new Error(fault.reason);
                  for (const r of taken.resources) record.verified(r.rid, 'gone');
                  return {
                    verified: taken.resources.map((r) => ({ rid: r.rid, fact: 'gone' })),
                    leaks: [],
                  };
                },
              },
      } as unknown as RouteRegistry;
      await releaseTaskLeases(task, routes, []);
    }

    const next = nextAction().kind;
    const hintMessages = pendingHints(task, sessionId).length;
    observer.detach();
    watch.detach(task.taskId);
    const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
    // Строка оценки запуска — вход задачи (её пишет создание), а не сработавший сигнал.
    const signals = lines
      .filter((l): l is JournalLine<'signal'> => l.kind === 'signal' && l.seq !== estimateSeq)
      .map((l) => ({
        signal: l.data.signal,
        severity: l.data.severity,
        action: (l.data as { action?: string }).action ?? null,
        seq: l.seq,
      }));
    return {
      taskId: stub.id,
      cli,
      signals,
      fired: [...new Set(signals.map((s) => s.signal))],
      stoppedAt,
      waitingAt,
      next,
      hintMessages,
      permits,
      kinds: lines.map((l) => l.kind),
      undeclared: undeclaredDecisions(lines),
      decisionClasses: decisionClasses(lines),
      notes,
    };
  } finally {
    registry.closeAll();
    rmSync(home, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
}
