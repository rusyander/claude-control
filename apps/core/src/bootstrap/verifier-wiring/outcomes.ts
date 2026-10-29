import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { compose } from '../../verifier/compose/index.ts';
import { afterRecord, readQuarantine, writeQuarantine } from '../../verifier/flaky/index.ts';
import { runPlan } from '../../verifier/mutate/index.ts';
import { classifyRed, decideRedBefore } from '../../verifier/red/index.ts';
import { mainCheckoutOf, writeCaseRuns, type CaseScope } from '../../verifier/tests-block/index.ts';

/**
 * Зона B (мутанты, итог, флаки, красные классы, писатель блока тестов): по судье на класс
 * решения (P01) — итог `compose`, повтор/карантин `afterRecord`, класс красного `classifyRed`,
 * ворота «красный до» `decideRedBefore`; прогоны кейсов `caseRuns` пишет в основную папку
 * репозитория задачи (G15). Проводник зовёт их на своём этапе — здесь только сборка.
 */
export interface OutcomesWiring {
  compose: typeof compose;
  afterRecord: typeof afterRecord;
  classifyRed: typeof classifyRed;
  decideRedBefore: typeof decideRedBefore;
  quarantine: { read: typeof readQuarantine; write: typeof writeQuarantine };
  /** Прогон кейсов из записи: `repo` — папка задачи (копия или основная). */
  caseRuns(rec: CheckRecord, repo: string, scope: CaseScope): Fact<string[]>;
  /** Шаг мутантов сценария (04:72-74): тот же инструмент, что `index.ts mutate`. */
  mutate: typeof runPlan;
}

export function outcomesWiring(): OutcomesWiring {
  return {
    compose,
    afterRecord,
    classifyRed,
    decideRedBefore,
    quarantine: { read: readQuarantine, write: writeQuarantine },
    caseRuns(rec, repo, scope) {
      const main = mainCheckoutOf(repo);
      if (!('value' in main)) return main;
      return writeCaseRuns(rec, main.value, scope);
    },
    mutate: runPlan,
  };
}
