import type { Fact } from '@agentdeck/contracts/core/facts';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { CheckRecord, ComposeDecision } from '@agentdeck/contracts/core/records';
import {
  journaledSetup,
  pinnedBaseOf,
  unitCopyOf,
  type CopySetupDecision,
} from '../../conductor/copy/index.ts';
import {
  finalGate,
  redBeforeOf,
  type OutcomeDeps,
  type RedBeforeDecision,
} from '../../conductor/outcomes/index.ts';
import type {
  BriefSection,
  ConductorHooks,
  HookVerdict,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import { inPlaceRootOf, isScratchTask } from '../../conductor/estimate/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { diskFree, diskVerdict } from '../../platform/machine.ts';
import { makeScratchDir } from '../../platform/scratch.ts';
import { profileMoved } from '../../verifier/profile/index.ts';
import { copyWiring, type CopyWiring } from '../copy-wiring.ts';
import { snapshotPinnedProfile } from '../verifier-wiring/pinned-profile.ts';
import { copyProfileDeps } from '../verifier-wiring/queue.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона F этапа 4 — обвязка шага (здесь и только здесь; `boot.ts` и `index.ts` зона не трогает):
 *
 * - старт единицы: порог диска (низкий — новой копии нет, сомнение названо), копия
 *   (`copy-wiring`; при оценке — без установки, G6), её `brief` — в бриф шага; снимок
 *   закреплённого профиля (G21), пока профиль копии совпадает с пином;
 * - перед шагом: отложенная установка доставляется первым шагом, что правит копию (G20: повторное
 *   зеркало только свежего + установка); сдвиг профиля против пина — сигнал `profile-moved` один
 *   раз на новый отпечаток и часть брифа каждый шаг (F-066); шаг только чтения после сданной
 *   работы — ранние прогоны итога в простое (F-052/F-055), не дожидаясь;
 * - после шага работы над багом — «красный до» (P94, F-107);
 * - финальная проверка — итог `compose` с прогоном недостающего (F-037/F-041), прогоны кейсов;
 * - конец единицы — снятие копии, если единица закрыта или сдана; ждущая публикации — остаётся.
 */

const FROM = 'conductor/wiring';
const ok: HookVerdict = { ok: true };
const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');
const stop = (scope: 'step' | 'unit', code: string, reason: string): HookVerdict => ({
  ok: false,
  stop: scope,
  code,
  reason,
});

export interface WiringBoundaries {
  copy?: Pick<CopyWiring, 'prepare' | 'remove'>;
  /** Свободное место диска (внешняя граница — ОС). */
  diskFree?: (path: string) => ReturnType<typeof diskFree>;
  /** Фоновая работа (ранние прогоны): по умолчанию не ждётся; тест получает промис. */
  background?: (job: Promise<unknown>) => void;
  outcomes?: Pick<OutcomeDeps, 'pollMs' | 'waitMs'>;
}

interface UnitRepoView {
  repoKey: string;
  path: string;
  baseRef: string;
}

function repoOfUnit(task: LiveTask, unitId: string): UnitRepoView | undefined {
  const repoKey = task.state.units[unitId]?.repoKey;
  const repos = task.state.created?.repos ?? [];
  return repos.find((r) => r.repoKey === repoKey) ?? (repoKey ? undefined : repos[0]);
}

/** Сигнал места работы чата: корень назван раз на единицу, человек видит, что копии нет. */
export const IN_PLACE_SIGNAL = 'chat-in-place';

function journalInPlace(task: LiveTask, unitId: string, root: string): void {
  const seen = readJournalLines(task.dir, task.taskId).lines.some(
    (l) =>
      l.kind === 'signal' &&
      l.unitId === unitId &&
      (l.data as { signal?: string }).signal === IN_PLACE_SIGNAL,
  );
  if (seen) return;
  task.append({
    kind: 'signal',
    actor: 'core',
    unitId,
    data: { signal: IN_PLACE_SIGNAL, severity: 'info', subject: root, detail: 'grant: chat start' },
  });
}

/**
 * Каталог вопроса — создан и записан ресурсом ядра раз на задачу: перезапуск ядра посреди хода
 * второй строки не пишет, а каталог, снятый кем-то снаружи, создаётся заново.
 */
function journalScratch(task: LiveTask, unitId: string): void {
  const dir = makeScratchDir(task.taskId);
  const seen = readJournalLines(task.dir, task.taskId).lines.some(
    (l) =>
      l.kind === 'resource.created' &&
      (l.data as { kind?: string; ref?: string }).kind === 'tmpdir' &&
      (l.data as { ref?: string }).ref === dir,
  );
  if (seen) return;
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: { rid: newId(), kind: 'tmpdir', owner: 'core', release: 'task-end', ref: dir },
  });
}

/** Шаг правит копию: встроенные инструменты не только чтения (оценка и разбор задачи — чтение). */
function editsCopy(kind: string): boolean {
  const plan = toolPlanFor(kind);
  return plan !== null && plan.builtins !== 'read-only';
}

export function createWiringHooks(
  deps: ConductorWiringDeps,
  b: WiringBoundaries = {},
): ConductorHooks {
  const copy =
    b.copy ??
    copyWiring({
      registry: deps.registry,
      layout: deps.layout,
      profileOf: deps.verifier.profile.profileOf,
    });
  const free = b.diskFree ?? ((path: string) => diskFree(path));
  const background =
    b.background ??
    ((job: Promise<unknown>) => {
      job.catch((error: unknown) =>
        deps.note('wiring.background-failed', { error: String(error) }),
      );
    });
  /** Отпечатки сдвига, о которых сигнал уже лёг (задача:репо:fp) — один сигнал на новый отпечаток. */
  const signalled = new Set<string>();
  /** Шаги, для которых ранние прогоны уже запущены. */
  const preRan = new Set<string>();

  function copySection(decision: CopySetupDecision): BriefSection {
    return { id: 'copy-setup', text: decision.brief.join('\n'), from: FROM };
  }

  async function outcomeDeps(): Promise<Fact<OutcomeDeps>> {
    const parts = await deps.verifier.queue.parts();
    if (!('value' in parts)) return parts;
    return {
      value: { service: parts.value.service, checks: parts.value.deps, ...b.outcomes },
    };
  }

  /** Снимок закреплённого профиля (G21): только пока профиль копии — тот, что в пине. */
  async function pinSnapshot(task: LiveTask, repoKey: string, dir: string): Promise<void> {
    const pin = task.state.created?.profilePins.find((p) => p.repoKey === repoKey);
    if (!pin) return;
    const now = await profileMoved(
      pin,
      { repoKey, path: dir },
      copyProfileDeps(deps.layout.profiles),
    );
    if ('value' in now && !now.value.moved)
      snapshotPinnedProfile(deps.layout.profiles, now.value.profile, pin.inputsFp);
  }

  async function profileSection(
    task: LiveTask,
    repoKey: string,
    dir: string,
  ): Promise<BriefSection | null> {
    const pin = task.state.created?.profilePins.find((p) => p.repoKey === repoKey);
    if (!pin) return null;
    const got = await profileMoved(
      pin,
      { repoKey, path: dir },
      copyProfileDeps(deps.layout.profiles),
    );
    if (!('value' in got))
      return {
        id: 'profile',
        text: `Profile of ${repoKey} could not be re-read (${why(got)}): the checks keep the profile pinned at task start.`,
        from: FROM,
      };
    if (!got.value.moved) return null;
    const fresh = got.value.profile.inputsFp;
    const mark = `${task.taskId}:${repoKey}:${fresh}`;
    if (!signalled.has(mark)) {
      signalled.add(mark);
      task.append({
        kind: 'signal',
        actor: 'core',
        data: {
          signal: 'profile-moved',
          severity: 'warn',
          subject: repoKey,
          detail: `pinned ${pin.inputsFp} → ${fresh}`,
        },
      });
    }
    return {
      id: 'profile',
      text:
        `The project profile of ${repoKey} changed since the task started (inputs ${pin.inputsFp.slice(0, 12)} → ${fresh.slice(0, 12)}). ` +
        'This task keeps the check registry pinned at its start; the change is named in the final report.',
      from: FROM,
    };
  }

  /** Ранние прогоны итога в простое: шаг только чтения идёт после сданной работы над кодом. */
  function maybePreRun(task: LiveTask, s: StepCtx, repoKey: string, dir: string): void {
    if (editsCopy(s.def.kind) || preRan.has(s.stepId)) return;
    const workDone = Object.values(task.state.steps).some(
      (st) => st.unitId === s.unitId && editsCopy(st.stepKind) && st.state === 'done',
    );
    if (!workDone) return;
    preRan.add(s.stepId);
    background(
      (async () => {
        const base = pinnedBaseOf(task, s.unitId) ?? repoOfUnit(task, s.unitId)?.baseRef ?? null;
        const scope = await deps.verifier.queue.scope(
          { repoKey, path: dir, baseRef: base },
          task.taskId,
        );
        const out = await deps.verifier.queue.preRun({
          taskId: task.taskId,
          project: repoKey,
          copyDir: dir,
          finishedUnits: scope.registryUnits,
          allFinished: true,
        });
        deps.note('wiring.pre-run', {
          taskId: task.taskId,
          stepId: s.stepId,
          answers: out.answers.length,
          ...(out.stopped ? { stopped: out.stopped } : {}),
        });
        return out;
      })(),
    );
  }

  async function redBefore(
    task: LiveTask,
    s: StepCtx,
    checkId: string,
  ): Promise<Fact<RedBeforeDecision>> {
    const found = unitCopyOf(task, s.unitId);
    const repo = repoOfUnit(task, s.unitId);
    if (!found || !repo) return { unknown: `unit ${s.unitId} has no copy` };
    const od = await outcomeDeps();
    if (!('value' in od)) return { unknown: `verifier: ${why(od)}` };
    return redBeforeOf(
      {
        taskId: task.taskId,
        stepId: s.stepId,
        project: repo.repoKey,
        copyDir: found.dir,
        baseRef: pinnedBaseOf(task, s.unitId) ?? repo.baseRef,
        checkId,
      },
      od.value,
    );
  }

  function journalCompose(
    task: LiveTask,
    unitId: string,
    decision: ComposeDecision,
    rounds: number,
    ran: number,
  ): void {
    task.append({
      kind: 'decision',
      actor: 'core',
      unitId,
      data: {
        decisionId: newId(),
        class: 'compose',
        inputs: [],
        facts: [{ readClass: 'check.registry', kind: 'value' }],
        numbers: {
          rounds,
          ran,
          units: decision.kind === 'ready' ? decision.units.length : 0,
          unmet: decision.kind === 'refuse' ? decision.unmet.length : 0,
        },
        reasons:
          decision.kind === 'refuse'
            ? decision.unmet.map((u) => `${u.code}: ${u.subject}`)
            : [decision.kind],
        output: JSON.parse(JSON.stringify(decision)) as never,
      },
    });
  }

  /**
   * P94: «красный до» — решение класса `red-before` в журнале, а не только факт шага: судья пробы и
   * отчёт читают строку решения. Непрочитанное доказательство — тоже решение, с фактом `unknown`.
   */
  function journalRedBefore(
    task: LiveTask,
    s: StepCtx,
    checkId: string,
    got: Fact<RedBeforeDecision>,
    gated: boolean,
  ): void {
    const value = 'value' in got ? got.value : null;
    task.append({
      kind: 'decision',
      actor: 'core',
      unitId: s.unitId,
      stepId: s.stepId,
      data: {
        decisionId: newId(),
        class: 'red-before',
        inputs: [],
        facts: [
          { readClass: 'check.registry', kind: value ? 'value' : 'unknown' },
          {
            readClass: 'check.records',
            kind: value && value.unknown.length === 0 ? 'value' : 'unknown',
          },
        ],
        numbers: {
          tests: value?.tests.length ?? 0,
          proven: value?.results.filter((r) => r.outcome === 'proven').length ?? 0,
          unknown: value?.unknown.length ?? 0,
          gated: gated ? 1 : 0,
        },
        reasons: value
          ? [
              value.proven ? 'proven' : 'unproven',
              ...value.results.map((r) => `${r.test}: ${r.outcome}`),
            ]
          : [`unknown: ${why(got)}`],
        output: JSON.parse(JSON.stringify(value ?? { checkId, unknown: why(got) })) as never,
      },
    });
  }

  return {
    async onUnitStart(u) {
      const task = deps.registry.live(u.taskId);
      if (!task)
        return { verdict: stop('unit', 'task-unknown', `no live task ${u.taskId}`), sections: [] };
      // Лёгкая сессия «ask»: репозитория нет, место — временный каталог ядра; его снимает
      // уборка конца задачи по строке ресурса (`tmpdir`, `task-end`), как любой каталог ядра.
      if (isScratchTask(task)) {
        journalScratch(task, u.unitId);
        return { verdict: ok, sections: [] };
      }
      // Чат из панели на месте (грант человека на корень): копии нет и не будет — её не
      // выкладывают, не ставят зависимости и не снимают на конце; сам корень — рабочее место.
      // До поиска репозитория: у чата в папке без git (G12 p7) репозитория нет вовсе.
      const inPlace = inPlaceRootOf(task, u.unitId);
      if (inPlace) {
        journalInPlace(task, u.unitId, inPlace);
        return { verdict: ok, sections: [] };
      }
      const repo = repoOfUnit(task, u.unitId);
      if (!repo)
        return {
          verdict: stop('unit', 'repo-unknown', `unit ${u.unitId} has no repository`),
          sections: [],
        };
      const sections: BriefSection[] = [];
      if (!unitCopyOf(task, u.unitId)) {
        // P101: новая копия — гигабайты; при низком диске её не выкладывают, сомнение не держит.
        const disk = diskVerdict(await free(repo.path));
        if (disk.kind === 'low')
          return {
            verdict: stop(
              'unit',
              'disk-low',
              `free ${disk.free.freeBytes} bytes below ${disk.thresholdBytes}: no new copy; free disk space and resume`,
            ),
            sections: [],
          };
        if (disk.kind === 'doubt')
          sections.push({
            id: 'copy-setup',
            text: `Free disk space is unknown (${disk.reason}); the copy was laid out anyway.`,
            from: FROM,
          });
      }
      const prepared = await copy.prepare(u.taskId, u.unitId, {
        ...(task.state.task === 'estimating' ? { deferInstall: true } : {}),
      });
      if (!('value' in prepared))
        return { verdict: stop('unit', 'copy-unknown', `copy: ${why(prepared)}`), sections };
      const decision = prepared.value.decision;
      const placed = unitCopyOf(task, u.unitId);
      if (!placed)
        return {
          verdict: stop(
            'unit',
            'copy-create-failed',
            decision.failure
              ? `${decision.failure.stage}: ${decision.failure.firstError ?? decision.failure.tail}`
              : 'no copy laid out',
          ),
          sections: [...sections, copySection(decision)],
        };
      sections.push(copySection(decision));
      await pinSnapshot(task, repo.repoKey, placed.dir);
      return { verdict: ok, sections };
    },

    async preStep(s) {
      const task = deps.registry.live(s.taskId);
      const placed = task ? unitCopyOf(task, s.unitId) : undefined;
      const repo = task ? repoOfUnit(task, s.unitId) : undefined;
      if (!task || !placed || !repo) return { verdict: ok, sections: [] };
      const sections: BriefSection[] = [];
      const setup = journaledSetup(task, s.unitId);
      if (setup?.installDeferred && editsCopy(s.def.kind) && task.state.task !== 'estimating') {
        const done = await copy.prepare(s.taskId, s.unitId, {});
        sections.push(
          'value' in done
            ? copySection(done.value.decision)
            : {
                id: 'copy-setup',
                text: `Deferred install could not run: ${why(done)}`,
                from: FROM,
              },
        );
      }
      const moved = await profileSection(task, repo.repoKey, placed.dir);
      if (moved) sections.push(moved);
      maybePreRun(task, s, repo.repoKey, placed.dir);
      return { verdict: ok, sections };
    },

    async postStep(s, claim) {
      const regression = s.def.regression;
      if (s.def.kind !== 'work' || !regression || !claim || claim.outcome !== 'done')
        return { verdict: ok, facts: {} };
      const task = deps.registry.live(s.taskId);
      if (!task) return { verdict: ok, facts: {} };
      const got = await redBefore(task, s, regression.checkId);
      const gated = s.def.gate.some((g) => g.kind === 'regression-red-before');
      journalRedBefore(task, s, regression.checkId, got, gated);
      const facts = { redBefore: 'value' in got ? got.value : { unknown: why(got) } };
      if (!gated || ('value' in got && got.value.proven)) return { verdict: ok, facts };
      const reason =
        'value' in got
          ? [
              got.value.tests.length === 0 ? 'no passing test in the changed test files' : null,
              ...got.value.results.map((r) => `${r.test}: ${r.outcome}`),
              ...got.value.unknown.map((u) => `${u.test}: ${u.why}`),
            ]
              .filter(Boolean)
              .join('; ')
          : why(got);
      return { verdict: stop('step', 'red-before-unproven', reason), facts };
    },

    async onFinalGate(u) {
      const task = deps.registry.live(u.taskId);
      // Чат на месте ничего не сдаёт: итога над копией у него нет (разговор, не поставка).
      if (task && inPlaceRootOf(task, u.unitId)) return { verdict: ok, compositionId: null };
      // Вопрос модели тоже ничего не сдаёт: копии и итога нет, ответ — сам ход.
      if (task && isScratchTask(task)) return { verdict: ok, compositionId: null };
      const placed = task ? unitCopyOf(task, u.unitId) : undefined;
      const repo = task ? repoOfUnit(task, u.unitId) : undefined;
      if (!task || !placed || !repo)
        return {
          verdict: stop('unit', 'copy-missing', `unit ${u.unitId} has no copy to gate`),
          compositionId: null,
        };
      const od = await outcomeDeps();
      if (!('value' in od))
        return {
          verdict: stop('step', 'compose-unknown', `verifier: ${why(od)}`),
          compositionId: null,
        };
      const got = await finalGate(
        {
          taskId: u.taskId,
          unitId: u.unitId,
          stepId: null,
          project: repo.repoKey,
          copyDir: placed.dir,
          sourceRepo: repo.path,
          baseRef: pinnedBaseOf(task, u.unitId) ?? repo.baseRef,
        },
        od.value,
      );
      if (!('value' in got))
        return { verdict: stop('step', 'compose-unknown', why(got)), compositionId: null };
      const { decision, compositionId } = got.value;
      journalCompose(task, u.unitId, decision, got.value.rounds, got.value.ran.length);
      if (decision.kind !== 'ready')
        return {
          verdict: stop(
            'step',
            'compose-refused',
            decision.kind === 'refuse'
              ? `${decision.unmet.map((m) => `${m.code} ${m.subject}`).join('; ')} — ${decision.next}`
              : decision.kind,
          ),
          compositionId,
        };
      await caseRunsOf(task, od.value, repo.repoKey, placed.dir, decision.units);
      return { verdict: ok, compositionId };
    },

    // Токен моста панели не переживает задачу: конец задачи снимает его из книги, и сессия, которую
    // кто-то попробовал бы поднять после, без токена отказывает с причиной.
    async onTaskEnd(taskId) {
      deps.askBridges?.drop(taskId);
      // Значения окружения задачи (каталог песочницы, секреты стенда) — тот же срок жизни.
      deps.taskEnv?.drop(taskId);
    },

    async onUnitEnd(u) {
      const task = deps.registry.live(u.taskId);
      const unit = task?.state.units[u.unitId];
      const placed = task ? unitCopyOf(task, u.unitId) : undefined;
      if (!task || !unit || !placed) return;
      // Ждущая публикации копия — её ветка ещё нужна (02 §Units); снимается закрытая и сданная.
      if (unit.state !== 'closed' && unit.state !== 'done') return;
      const removed = await copy.remove(u.taskId, u.unitId, {
        repo: placed.repo,
        dir: placed.dir,
        branch: unit.branch,
      });
      if (!removed.ok)
        deps.note('wiring.copy-kept', {
          taskId: u.taskId,
          unitId: u.unitId,
          dir: placed.dir,
          why: 'refused' in removed ? removed.refused : removed.failed,
        });
    },
  };

  /** Прогоны кейсов блока тестов из записей итога (G15): не легло — названо, итог не держит. */
  async function caseRunsOf(
    task: LiveTask,
    od: OutcomeDeps,
    project: string,
    dir: string,
    units: readonly { checkId: string; recordId: string | null }[],
  ): Promise<string[]> {
    const req = {
      road: 'conductor' as const,
      origin: 'core' as const,
      taskId: task.taskId,
      stepId: null,
      project,
      copyDir: dir,
      class: 'deliver' as const,
      phase: 'final' as const,
      unit: '.',
      changedUnits: [],
      exec: 'core' as const,
    };
    const store = od.checks.store(req);
    if (!('value' in store)) return [];
    const registry = await od.checks.registry(req);
    if (!('value' in registry)) return [];
    const written: string[] = [];
    for (const u of units) {
      if (!u.recordId) continue;
      const entry = registry.value.checks.find((e) => e.id === u.checkId);
      const rec: Fact<CheckRecord> = store.value.record(u.recordId);
      if (!entry || !('value' in rec)) continue;
      const wrote = deps.verifier.outcomes.caseRuns(rec.value, dir, {
        entry,
        units: registry.value.units,
      });
      if ('value' in wrote) written.push(...wrote.value);
      else if ('unknown' in wrote)
        deps.note('wiring.case-runs', {
          taskId: task.taskId,
          checkId: u.checkId,
          why: wrote.unknown,
        });
    }
    return written;
  }
}

export function wiringHooks(deps: ConductorWiringDeps): ConductorHooks {
  return createWiringHooks(deps);
}
