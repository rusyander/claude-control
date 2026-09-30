import {
  applicableSieves,
  BUILTIN_SIEVES,
  judgeSieves,
  riskTier,
  sievePromptBlock,
  staleSieveIds,
  type SieveClass,
  type SieveGap,
  type SieveMechanics,
  type SieveReportRow,
  type SieveStage,
} from '@agentdeck/contracts/sieves';
import { serverText } from '../../lib/server-texts.ts';
import { projectChecks } from '../project-git/project-checks.ts';
import { readSieveFacts, touchedFacts } from '../project-git/sieve-facts.ts';
import { untestedCodeIn } from '../project-git/sieve-scan.ts';
import { sieveProofFacts } from './sieve-proof.ts';
import type { SieveStore } from './sieve-store.ts';

/**
 * Сита перед MR на двух концах конвейера (решение владельца 28.09):
 *
 * - ЗАДАНИЕ звена ревью/доставки — абзац сит по затронутым путям копии,
 *   выученным ситам проекта и уже сданному отчёту (`sievePrompt`);
 * - ПРОВЕРКА доставки — механика git панели плюс судья отчёта; пробелы
 *   становятся строками «не хватает», и группа получает их напоминанием тем же
 *   путём, что непушнутая ветка (`sieveDeliveryGaps`).
 */

/** Механика, которой не нужна сеть: команды проекта и код без тестов. */
function localMechanics(cwd: string, paths: readonly string[]): SieveMechanics {
  const checks = projectChecks(cwd);
  const untestedCode = untestedCodeIn(paths);
  return {
    ...(checks.length > 0 ? { checks } : {}),
    ...(untestedCode.length > 0 ? { untestedCode } : {}),
  };
}

/**
 * Абзац сит для задания звена. Сит нет (пустой дифф, нет выученных) — пусто.
 * Без сети: пути и развилка — с локальной ссылкой основной, команды проверок —
 * из манифестов копии. Строки, сданные раньше, но устаревшие после новых
 * коммитов, звено делает заново; выученные сита — только задетых областей.
 */
export async function sievePrompt(input: {
  cwd: string;
  stage: SieveStage;
  done: readonly SieveReportRow[];
  store?: SieveStore;
  projectPath?: string;
}): Promise<string> {
  const { paths, base } = await touchedFacts(input.cwd);
  const applicable = applicableSieves(paths);
  const learned = input.store?.forProject(input.projectPath ?? input.cwd, undefined, paths) ?? [];
  const proof = await sieveProofFacts({
    cwd: input.cwd,
    rows: input.done,
    ...(base ? { base } : {}),
    branchPaths: paths,
  });
  return sievePromptBlock({
    stage: input.stage,
    applicable,
    learned,
    done: input.done,
    mechanics: localMechanics(input.cwd, paths),
    stale: staleSieveIds(applicable, proof.changedAfterRow ?? {}),
    risk: riskTier(paths),
    ...(proof.testsBlock ? { testsBlock: true } : {}),
  });
}

/**
 * Место абзаца сит в задании звена. Планировщики звеньев синхронные — их
 * событие уходит в ленту в самом конце хода, — а пути копии читаются
 * асинхронно: git на большой копии не имеет права держать сервер. Поэтому план
 * собирается с меткой, а запуск звена ждёт абзац и ставит его на место.
 */
export const SIEVE_SLOT = '<<agentdeck:sieve-slot>>';

/** Какое звено попросило абзац и что уже сдано — запомнено при сборке плана. */
export interface SieveAsk {
  stage: SieveStage;
  done: readonly SieveReportRow[];
}

/** Метка — абзацем; пустой абзац уносит метку вместе с пустыми строками перед ней. */
export function fillSieveSlot(prompt: string, paragraph: string): string {
  return paragraph
    ? prompt.replace(SIEVE_SLOT, () => paragraph)
    : prompt.replace(/\n*<<agentdeck:sieve-slot>>/, '');
}

/** Класс, в который пробел сита идёт в счёт «пойман до MR»; нет — не блокер. */
export function caughtClass(gap: SieveGap): SieveClass | undefined {
  switch (gap.code) {
    case 'sieve-gap-conflicts':
    case 'sieve-gap-foreign-removals':
      return 'integration';
    case 'sieve-gap-consumers':
      return 'consumers';
    case 'sieve-gap-lockfile':
    case 'sieve-gap-env':
      return 'integration';
    case 'sieve-gap-secrets':
      return 'security';
    case 'sieve-gap-debug':
    case 'sieve-gap-artifacts':
    case 'sieve-gap-untested':
      return 'hygiene';
    case 'sieve-gap-destructive':
      return 'data';
    case 'sieve-gap-failed':
    case 'sieve-gap-run-red':
      return BUILTIN_SIEVES.find((sieve) => sieve.id === gap.params.sieve)?.class ?? 'other';
    default:
      // Несданная, устаревшая или недоказанная строка — пробел отчёта, а не
      // пойманный блокер.
      return undefined;
  }
}

export interface SieveDeliveryGaps {
  /** Строки «не хватает» — шаблоны сервера, их читает группа и хаб. */
  missing: string[];
  classes: SieveClass[];
  /** Какие проверки не сделаны (сеть, старый git) — в журнал, не в пробелы. */
  unchecked?: string[];
}

/** Пробелы сит группы перед «доставлено». */
export async function sieveDeliveryGaps(input: {
  cwd: string;
  startedAt?: string;
  rows: readonly SieveReportRow[];
}): Promise<SieveDeliveryGaps> {
  const facts = await readSieveFacts({
    cwd: input.cwd,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  });
  // Без remote, основной или общей базы git-механика молчит, но сита отчёта — фокус
  // в браузере, граничный ввод — судятся по тем же путям, что попали в задание:
  // иначе такая копия сдавала бы «готово» без единой строки (ревью сит, 28.09).
  const local = facts.paths.length === 0 && facts.unchecked?.length;
  const fallback = local ? await touchedFacts(input.cwd) : undefined;
  const paths = fallback?.paths ?? facts.paths;
  // Без удалённого git-механика молчит, но команды проекта и код без тестов
  // сети не требуют — их проверка остаётся и такой копии.
  const mechanics = fallback
    ? { ...localMechanics(input.cwd, paths), ...facts.mechanics }
    : facts.mechanics;
  const base = fallback?.base ?? facts.base;
  const proof = await sieveProofFacts({
    cwd: input.cwd,
    rows: input.rows,
    ...(facts.commits && !fallback ? { commits: facts.commits } : {}),
    ...(base ? { base } : {}),
    branchPaths: paths,
  });
  const gaps = judgeSieves({
    applicable: applicableSieves(paths),
    rows: input.rows,
    mechanics,
    proof,
  });
  const classes = [
    ...new Set(gaps.map(caughtClass).filter((cls): cls is SieveClass => Boolean(cls))),
  ];
  return {
    missing: gaps.map((gap) => serverText(gap.code, gap.params)),
    classes,
    ...(facts.unchecked ? { unchecked: facts.unchecked } : {}),
  };
}
