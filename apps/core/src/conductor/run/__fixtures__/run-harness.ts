import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import type { SendOrigin } from '@agentdeck/contracts/core/user-layer';
import { applyAnswer } from '../../commands/answer.ts';
import { commandEnv } from '../../commands/__fixtures__/command-env.ts';
import { raiseHumanPoint } from '../../human/raise.ts';
import { presetOf } from '../../scenario/presets.ts';
import {
  CREATED,
  deps as journalDeps,
  fakeClock,
  openFresh,
} from '../../../journal/__fixtures__/journal-harness.ts';
import { resume, type LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { runTask } from '../run.ts';
import type {
  ConductorHooks,
  HookVerdict,
  PublishOutcome,
  RunEconomy,
  RunHandle,
  SessionEvents,
  SessionPort,
  StepCtx,
} from '../run.types.ts';

/**
 * Стенд исполнителя дирижёра: настоящий журнал на диске, настоящие `decideNext`, `raiseHumanPoint`
 * (E), команда ответа и пресеты (A); подделаны только сессия модели (сценарий поведения по шагу и
 * кругу) и крючки зон C/D/F (вердикт по шагу и кругу). Остальные зоны подключатся в волне 2.
 */

/** Что «модель» делает на отправку: заявление, заявление с блокирующей находкой, молчит, работает. */
export type Behaviour = 'claim' | 'claim-blocking' | 'silent' | 'hold';

export interface Script {
  /** По `<stepDefId>:<round>`; по умолчанию — `claim`. */
  model?: Record<string, Behaviour>;
  /** Вердикт `postStep` по `<stepDefId>:<round>`; по умолчанию — да. */
  post?: Record<string, 'red' | 'unit' | 'edits'>;
  /** Разрешённые маршруты задачи; по умолчанию — один, `claude` через вход CLI. */
  routes?: JournalDataV1['task.created']['allowedRoutes'];
  /** `open` бросает (сбой ядра при запуске сессии, а не отказ дороги). */
  openThrows?: boolean;
  /** Шаг ухода за вопросами (E) в мс настоящего времени; по умолчанию — как в ядре. */
  upkeepEveryMs?: number;
  /** Порт экономики этапа 5 (W): окна, бриф/дельта, токены, прогрев. */
  economy?: RunEconomy;
  /**
   * Порт пишет строки сессии, как дорога: `session.started` (маршрут из суда `tier`, `resumeOf`
   * из решения продолжения) и `exited` на снятии — свёртка видит сессии и расход по ним.
   */
  journalSessions?: boolean;
  /**
   * Ответ публикатора по `<stepDefId>:<round>`; по умолчанию — опубликовано (MR 1). `null` —
   * крючка нет (шаг кончается `publisher-unwired`).
   */
  publish?: Record<string, PublishOutcome | null>;
}

export const ROUTE: JournalDataV1['task.created']['allowedRoutes'][number] = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'claude-login' },
  modelPattern: '*',
};

interface FakeSession {
  stepId: string;
  on: SessionEvents;
  ended: boolean;
  sends: { text: string; cmdId: string; origin: SendOrigin }[];
}

export class FakePort implements SessionPort {
  readonly sessions = new Map<string, FakeSession>();
  readonly ends: { sessionId: string; mode: 'soft' | 'tree' }[] = [];
  /** Сессия, которую `open` прикрепит вместо новой (P10/P11: та же после перезапуска ядра). */
  reattach: string | null = null;
  task!: LiveTask;
  private script: Script;
  constructor(script: Script) {
    this.script = script;
  }

  /** Каждый запуск сессии с тем, что исполнитель о шаге передал (маршрут зоны A). */
  readonly opened: StepCtx[] = [];

  open(s: StepCtx, _brief: unknown, on: SessionEvents) {
    this.opened.push(s);
    if (this.script.openThrows) return Promise.reject(new Error('open blew up'));
    const resumed = this.reattach !== null && this.sessions.get(this.reattach)?.stepId === s.stepId;
    const sessionId = resumed ? this.reattach! : newId();
    this.reattach = null;
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { stepId: s.stepId, on, ended: false, sends: prev?.sends ?? [] });
    if (this.script.journalSessions && !resumed) this.journalStart(s, sessionId);
    return Promise.resolve({ ok: true as const, sessionId, resumed });
  }

  /** Строки запуска, как у дороги: маршрут — суд `tier`, `resumeOf` — решение продолжения. */
  private journalStart(s: StepCtx, sessionId: string): void {
    const tier = s.routing?.tier;
    const cont = s.routing?.continuation;
    const route = tier?.ok ? tier.route : ROUTE.route;
    this.task.append({
      kind: 'session.started',
      actor: 'core',
      stepId: s.stepId,
      sessionId,
      data: {
        sessionId,
        stepId: s.stepId,
        adapter: tier?.ok ? tier.adapter : 'claude',
        cliVersion: '1',
        route,
        hops: [],
        credentialKind: 'none',
        modelAsked: tier?.ok ? tier.model : null,
        modelServed: null,
        effort: null,
        hostPid: process.pid,
        hostStart: `start-${process.pid}`,
        cliPid: null,
        cliStart: null,
        cwd: '/w',
        argv: [],
        resumeOf: cont?.mode === 'same-session' ? cont.sessionId : null,
        cacheAgeMs: cont?.mode === 'same-session' ? cont.numbers.cacheAgeMs : null,
      },
    });
    this.task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
    });
  }

  /** Ход модели с расходом (свёртка v7 считает его в шаг сессии). */
  usage(
    stepId: string,
    tokens: {
      input: number;
      output: number;
      cacheWrite?: number;
      cacheWrite1h?: number;
      cacheRead?: number;
      /** Окно, которое назвала сама сессия (`result.modelUsage`); нет — сессия не назвала. */
      contextWindow?: number;
    },
  ): void {
    for (const [sessionId, s] of this.sessions) {
      if (s.stepId !== stepId || s.ended) continue;
      this.task.append({
        kind: 'turn.usage',
        actor: `session:${sessionId}`,
        sessionId,
        data: {
          sessionId,
          messageId: `m-${newId()}`,
          input: tokens.input,
          cacheRead: tokens.cacheRead ?? 0,
          cacheWrite: tokens.cacheWrite ?? 0,
          cacheWrite1h: tokens.cacheWrite1h ?? 0,
          output: tokens.output,
          routeId: ROUTE.route.id,
          model: 'model-a',
          subagent: false,
          parentSessionId: null,
          remainder: false,
          ...(tokens.contextWindow ? { contextWindow: tokens.contextWindow } : {}),
        },
      });
    }
  }

  send(
    sessionId: string,
    text: string,
    cmdId: string,
    origin: SendOrigin = 'platform',
  ): Promise<void> {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.ended) return Promise.resolve();
    // Дубль по ключу: та же отправка после перезапуска ядра не уходит второй раз.
    if (sess.sends.some((x) => x.cmdId === cmdId)) return Promise.resolve();
    sess.sends.push({ text, cmdId, origin });
    setImmediate(() => this.behave(sessionId));
    return Promise.resolve();
  }

  end(sessionId: string, mode: 'soft' | 'tree'): Promise<void> {
    this.ends.push({ sessionId, mode });
    const sess = this.sessions.get(sessionId);
    if (sess && !sess.ended && this.script.journalSessions) {
      const from = this.task.state.sessions[sessionId]?.state;
      if (from === 'live' || from === 'quiet' || from === 'starting')
        this.task.append({
          kind: 'session.transition',
          actor: 'core',
          sessionId,
          data: { sessionId, event: 'exited', from, to: 'ended' },
        });
    }
    if (sess) sess.ended = true;
    return Promise.resolve();
  }

  /** Модель шага действует по сценарию сейчас (без новой отправки). */
  act(stepId: string, how?: Behaviour): void {
    for (const [id, s] of this.sessions) {
      if (s.stepId !== stepId || s.ended) continue;
      if (how) this.script.model = { ...this.script.model, [this.key(stepId)]: how };
      this.behave(id);
    }
  }

  private key(stepId: string): string {
    const rec = this.task.state.steps[stepId];
    return `${rec?.stepDefId}:${rec?.round}`;
  }

  private behave(sessionId: string): void {
    const sess = this.sessions.get(sessionId)!;
    const rec = this.task.state.steps[sess.stepId];
    if (!rec || sess.ended) return;
    const how = this.script.model?.[`${rec.stepDefId}:${rec.round}`] ?? 'claim';
    if (how === 'hold') return;
    if (how !== 'silent' && rec.state === 'running') {
      this.task.append({
        kind: 'step.claimed',
        actor: `session:${sessionId}`,
        stepId: sess.stepId,
        sessionId,
        data: {
          stepId: sess.stepId,
          sessionId,
          claim: {
            stepId: sess.stepId,
            outcome: 'done',
            requirements: [],
            summary: `${rec.stepDefId} round ${rec.round}`,
            ...(how === 'claim-blocking'
              ? { findings: [{ file: 'a.ts', line: 1, severity: 'blocking' as const, text: 'x' }] }
              : {}),
          },
        },
      });
    }
    sess.on.turnEnded();
  }

  /** Конец хода без отправки (модель сама закончила работу, «держала» шаг). */
  turnEnd(stepId: string): void {
    for (const s of this.sessions.values()) if (s.stepId === stepId && !s.ended) s.on.turnEnded();
  }

  toolOpen(stepId: string, delta: 1 | -1): void {
    for (const s of this.sessions.values()) if (s.stepId === stepId && !s.ended) s.on.tool(delta);
  }
}

/** Крючки C/D/F как вердикт по шагу и кругу; что звали — по порядку. */
export function scriptedHooks(script: Script, calls: string[]): ConductorHooks {
  const verdict = (s: StepCtx): { verdict: HookVerdict; facts: Record<string, unknown> } => {
    const got = script.post?.[`${s.def.id}:${s.round}`];
    if (got === 'red') {
      return { verdict: { ok: false, stop: 'step', code: 'check-red', reason: 'r' }, facts: {} };
    }
    if (got === 'unit') {
      return { verdict: { ok: false, stop: 'unit', code: 'gate', reason: 'u' }, facts: {} };
    }
    return { verdict: { ok: true }, facts: { edits: got === 'edits' } };
  };
  return {
    postStep: async (s, claim) => {
      calls.push(`post:${s.def.id}:${s.round}:${claim ? 'claim' : 'none'}`);
      return verdict(s);
    },
    onPublish: async (s, compositionId) => {
      calls.push(`publish:${s.def.id}:${s.round}:${compositionId ?? 'none'}`);
      const key = `${s.def.id}:${s.round}`;
      const got = script.publish && key in script.publish ? script.publish[key] : undefined;
      return got === undefined ? { kind: 'published', mrIid: 1 } : got;
    },
    onTaskEnd: async (_t, at) => {
      calls.push(`task-end:${at}`);
    },
    onUnitEnd: async (u) => {
      calls.push(`unit-end:${u.unitId}`);
    },
  };
}

export interface Stand {
  task: LiveTask;
  port: FakePort;
  run: RunHandle;
  calls: string[];
  clock: ReturnType<typeof fakeClock>;
  /** Ответ человека настоящей командой `answer` (E) — шаг отпускает она, а не стенд. */
  answer(askId: string, answer: string): Promise<void>;
  /**
   * Перезапуск ядра: исполнитель умирает (сессии живы), журнал открывается `resume()` заново.
   * `between` — строки нового ядра до исполнителя (сверка загрузки: сессия мёртвого хоста → lost).
   */
  restart(between?: (task: LiveTask) => void): Promise<void>;
  stop(): Promise<void>;
  dir: string;
  taskId: string;
  /** Ждать строки журнала, удовлетворяющей условию (или уже выполненного условия). */
  until(pred: (t: LiveTask) => boolean, ms?: number): Promise<void>;
}

export async function stand(
  scenario: Scenario | ScenarioRef,
  script: Script = {},
  extraHooks: ConductorHooks[] = [],
): Promise<Stand> {
  const sc = 'steps' in scenario ? scenario : presetOf(scenario)!;
  const clock = fakeClock();
  const d = journalDeps({ clock, now: () => clock.stamp().at });
  const { task, dir, taskId } = await openFresh(undefined, d);
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      scenario: { id: sc.id, version: sc.version },
      allowedRoutes: script.routes ?? [ROUTE],
    },
  });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  const calls: string[] = [];
  const port = new FakePort(script);
  port.task = task;
  const hooks = [scriptedHooks(script, calls), ...extraHooks];
  const start = (t: LiveTask) =>
    runTask(t, {
      hooks,
      scenarioOf: (ref) => (ref.id === sc.id && ref.version === sc.version ? sc : undefined),
      sessions: port,
      raise: (r) => raiseHumanPoint(t, r),
      now: () => clock.stamp().at,
      ...(script.upkeepEveryMs === undefined ? {} : { upkeepEveryMs: script.upkeepEveryMs }),
      ...(script.economy ? { economy: script.economy } : {}),
    });
  const out: Stand = {
    task,
    port,
    run: start(task),
    calls,
    clock,
    dir,
    taskId,
    async until(pred, ms = 5_000) {
      const deadline = Date.now() + ms;
      while (!pred(out.task)) {
        if (Date.now() > deadline) throw new Error('until: condition not reached');
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async answer(askId, answer) {
      const command = {
        cmdId: newId(),
        kind: 'answer',
        target: { taskId },
        expectSeq: null,
        fields: { askId, answer },
      } as unknown as CommandEnvelope;
      await applyAnswer(out.task, command, commandEnv());
    },
    async restart(between) {
      await out.run.stop('keep');
      out.task.close();
      const again = await resume(dir, taskId, journalDeps({ clock, now: () => clock.stamp().at }));
      if (!again.ok) throw new Error(again.reason);
      between?.(again.task);
      out.task = again.task;
      port.task = again.task;
      out.run = start(again.task);
    },
    async stop() {
      await out.run.stop();
      out.task.close();
    },
  };
  return out;
}

/** Попытки шагов по порядку: `<def>:<round>:<state>:<basis>`. */
export function attempts(task: LiveTask): string[] {
  return Object.values(task.state.steps)
    .sort((a, b) => a.startedSeq - b.startedSeq)
    .map((s) => `${s.stepDefId}:${s.round}:${s.state}:${s.basis ?? '-'}`);
}

/** Открытый вопрос по ключу (или первому совпадению префикса). */
export function openAsk(task: LiveTask, prefix: string): string | undefined {
  return Object.entries(task.state.asks).find(
    ([, a]) => a.state === 'open' && a.dedupe?.startsWith(prefix),
  )?.[0];
}
