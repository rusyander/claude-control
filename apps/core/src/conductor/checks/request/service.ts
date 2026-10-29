import type {
  CheckAnswer,
  CheckDecision,
  CheckRequest,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { decideCheck } from '../../../verifier/decide/index.ts';
import { runCheck } from '../../../verifier/run/run.ts';
import type { CheckDeps } from '../checks.types.ts';
import { finish } from './caller.ts';
import { execute } from './execute.ts';
import { gather, replayAnswer, writeAbsent } from './gather.ts';
import { ANSWER_BUDGET_MS, POLL_MS, flagLike, sleep, why } from './helpers.ts';
import { journalDecision, withLosses } from './journal.ts';
import { waitFlight } from './lease.ts';
import { notRegistered, unsafeSelection } from './refusals.ts';
import type { CheckService, Pending, ServiceState } from './request.types.ts';

/** Сборка входа и его цикл решения; порядок и инварианты — в фасаде `../request.ts`. */

async function requestCheck(
  s: ServiceState,
  budget: number,
  req: CheckRequest,
): Promise<CheckAnswer> {
  const { deps, poll } = s;
  const answerBy = deps.now() + budget;
  let lockTimeout = false;
  for (;;) {
    const g = await gather(s, req, lockTimeout);
    if (req.checkId !== undefined && !('value' in g.registry)) {
      // Реестр не прочитан — «нет такой проверки» сказать нельзя (G3 только при прочитанном).
      const unmet: Unmet[] = [
        {
          code: 'registry-unreadable',
          subject: why(g.registry),
          next: 'fix the profile read, then ask again',
        },
        ...g.input.blockers,
      ];
      const decision: CheckDecision = {
        kind: 'refuse',
        unmet,
        next: 'ask again once the registry reads',
      };
      journalDecision(s, req, g, decision, []);
      return decision;
    }
    if (g.match.kind === 'derived' && req.exec === 'core') {
      // Ядро своим раннером гонит только проверки реестра (03:97). Производная запись — для
      // дорог захвата, где argv уже исполняет сама сессия под своими правами; argv модели вне
      // реестра обошёл бы и судью прав, и «только чтение» шага обзора.
      const decision = notRegistered(g);
      journalDecision(s, req, g, decision, []);
      return decision;
    }
    const judged = decideCheck(g.input);
    const decision =
      judged.kind === 'run' && judged.selection.some(flagLike)
        ? unsafeSelection(judged.selection)
        : judged;
    journalDecision(s, req, g, decision, lockTimeout ? ['lock-timeout'] : []);
    switch (decision.kind) {
      case 'replay':
        return replayAnswer(g, decision.recordId, decision.header);
      case 'absent':
        return { kind: 'absent', recordId: decision.recordId };
      case 'narrow':
        return { kind: 'narrow', units: decision.units, reason: decision.reason };
      case 'defer':
        return decision;
      case 'refuse':
        return decision;
      case 'wait': {
        const key = 'value' in g.key ? g.key.value.key : null;
        if (!key) return { kind: 'running', checkRunId: decision.checkRunId, since: deps.now() };
        const waited = await waitFlight(s, req, key, decision.deadlineMs, answerBy);
        if (waited === 'budget')
          return {
            kind: 'running',
            checkRunId: decision.checkRunId,
            since: g.input.inflight?.since ?? deps.now(),
          };
        if (waited === 'timeout') lockTimeout = true;
        continue;
      }
      case 'run': {
        if (g.match.kind === 'absent') return writeAbsent(s, req, g, g.match.checkId);
        const out = await execute(
          s,
          req,
          g,
          g.match.entry,
          g.match.unit,
          decision,
          lockTimeout,
          answerBy,
        );
        if (!('contended' in out)) return out;
        // Ключ взял другой — следующий круг увидит его и будет ждать. Держатель не читается
        // (EISDIR, EPERM) — круг без паузы жёг бы ЦП и журнал, поэтому пауза и бюджет ответа.
        if (deps.now() >= answerBy)
          return out.contended
            ? {
                kind: 'running',
                checkRunId: out.contended.checkRunId,
                since: out.contended.since,
              }
            : { kind: 'defer', until: 'slot', reason: `in-flight lock: ${out.reason}` };
        await sleep(poll);
        continue;
      }
    }
  }
}

export function createCheckService(deps: CheckDeps): CheckService {
  const budget = deps.answerBudgetMs ?? ANSWER_BUDGET_MS;
  const pending = new Map<string, Pending>();
  const s: ServiceState = {
    deps,
    poll: deps.pollMs ?? POLL_MS,
    run: deps.run ?? runCheck,
    pending,
    lost: new WeakMap<CheckRequest, string[]>(),
  };

  return {
    requestCheck: async (req) => withLosses(s, req, await requestCheck(s, budget, req)),
    completeCheck: async (checkRunId, result) => {
      const req = pending.get(checkRunId)?.req;
      const answer = await finish(s, checkRunId, result, 'exit');
      return req ? withLosses(s, req, answer) : answer;
    },
    pending: () => [...pending.keys()],
    logPath: (req, recordId) => {
      const store = deps.store(req);
      return 'value' in store ? store.value.logPath(recordId) : null;
    },
  };
}
