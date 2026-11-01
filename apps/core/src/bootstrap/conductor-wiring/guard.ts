import { join } from 'node:path';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { CORE_STEP_KINDS } from '@agentdeck/contracts/core/scenario';
import type { ConductorHooks, HookVerdict, StepCtx } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { CLOSED_PUSH_URL } from '../../lib/publish-alias.ts';
import { judgeForgedPublish } from '../../observer/forged-publish.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { applyPushClosure, type ClosureState } from '../../platform/git/push-closure.ts';
import { hookScripts, hooksDirOf } from '../../publisher/closure/index.ts';
import { FORGE_CLOCK_SKEW_MS } from '../forge-wiring/readers.ts';
import { gatherForged } from '../guard-wiring/facts.ts';
import { forgeForRemote } from '../panel-forge.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона G этапа 6 — страж публикации (05 §Push closure, G6/G7). Только шаги сеанса (у шагов ядра
 * сеанса нет — публикует само ядро):
 *
 * - `preStep` — сначала суд над тем, что случилось после прошлой базы (шаг, кончившийся отказом
 *   без `postStep`, тоже судится — новая база его не проглотит), потом закрытие копии (повтор —
 *   те же значения; дрейф прошлого шага уже назван и здесь чинится), строка `publish.closure`,
 *   если записанное разошлось с журналом, и база `publish.remote-refs` каждого remote.
 * - `postStep` — тот же суд по базе начала шага; сработал — `decision` класса `observer`,
 *   `signal forged-publish` (stop) и отказ шага; база переписывается всегда.
 *
 * Непрочитанный факт — `signal` warn с его именем, шаг идёт: молчаливого «чисто» нет.
 */

export interface GuardHooksOptions {
  now?: () => number;
  /** Окружение git (тесты отрезают глобальный конфиг человека). */
  git?: GitOptions;
  /** Порт форжа по адресу remote; `null` — форжа нет. По умолчанию — настройки панели. */
  forgeFor?: (url: string) => ForgePort | null;
}

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_STEP_KINDS);
const OK: HookVerdict = { ok: true };

function defaultForgeFor(url: string): ForgePort | null {
  const remote = forgeForRemote(url);
  return remote.project.kind === 'generic' ? null : remote.port;
}

const sameClosure = (a: ClosureState, b: LiveTask['state']['closures'][string]): boolean =>
  a.copyDir === b.copyDir &&
  a.hooksPath === b.hooksPath &&
  a.hooksDirFp === b.hooksDirFp &&
  JSON.stringify(a.pushurls) === JSON.stringify(b.pushurls) &&
  JSON.stringify(a.commonAliases) === JSON.stringify(b.commonAliases);

export function guardHooks(
  deps: ConductorWiringDeps,
  options: GuardHooksOptions = {},
): ConductorHooks {
  const now = options.now ?? Date.now;
  const git = options.git ?? {};
  const forgeFor = options.forgeFor ?? defaultForgeFor;
  const hooksRoot = join(deps.layout.root, 'hooks');
  /** Время последней базы единицы — начало окна событий форжа (после краха — с начала задачи). */
  const marks = new Map<string, number>();

  const guarded = (s: StepCtx): { task: LiveTask; copyDir: string } | null => {
    if (CORE_KINDS.has(s.def.kind) || !s.copyDir) return null;
    const task = deps.registry.live(s.taskId);
    return task ? { task, copyDir: s.copyDir } : null;
  };

  const check = async (
    s: StepCtx,
    task: LiveTask,
    copyDir: string,
    mode: 'pre' | 'post',
  ): Promise<HookVerdict> => {
    const at = now();
    const hooksDir = hooksDirOf(hooksRoot, s.taskId, s.unitId);
    const window = { from: (marks.get(s.unitId) ?? 0) - FORGE_CLOCK_SKEW_MS, to: at };
    const { input, after } = await gatherForged(
      { task, unitId: s.unitId, copyDir, hooksDir, mode, window },
      { git, forgeFor },
    );
    const where = {
      unitId: s.unitId,
      stepId: s.stepId,
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    };
    const judged = input.refs.length > 0 || input.closure !== null;
    const verdict = judged ? judgeForgedPublish(input) : null;
    if (verdict?.fired) {
      const decision = task.append({
        kind: 'decision',
        actor: 'core',
        ...where,
        data: {
          decisionId: newId(),
          class: 'forged-publish',
          // Строки-базы, с которыми сравнивали: ссылки remote и запись закрытия копии.
          inputs: [
            ...Object.values(task.state.remoteRefs).map((r) => r.seq),
            ...(Object.hasOwn(task.state.closures, s.unitId)
              ? [task.state.closures[s.unitId]!.seq]
              : []),
          ],
          facts: [],
          numbers: {},
          reasons: verdict.reasons,
          output: verdict as never,
        },
      });
      task.append({
        kind: 'signal',
        actor: 'core',
        ...where,
        data: {
          signal: verdict.signal,
          severity: verdict.severity,
          subject: verdict.subject,
          detail: verdict.detail,
        },
      });
      deps.note('guard.forged-publish', {
        taskId: s.taskId,
        unitId: s.unitId,
        mode,
        seq: decision.seq,
      });
    }
    const repoKey = task.state.units[s.unitId]?.repoKey;
    for (const [remote, refs] of Object.entries(after))
      task.append({
        kind: 'publish.remote-refs',
        actor: 'core',
        ...where,
        data: { ...(repoKey ? { repoKey } : {}), remote, refs },
      });
    marks.set(s.unitId, at);
    if (verdict?.fired && verdict.action === 'stop-step')
      return { ok: false, stop: 'step', code: verdict.signal, reason: verdict.detail };
    return OK;
  };

  const close = async (s: StepCtx, task: LiveTask, copyDir: string): Promise<HookVerdict> => {
    const got = await applyPushClosure(
      {
        copyDir,
        hooksDir: hooksDirOf(hooksRoot, s.taskId, s.unitId),
        closedUrl: CLOSED_PUSH_URL,
        scripts: hookScripts(),
      },
      git,
    );
    if ('refused' in got)
      return { ok: false, stop: 'unit', code: 'push-closure-refused', reason: got.refused };
    // Сеанс без закрытия пушил бы свободно: не прочитали и не записали — шаг не идёт.
    if ('unknown' in got)
      return { ok: false, stop: 'step', code: 'push-closure-unknown', reason: got.unknown };
    if (got.enabledWorktreeConfig)
      deps.note('guard.worktree-config', { taskId: s.taskId, copyDir });
    const prev = Object.hasOwn(task.state.closures, s.unitId)
      ? task.state.closures[s.unitId]
      : undefined;
    if (!prev || !sameClosure(got.applied, prev)) {
      const { pushurls, hooksPath, hooksDirFp, commonAliases } = got.applied;
      task.append({
        kind: 'publish.closure',
        actor: 'core',
        unitId: s.unitId,
        stepId: s.stepId,
        data: { unitId: s.unitId, copyDir, pushurls, hooksPath, hooksDirFp, commonAliases },
      });
    }
    return OK;
  };

  return {
    async preStep(s) {
      const scope = guarded(s);
      if (!scope) return { verdict: OK, sections: [] };
      const judged = await check(s, scope.task, scope.copyDir, 'pre');
      const closed = await close(s, scope.task, scope.copyDir);
      return { verdict: judged.ok ? closed : judged, sections: [] };
    },
    async postStep(s) {
      const scope = guarded(s);
      if (!scope) return { verdict: OK, facts: {} };
      return { verdict: await check(s, scope.task, scope.copyDir, 'post'), facts: {} };
    },
  };
}
