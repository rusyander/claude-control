import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionKind, JournalKind } from '@agentdeck/contracts/core/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../adapters/claude/permission.ts';
import { mapQwenPermission } from '../adapters/qwen/permission.ts';
import { actionReaders } from '../bootstrap/action-readers.ts';
import { processCommand } from '../conductor/commands.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import {
  seedRequirements,
  seedSession,
  toolDeps,
} from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { handleModelTool } from '../conductor/model-tools/model-tools.ts';
import { runAction } from '../conductor/outbox.ts';
import { ACTION_READ_CLASS, reconcileTask } from '../conductor/reconcile.ts';
import { deps, openFresh, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { STALE_MS } from '../journal/lease.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { resume, type LiveTask } from '../journal/resume.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { sweepMarker } from '../platform/env-marker.ts';
import { decidePermit } from '../policy/permit/permit.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { READ_BY_FORGE, STUB_TASKS } from './__fixtures__/library/index.ts';
import { decisionClasses, undeclaredDecisions } from './__fixtures__/decision-outcomes.ts';
import { commandLine, fillDeep } from './__fixtures__/script.ts';
import type { Phase2Probe, StubTask } from './__fixtures__/stub-tasks.types.ts';

/**
 * Вердикты, которые выносит код фазы 2, исполняются на настоящем коде (R:S2-25): инструменты
 * модели — на живой задаче в журнале на диске; право — через разбор сырого вызова каждым
 * переходником и `policy/permit`; полномочия — `processCommand`; крах в outbox — настоящий
 * `runAction`, ядро «умирает» между `action.started` и `action.done`, новое ядро открывает
 * журнал с диска и сверяет по факту. Вердикты поздних фаз здесь не судятся.
 */

type Probe<K extends Phase2Probe['kind']> = Extract<Phase2Probe, { kind: K }>;

function probes<K extends Phase2Probe['kind']>(kind: K): [string, number, StubTask, Probe<K>][] {
  return STUB_TASKS.flatMap((task) =>
    task.phase2
      .map((p, i) => [task.id, i, task, p] as [string, number, StubTask, Phase2Probe])
      .filter((row): row is [string, number, StubTask, Probe<K>] => row[3].kind === kind),
  );
}

/**
 * Каждая строка, прочитанная пробой, проходит через исходы решений панели (этап 9, F1):
 * решение настоящего кода, которому не объявлен исход, — красный тест здесь, а не заголовок
 * без шаблона на экране.
 */
const seenClasses = new Set<string>();
function linesAfter(task: LiveTask, seq: number) {
  const lines = readJournalLines(task.dir, task.taskId).lines.filter((l) => l.seq > seq);
  expect(undeclaredDecisions(lines), 'decision outcome undeclared').toEqual([]);
  for (const cls of decisionClasses(lines)) seenClasses.add(cls);
  return lines;
}

function expectJournal(
  kinds: string[],
  journal: { present?: JournalKind[]; absent?: JournalKind[] },
): void {
  for (const k of journal.present ?? []) expect(kinds, `present ${k}`).toContain(k);
  for (const k of journal.absent ?? []) expect(kinds, `absent ${k}`).not.toContain(k);
}

describe('phase-2 verdicts of the stub-task library', () => {
  it.each(probes('model-tool'))(
    '%s probe %i: model tool on a live task',
    async (_id, _i, task, probe) => {
      const fresh = await openFresh();
      // Требования задачи — строки журнала с id ядра: заявка на id, которого ядро не выдало, — отказ (G3).
      seedRequirements(
        fresh.task,
        task.input.requirements.map((r) => r.id),
      );
      const seeded = seedSession(fresh.task, { stepKind: task.input.stepKind });
      const bound = bindingOf(fresh.task, seeded.sessionId);
      if (!('binding' in bound)) throw new Error(bound.reason);
      const b = bound.binding;
      const move = task.moves[probe.move];
      if (move?.op !== 'model-tool') throw new Error('probe must point at a model-tool move');
      const args = fillDeep(move.args, { stepId: b.stepId, copy: tempDir() });
      const before = fresh.task.state.seq;
      const codes: string[] = [];
      // Инструмент `check` с обвязкой отвечает асинхронно — ответ ждётся всегда.
      let last: Awaited<ReturnType<typeof handleModelTool>> | undefined;
      for (let n = 0; n < (probe.repeat ?? 1); n += 1) {
        const reply = await handleModelTool(
          fresh.task,
          b,
          move.tool,
          args,
          toolDeps(probe.records ?? {}),
        );
        last = reply;
        if (!reply.ok) codes.push(reply.code);
      }
      const e = probe.expect;
      expect(last?.ok).toBe(e.ok);
      if (e.codes) expect(codes).toEqual(e.codes);
      if (e.result) expect((last as { result: unknown }).result).toMatchObject(e.result);
      const after = linesAfter(fresh.task, before);
      expectJournal(
        after.map((l) => l.kind),
        e.journal,
      );
      if (e.decision) {
        const decision = after.find(
          (l) => l.kind === 'decision' && (l.data as { class: string }).class === e.decision!.class,
        );
        expect(decision, `decision ${e.decision.class}`).toBeDefined();
        expect((decision!.data as { output: unknown }).output).toMatchObject(e.decision.output);
      }
      const signals = after
        .filter((l) => l.kind === 'signal')
        .map((l) => (l.data as { signal: string }).signal);
      for (const s of e.signals ?? []) expect(signals).toContain(s);
      expect(fresh.task.state.steps[b.stepId]?.state).toBe(e.stepState);
      fresh.task.close();
    },
  );

  it.each(probes('permit'))(
    '%s probe %i: shell command through both adapters',
    (_id, _i, task, probe) => {
      const move = task.moves[probe.move];
      if (move?.op !== 'shell') throw new Error('probe must point at a shell move');
      const copyRoot = tempDir();
      const ctx: PermitContext = {
        copyRoot,
        ownedPaths: [],
        deny: { paths: [], commands: probe.denyCommands, mcpTools: [], tools: [] },
        platformPaths: [],
        endpointSources: [],
        grantRequired: [],
        grants: [],
      };
      const command = commandLine(move.argv);
      // argv процесса: ведущие присваивания окружения — не слова команды (так их видит exec).
      const argv = move.argv.slice(move.argv.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w)));
      const typed = decidePermit(
        {
          action: 'exec',
          target: argv[0] ?? '',
          argv,
          tool: 'Bash',
          display: command,
        },
        ctx,
      );
      const claude = decidePermit(mapClaudePermission({ tool: 'Bash', input: { command } }), ctx);
      const qwen = decidePermit(
        mapQwenPermission({ tool: 'run_shell_command', input: { command, is_background: false } }),
        ctx,
      );
      const want = probe.expect.code
        ? { allow: probe.expect.allow, code: probe.expect.code }
        : { allow: probe.expect.allow };
      for (const [road, decision] of [
        ['typed argv', typed],
        ['claude adapter', claude],
        ['qwen adapter', qwen],
      ] as const)
        expect(decision, road).toMatchObject(want);
    },
  );

  it.each(probes('command'))(
    '%s probe %i: human command authority',
    async (_id, _i, _task, probe) => {
      const { task } = await openFresh();
      const before = task.state.seq;
      const result = await processCommand(
        task,
        {
          cmdId: newId(),
          kind: probe.command.kind,
          target: { taskId: task.taskId },
          fields: probe.command.fields as never,
          proof: {},
        },
        async () => probe.proof,
        commandEnv(),
      );
      expect(result.status).toBe(probe.expect.status);
      if (probe.expect.code) expect(result.code).toBe(probe.expect.code);
      const after = linesAfter(task, before);
      expectJournal(
        after.map((l) => l.kind),
        probe.expect.journal,
      );
      const signals = after
        .filter((l) => l.kind === 'signal')
        .map((l) => (l.data as { signal: string }).signal);
      if (probe.expect.signal) expect(signals).toEqual([probe.expect.signal]);
      else expect(signals).toEqual([]);
      task.close();
    },
  );
});

/**
 * Мир одного действия: цель, подсказка сверки, сам эффект и `count` — сколько раз эффект виден
 * В МИРЕ (каталог на диске, помеченный процесс в таблице ОС), а не счётчик в замыкании теста:
 * тот рос только внутри самого эффекта, и проверка «сверка не повторила эффект» не могла
 * покраснеть (F-79). `count` нет — у действия нет мира фазы 2 (трекер, контейнер).
 */
interface World {
  target: string;
  hint: string;
  effect(): void;
  count?: () => Promise<number>;
  cleanup(): void;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function worldFor(kind: ActionKind): World {
  if (kind === 'copy-create') {
    const target = join(tempDir(), 'copy');
    return {
      target,
      hint: target,
      effect: () => mkdirSync(target),
      count: async () => (existsSync(target) ? 1 : 0),
      cleanup: () => undefined,
    };
  }
  if (kind === 'copy-remove') {
    const target = join(tempDir(), 'copy');
    mkdirSync(target);
    return {
      target,
      hint: target,
      effect: () => rmSync(target, { recursive: true }),
      // Эффект удаления виден как отсутствие каталога.
      count: async () => (existsSync(target) ? 0 : 1),
      cleanup: () => undefined,
    };
  }
  if (kind === 'process-start') {
    const name = 'AGENTDECK_STUB_TASK_MARK';
    const value = newId();
    return {
      target: 'stub-task sleeper',
      hint: `${name}=${value}`,
      effect: () => {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
          env: { ...process.env, [name]: value },
          stdio: 'ignore',
        });
        children.push(child);
      },
      // Помеченные процессы в таблице ОС: второй запуск сверкой был бы вторым живым процессом.
      count: async () => {
        const found = await sweepMarker(name, value);
        if ('unknown' in found) throw new Error(found.unknown);
        return 'absent' in found ? 0 : found.value.length;
      },
      cleanup: () => undefined,
    };
  }
  // Трекер, контейнер: мира фазы 2 нет — эффект только счётчик.
  return {
    target: `stub/${kind}`,
    hint: `stub-${kind}`,
    effect: () => undefined,
    cleanup: () => undefined,
  };
}

describe('outbox crash inside every action (P86)', () => {
  it.each(
    probes('reconcile')
      // Действия публикации судит `outbox-crash.forge.test.ts`: их мир — голый репозиторий и форж.
      .filter(([, , , p]) => !READ_BY_FORGE.includes(p.action))
      .map(([id, i, task, p]) => [p.action, p.cut, id, i, task, p] as const),
  )('%s killed %s: the new core reconciles by fact', async (kind, cut, _id, _i, _task, probe) => {
    const fresh = await openFresh();
    const world = worldFor(kind);
    let task: LiveTask | undefined;
    try {
      let reached!: () => void;
      const atCut = new Promise<void>((resolve) => {
        reached = resolve;
      });
      // Ядро «умирает» в срезе: эффект (или его отсутствие) — и больше ни одной строки.
      void runAction(
        fresh.task,
        { kind, target: world.target, idempotencyHint: world.hint },
        () => {
          if (cut === 'after-effect') world.effect();
          reached();
          return new Promise(() => undefined);
        },
      );
      await atCut;
      // Дать процессу метки появиться в таблице, прежде чем новое ядро спросит факт.
      if (kind === 'process-start' && cut === 'after-effect')
        await new Promise((r) => setTimeout(r, 300));
      // Мёртвое ядро молчит дольше срока аренды: новое ядро забирает её, как после краха.
      const later = () => Date.now() + STALE_MS + 1_000;
      const reopened = await resume(
        fresh.dir,
        fresh.taskId,
        deps({ isAlive: async () => 'dead', now: later }),
      );
      if (!reopened.ok) throw new Error(reopened.reason);
      task = reopened.task;
      await reconcileCase(task, kind, probe);
      // Сверка не повторяет эффект вслепую: в МИРЕ ровно столько эффектов, сколько успело
      // до среза (каталог один, помеченный процесс один или ни одного).
      if (world.count) expect(await world.count()).toBe(cut === 'after-effect' ? 1 : 0);
    } finally {
      world.cleanup();
      task?.close();
      // Ядро до среза «умерло», но его писатель держит дескриптор журнала (Windows: EBUSY при
      // уборке temp) — закрыть; строка об отпуске аренды от мёртвого ядра здесь не судится.
      try {
        fresh.task.close();
      } catch {
        // аренда уже у нового ядра — закрытие старого писателя может отказать, это не предмет теста
      }
    }
  });
});

async function reconcileCase(
  task: LiveTask,
  kind: ActionKind,
  probe: Probe<'reconcile'>,
): Promise<void> {
  const before = task.state.seq;
  const want = probe.expect;
  let now = 1_000;
  const firstAsked = new Map<string, number>();
  const decisions = await reconcileTask(task, actionReaders(), { now: () => now }, firstAsked);
  expect(decisions.map((d) => d.verdict)).toEqual([want.verdict]);
  const kinds = linesAfter(task, before).map((l) => l.kind);
  expect(kinds[0]).toBe('decision');
  if (want.then) expect(kinds).toContain(want.then);
  else expect(kinds).toEqual(['decision']);
  if (want.pastWindow) {
    const def = READ_CLASSES[ACTION_READ_CLASS[kind]];
    now += ('retryUntilMs' in def ? def.retryUntilMs : 0) + 1;
    const beforeLate = task.state.seq;
    const late = await reconcileTask(task, actionReaders(), { now: () => now }, firstAsked);
    expect(late.map((d) => d.verdict)).toEqual([want.pastWindow.verdict]);
    const asks = Object.values(task.state.asks);
    expect(asks.map((a) => a.point)).toEqual([4]);
    // `then` за сроком объявлен в библиотеке — судится по журналу, а не только по состоянию.
    expect(linesAfter(task, beforeLate).map((l) => l.kind)).toContain(want.pastWindow.then);
  }
}

// Последним в файле: пробы выше уже прошли и записали классы, которые настоящий код журналит.
describe('panel decision outcomes over the phase-2 probes (stage 9, F1)', () => {
  it('the probes above journaled decisions of these classes, each with a declared outcome', () => {
    // Классы, чей писатель не исполняется пробами фазы 2, держит равенство типов в
    // `api/decision-outcomes.test.ts` (вид выхода ядра = объявленный список исходов).
    expect([...seenClasses].sort()).toEqual(['human-point', 'reconcile']);
  });
});
