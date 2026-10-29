import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CaptureAnswer,
  CheckAnswer,
  CheckRequest,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { CAPTURE_RESULT_PATH } from '../../api/session-capture.ts';
import type {
  CaptureCheckAsk,
  CaptureEntry,
  CaptureResultOwner,
} from '../../api/session-capture.types.ts';
import type { CheckService, Match } from '../../conductor/checks/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { WorkTreeOf } from '../../platform/git.ts';
import type { RecordStore } from '../../verifier/store/index.ts';
import { matchCaptured } from './node-script.ts';
import { classOf, type QueueWiring } from './queue.ts';

/**
 * Дороги захвата → единственный вход проверок (G21, волна 2): вопрос прокладки становится
 * `requestCheck` с `exec: 'caller'`, ответ входа — видом прокладки. Сопоставление argv с реестром —
 * то же `matchRequest`, что у входа; захваченный прогон, не узнанный реестром, гонится под
 * производным id `captured:` (04:51 — предложение в отчёте), а не мимо очереди.
 *
 * Насквозь (без очереди, названо) идёт только то, что ядро не может положить в записи: каталог
 * не в репозитории задачи, реестр не прочитан, прогон в другой папке, чем у проверки (тот же
 * argv в другой папке — другая команда), лог повтора не сходится со своей записью, тот же ключ
 * гонит другой прогон дольше срока ожидания. Ложного вердикта ни на одной ветке нет: сомнение →
 * прогон (F25). Отказ и отсрочка — свои коды выхода, не код красного теста: 78 (условия не
 * выполнены, EX_CONFIG) и 75 (позже, EX_TEMPFAIL).
 *
 * Итог под арендой принимается только от её владельца: аренда сессии — от токена той же задачи,
 * аренда псевдозадачи — от доступа захвата. Запись не легла — отказ, и прокладка кладёт итог в
 * очередь `spool/` (он станет записью `unattended`, а не пропадёт).
 */

export const REFUSE_EXIT = 78;
export const DEFER_EXIT = 75;
/** Сколько вопрос ждёт чужой прогон того же ключа (P68), прежде чем пойти насквозь; у прокладки — 15 мин. */
export const CAPTURE_JOIN_MS = 10 * 60_000;

export interface CaptureEntryDeps {
  queue: Pick<QueueWiring, 'parts' | 'scope'>;
  registry: Pick<TaskRegistry, 'open'>;
  workTree(dir: string): Promise<Fact<WorkTreeOf>>;
  commonDir(dir: string): Fact<string>;
  now(): number;
  joinMs?: number;
  note?: (event: string, data: Record<string, unknown>) => void;
  /** Скрипты `package.json` папки прогона (перевод argv уровня node, A2-F01); тесты подменяют. */
  scripts?: (dir: string) => Fact<Record<string, string>>;
}

interface Lease {
  leaseId: string;
  origin: CaptureCheckAsk['origin'];
  taskId: string;
}

type Through = Extract<CaptureAnswer, { kind: 'pass-through' }> & { outside: string };

interface Asked {
  service: CheckService;
  store: () => Fact<RecordStore>;
  /** Запись реестра, узнанная по argv; производная `captured:` — `null` (по единицам не сужается). */
  entryId: string | null;
  /** Запись узнана через скрипт пакета (A2-F01): её argv — команда менеджера, не бегуна. */
  viaScript: boolean;
  narrowed: boolean;
}

const matchId = (m: Match): string => (m.kind === 'absent' ? m.checkId : m.entry.id);

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

export function captureEntry(deps: CaptureEntryDeps): CaptureEntry {
  const leases = new Map<string, Lease>();
  const note = deps.note ?? (() => undefined);

  function through(ask: CaptureCheckAsk, outside: string): Through {
    note('capture.outside', { taskId: ask.taskId, argv: ask.argv, cwd: ask.cwd, reason: outside });
    return { kind: 'pass-through', outside };
  }

  /** Выданные аренды, которых вход больше не держит (срок вышел), — из учёта владельцев. */
  function prune(service: CheckService): void {
    const held = new Set(service.pending());
    for (const id of leases.keys()) if (!held.has(id)) leases.delete(id);
  }

  /** Запрос входа по вопросу: задача, репозиторий по папке прогона, единицы, класс и фаза. */
  async function requestOf(
    ask: CaptureCheckAsk,
    tree: WorkTreeOf,
  ): Promise<{ req: CheckRequest; baseRef: string | null } | { outside: string }> {
    if (ask.origin === 'pseudo') {
      // Псевдозадача (04:42): своей базы и репозиториев нет — ключ репозитория из общего каталога.
      return {
        req: {
          road: ask.road,
          origin: 'pseudo',
          taskId: ask.taskId,
          stepId: null,
          // repoKey = настоящий путь общего каталога git (00 §repoKey): тот же ключ, что у задач
          // ядра над этим репозиторием, — общий профиль и записи проверок.
          project: tree.common,
          copyDir: tree.top,
          class: 'background',
          phase: 'mid-task',
          argv: ask.argv,
          unit: '',
          changedUnits: [],
          exec: 'caller',
          callerEnv: ask.env,
        },
        baseRef: null,
      };
    }
    const opened = await deps.registry.open(ask.taskId);
    if ('refused' in opened) return { outside: `task unavailable: ${opened.refused}` };
    const created = opened.task.state.created;
    const repo = created?.repos.find((r) => {
      const common = deps.commonDir(r.path);
      return 'value' in common && common.value === tree.common;
    });
    if (!created || !repo)
      return { outside: `cwd ${ask.cwd} is not inside a repository of task ${ask.taskId}` };
    const bound = ask.sessionId ? bindingOf(opened.task, ask.sessionId) : null;
    if (!bound || 'refused' in bound)
      return { outside: `session not bound: ${bound ? bound.reason : 'no session'}` };
    const stepKind = bound.binding.stepKind;
    return {
      req: {
        road: ask.road,
        origin: 'session',
        taskId: ask.taskId,
        stepId: ask.stepId,
        project: repo.repoKey,
        copyDir: tree.top,
        class: classOf(stepKind),
        phase: stepKind === 'final-gate' ? 'final' : 'mid-task',
        argv: ask.argv,
        unit: '',
        changedUnits: [],
        exec: 'caller',
        callerEnv: ask.env,
      },
      baseRef: repo.baseRef,
    };
  }

  /** Повтор записи: лог сверен с записью (sha) — иначе прокладке нечего честно показать. */
  function replayOf(
    ask: CaptureCheckAsk,
    store: Fact<RecordStore>,
    answer: { recordId: string; header: string; exit: number | null; verdict: string },
  ): CaptureAnswer {
    if (!('value' in store)) return through(ask, `replay: store ${why(store)}`);
    const log = store.value.log(answer.recordId);
    if (!('value' in log)) return through(ask, `replay log unreadable: ${why(log)}`);
    const green = answer.verdict === 'pass' || answer.verdict === 'pass-flaky';
    return {
      kind: 'replay',
      recordId: answer.recordId,
      // Записи без кода (сигнал) повторяются кодом своего вердикта: зелёный — 0, иначе 1.
      exit: answer.exit ?? (green ? 0 : 1),
      logPath: store.value.logPath(answer.recordId),
      header: answer.header,
    };
  }

  function refuse(unmet: Unmet[], next: string, exit: number): CaptureAnswer {
    return { kind: 'refuse', unmet, next, exit };
  }

  async function answerOf(
    ask: CaptureCheckAsk,
    req: CheckRequest,
    answer: CheckAnswer,
    ctx: Asked,
  ): Promise<CaptureAnswer> {
    const { service, store, narrowed } = ctx;
    switch (answer.kind) {
      case 'replay':
        return replayOf(ask, store(), answer);
      case 'ran':
        // Вызывающему вход отдаёт аренду, а не прогон; пришло `ran` — повтор его записи.
        return answer.recordId === null
          ? through(ask, `ran in the core without a record: ${answer.note ?? 'no note'}`)
          : replayOf(ask, store(), {
              recordId: answer.recordId,
              header: `[agentdeck] ran ${answer.checkRunId} in the core`,
              exit: answer.exit,
              verdict: answer.verdict.kind,
            });
      case 'leased': {
        leases.set(answer.checkRunId, {
          leaseId: answer.leaseId,
          origin: ask.origin,
          taskId: ask.taskId,
        });
        const base = {
          leaseId: answer.leaseId,
          checkRunId: answer.checkRunId,
          resultUrl: CAPTURE_RESULT_PATH,
        };
        return narrowed ? { kind: 'narrow', argv: answer.argv, ...base } : { kind: 'run', ...base };
      }
      case 'running':
        return through(
          ask,
          `same key still running as ${answer.checkRunId} since ${new Date(answer.since).toISOString()}; runs uncaptured`,
        );
      case 'defer':
        return refuse(
          [
            {
              code: answer.until === 'disk' ? 'disk' : 'budget',
              subject: `deferred (${answer.until}): ${answer.reason}`,
              next: 'run it again later',
            },
          ],
          'run it again later',
          DEFER_EXIT,
        );
      case 'refuse':
        return refuse(answer.unmet, answer.next, REFUSE_EXIT);
      case 'absent':
        return refuse(
          [
            {
              code: 'record-missing',
              subject: `not in the registry (record ${answer.recordId})`,
              next: 'register the check in the profile',
            },
          ],
          'register the check in the profile',
          REFUSE_EXIT,
        );
      case 'narrow': {
        // Посреди работы единица вне изменённых (04:56): одна изменённая — гонится она (сужение);
        // ни одной или несколько — отказ с их списком: прокладка исполняет один argv. Дорога
        // `node-preload` меняет только аргументы главного скрипта; запись, узнанная через скрипт
        // пакета, отдала бы argv менеджера (`pnpm run test …`) — бегун получил бы чужие слова,
        // там тоже отказ со списком.
        if (
          !narrowed &&
          ctx.entryId !== null &&
          answer.units.length === 1 &&
          !(ctx.viaScript && ask.road === 'capture-preload')
        ) {
          // По id записи, не по argv: argv спрошенной единицы с другой единицей не сопоставится.
          const { argv: _argv, ...rest } = req;
          void _argv;
          const again = await service.requestCheck({
            ...rest,
            checkId: ctx.entryId,
            unit: answer.units[0] as string,
          });
          return answerOf(ask, req, again, { ...ctx, narrowed: true });
        }
        return refuse(
          [
            {
              code: 'selection-empty',
              subject: `${answer.reason}; changed units: ${answer.units.join(', ') || 'none'}`,
              next:
                answer.units.length === 0
                  ? 'change code in a unit first; the whole suite runs at the final gate'
                  : `run the check for each changed unit: ${answer.units.join(', ')}`,
            },
          ],
          'narrow the run to a changed unit',
          REFUSE_EXIT,
        );
      }
    }
  }

  return {
    async ask(ask) {
      const parts = await deps.queue.parts();
      if (!('value' in parts)) return through(ask, `verifier not ready: ${why(parts)}`);
      const { service, deps: checks } = parts.value;
      prune(service);
      const tree = await deps.workTree(ask.cwd);
      if (!('value' in tree))
        return through(ask, `cwd ${ask.cwd} is not in a git work tree: ${why(tree)}`);
      const built = await requestOf(ask, tree.value);
      if ('outside' in built) return through(ask, built.outside);
      const scope = await deps.queue.scope({
        repoKey: built.req.project,
        path: built.req.copyDir,
        baseRef: built.baseRef,
      });
      if (!('value' in scope.registry))
        return through(ask, `registry unreadable: ${why(scope.registry)}`);
      const { req, match, viaScript } = matchCaptured(
        { ...built.req, changedUnits: scope.changedUnits },
        scope.registry.value,
        { cwd: ask.cwd, prefix: tree.value.prefix },
        deps.scripts,
      );
      // Та же команда в другой папке — другой прогон: ключ проверки знает только её папку.
      const want = match.kind === 'entry' ? match.entry.cwd : '';
      if (tree.value.prefix !== want)
        return through(
          ask,
          `ran in ${tree.value.prefix || '.'}, while ${matchId(match)} runs in ${want || '.'}`,
        );
      const store = () => checks.store(req);
      let answer = await service.requestCheck(req);
      // Тот же ключ гонит другой прогон (P68): повторный вопрос присоединяется, пока есть срок.
      const until = deps.now() + (deps.joinMs ?? CAPTURE_JOIN_MS);
      while (answer.kind === 'running' && deps.now() < until)
        answer = await service.requestCheck(req);
      return answerOf(ask, req, answer, {
        service,
        store,
        entryId: match.kind === 'entry' ? match.entry.id : null,
        viaScript,
        narrowed: false,
      });
    },

    async result(owner: CaptureResultOwner, result) {
      const lease = leases.get(result.checkRunId);
      if (!lease) return { refused: `check run ${result.checkRunId} is not held by this core` };
      if (lease.leaseId !== result.leaseId)
        return { refused: `lease ${result.leaseId} is not the lease of ${result.checkRunId}` };
      if (
        lease.origin !== owner.origin ||
        (owner.origin === 'session' && owner.taskId !== lease.taskId)
      )
        return { refused: `lease of ${result.checkRunId} belongs to another caller` };
      const parts = await deps.queue.parts();
      if (!('value' in parts)) return { refused: `verifier not ready: ${why(parts)}` };
      leases.delete(result.checkRunId);
      const done = await parts.value.service.completeCheck(result.checkRunId, {
        exit: result.exit,
        ms: result.ms,
        log: result.log,
        signal: result.signal,
        truncated: result.truncated === true,
      });
      if (done.kind === 'ran' && done.recordId !== null) return { taken: true };
      if (done.kind === 'ran') return { refused: `not recorded: ${done.note ?? 'store refused'}` };
      if (done.kind === 'refuse') return { refused: done.unmet.map((u) => u.subject).join('; ') };
      return { refused: `unexpected answer ${done.kind}` };
    },
  };
}
