import type { RunnerCandidate } from '@agentdeck/contracts';
import { detectCliOnPath } from '../../../providers/detect/detect.ts';
import { isFile, relPath } from './fs-probe.ts';
import { dotnetCandidates, jvmCandidates, rustCandidates } from './compiled.ts';
import { goCandidates } from './go.ts';
import { denoCandidates, nodeCandidates } from './node.ts';
import { pythonCandidates } from './python.ts';
import { taskRunnerCandidates } from './task-runners.ts';
import type { StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Все способы запустить каталог — по порядку предпочтения.
 *
 * Порядок: скрипт package.json (так проект и запускают), задачи сборщика
 * проекта (`make run` знает флаги и переменные), дальше догадка по языку.
 * Выбирается первый способ, чья программа есть на машине; нет ни одной —
 * первый, и панель называет недостающую программу до запуска.
 */
const DETECTORS = [
  nodeCandidates,
  denoCandidates,
  taskRunnerCandidates,
  goCandidates,
  pythonCandidates,
  rustCandidates,
  jvmCandidates,
  dotnetCandidates,
];

/** Найдена ли программа: файл-обёртка — по диску, остальное — по PATH. */
export type ToolCheck = (tool: string) => boolean;

export interface ResolvedCandidate extends StackCandidate {
  available: boolean;
}

function isAvailable(candidate: StackCandidate, hasTool: ToolCheck): boolean {
  if (candidate.toolPath) return isFile(candidate.toolPath);
  if (candidate.tool) return hasTool(candidate.tool);
  return true;
}

export function detectCandidates(
  probe: StackProbe,
  hasTool: ToolCheck = detectCliOnPath,
): ResolvedCandidate[] {
  const seen = new Set<string>();
  const found: ResolvedCandidate[] = [];
  for (const detect of DETECTORS) {
    for (const candidate of detect(probe)) {
      if (seen.has(candidate.display)) continue;
      seen.add(candidate.display);
      found.push({ ...candidate, available: isAvailable(candidate, hasTool) });
    }
  }
  return found;
}

/** Выбранный способ: первый доступный, иначе первый вообще. */
export function pickCandidate(found: ResolvedCandidate[]): ResolvedCandidate | undefined {
  return found.find((candidate) => candidate.available) ?? found[0];
}

/** Вид для клиента: доказательства — путями от корня проекта. */
export function candidateView(root: string, candidate: ResolvedCandidate): RunnerCandidate {
  return {
    command: candidate.display,
    stack: candidate.stack,
    ...(candidate.framework ? { framework: candidate.framework } : {}),
    evidence: candidate.evidence.map((path) => relPath(root, path)),
    ...(candidate.tool ? { tool: candidate.tool } : {}),
    available: candidate.available,
  };
}

export type { StackCandidate, StackProbe } from './stacks.types.ts';
export { goMainFile, goProgramDirs } from './go.ts';
