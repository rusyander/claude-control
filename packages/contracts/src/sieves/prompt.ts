import { SIEVE_LANG, type RiskAssessment, type SieveDef, type SieveStage } from './catalog.ts';
import { needsRow, type SieveMechanics } from './judge.ts';
import type { LearnedSieve } from './learned.ts';
import { EVIDENCE_MIN, type SieveReportRow } from './report.ts';

// ---------------------------------------------------------------- задания

/** Что панель уже отметила сама — строками для задания; пусто — ничего. */
function mechanicsLines(mechanics: SieveMechanics | undefined): string[] {
  if (!mechanics) return [];
  const lines: string[] = [];
  const list = (items: readonly string[] | undefined): string =>
    (items ?? []).slice(0, 10).join(', ');
  if (mechanics.consumers?.length) {
    lines.push(
      'The panel found removed names still used outside the diff — fix each consumer or name ' +
        'every file in the consumers-repo-wide row with why it is not a consumer:',
      ...mechanics.consumers.slice(0, 10).map((hit) => `- ${hit.token}: ${hit.files.join(', ')}`),
    );
  }
  if (mechanics.foreignRemovals?.length) {
    lines.push(
      `The panel found removed lines that landed in main after the group started: ` +
        `${list(mechanics.foreignRemovals)} — restore them, or name every file in the ` +
        'foreign-removals row with why the removal is intended.',
    );
  }
  if (mechanics.conflicts?.length) {
    lines.push(
      `Merging with fresh main conflicts in: ${list(mechanics.conflicts)} — rebase onto ` +
        'fresh main and resolve.',
    );
  }
  const flagged: [string, readonly string[] | undefined, string][] = [
    ['secrets', mechanics.secrets, 'a key, token or private key in added lines'],
    ['debug-leftovers', mechanics.debugLeftovers, 'focused tests, debugger or conflict markers'],
    ['committed-artifacts', mechanics.artifacts, 'files that should not be in git'],
    ['lockfile-sync', mechanics.lockfiles, 'manifests changed without their lockfile'],
    ['env-config', mechanics.envVars, 'environment variables declared nowhere'],
    ['tests-alongside', mechanics.untestedCode, 'code changed with no test changed'],
    ['migration-safety', mechanics.destructive, 'destructive migration statements'],
  ];
  for (const [id, items, what] of flagged) {
    if (items?.length) lines.push(`The panel flagged [${id}] — ${what}: ${list(items)}.`);
  }
  return lines;
}

/**
 * Абзац сит для задания звена: сита своего звена — делать, механика панели — к
 * сведению, что панель уже нашла, найденные команды проверок проекта, риск,
 * выученные сита и формат отчёта. Пусто — дифф пуст и сит нет.
 */
export function sievePromptBlock(input: {
  stage: SieveStage;
  applicable: readonly SieveDef[];
  learned?: readonly Pick<LearnedSieve, 'class' | 'trigger' | 'check' | 'sources'>[];
  mechanics?: SieveMechanics;
  /** Отчёт прошлых звеньев: пройденное повторять не надо. */
  done?: readonly SieveReportRow[];
  /** Сита, чья сданная строка устарела (код менялся после неё) — делать заново. */
  stale?: readonly string[];
  /** Риск правки: на высоком задание называет причины. */
  risk?: RiskAssessment;
  /** В копии есть блок «Тесты» — живую проверку доказывают его прогоном. */
  testsBlock?: boolean;
}): string {
  const { stage, applicable } = input;
  if (applicable.length === 0 && !input.learned?.length) return '';
  const stale = new Set(input.stale ?? []);
  const done = new Set(
    (input.done ?? [])
      .filter(
        (row) => row.status !== 'fail' && row.evidence.length >= EVIDENCE_MIN && !stale.has(row.id),
      )
      .map((row) => row.id),
  );
  const mine = applicable.filter((sieve) => stage === 'deliver' || sieve.stage === 'review');
  const own = mine.filter((sieve) => needsRow(sieve) && !done.has(sieve.id));
  const panel = mine.filter((sieve) => !needsRow(sieve));
  const lines = [
    'Sieves before the MR — each comes from a real reviewer blocker or a class of production ' +
      'incident. The panel checks the report at delivery: a sieve with no row or no evidence ' +
      'keeps the group from "done".',
  ];
  if (input.risk?.tier === 'high') {
    lines.push(`This change is HIGH risk (${input.risk.reasons.join('; ')}).`);
  }
  own.forEach((sieve, index) => {
    const again = stale.has(sieve.id) ? ' (again: code changed after your last row)' : '';
    lines.push(`${index + 1}. [${sieve.id}]${again} ${sieve.text}`);
  });
  const checks = input.mechanics?.checks ?? [];
  if (checks.length > 0 && own.some((sieve) => sieve.id === 'project-checks')) {
    lines.push(
      `Project checks the panel found (name EVERY one in the project-checks row): ` +
        `${checks.map((check) => check.command).join(' ; ')}`,
    );
  }
  if (panel.length > 0) {
    lines.push(
      'The panel itself checks these on every delivery (no row needed unless it flags ' +
        'something): ' +
        panel.map((sieve) => sieve.id).join(', ') +
        '.',
    );
  }
  lines.push(...mechanicsLines(input.mechanics));
  if (input.learned?.length) {
    lines.push('Sieves learned from earlier MR blockers (apply those that fit this change):');
    for (const sieve of input.learned) {
      const seen = sieve.sources.length > 1 ? ` (seen ${sieve.sources.length}×)` : '';
      lines.push(`- [${sieve.class}] when ${sieve.trigger} → ${sieve.check}${seen}`);
    }
  }
  const proved = own.filter((sieve) => sieve.proof === 'run').map((sieve) => sieve.id);
  if (input.testsBlock && proved.length > 0) {
    lines.push(
      `This project has an AgentDeck Tests section: for ${proved.join(', ')} record the live ` +
        'check there (tests-cli run, or tests-cli record … --note "<how you checked>") and cite ' +
        'it in the evidence as run:<id> — the id tests-cli prints. The panel opens that run: it ' +
        'must exist, have no failed or blocked case, and be newer than the last change to the ' +
        'code the sieve covers.',
    );
  }
  if (own.length > 0) {
    lines.push(
      'A row counts for the code it was written on: change that code afterwards and the sieve ' +
        'must be reported again.',
      `Report at the end of the answer in a code block in the language ${SIEVE_LANG}: ` +
        '{"sieves":[{"id":"<sieve id>","status":"pass|fail|n/a","evidence":"command and the line ' +
        'of its output, or why it does not apply"}]} — one row per numbered sieve, plus a row ' +
        'for any panel check you clear by naming its files.',
    );
  }
  return lines.join('\n');
}

/**
 * Хвост задания по MR-тредам: как разложить каждый тред в сито. Ссылку треда
 * брать ровно ту, что дана, — по ней панель проверяет, что блокер настоящий.
 */
export const LEARN_SIEVES_LINE =
  'After the fixes, turn each listed thread into a sieve — the check that would have caught it ' +
  `before the MR. Add to the answer a code block in the language ${SIEVE_LANG} with ` +
  '{"learned":[{"thread":"<the link exactly as listed above>","class":"contract|integration|' +
  'isolation|consumers|boundary|security|data|hygiene|release|other","scope":"project|global",' +
  '"trigger":"which kind of change produces this blocker","check":"the concrete check to run ' +
  'before the MR"}]}. A thread that is a matter of taste gets no sieve.';
