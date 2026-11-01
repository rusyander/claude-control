import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  PRESET_IDS,
  projectScenarioSchema,
  type Scenario,
  type ScenarioRef,
} from '@agentdeck/contracts/core/scenario';
import { allowedSetPrecedence, precedenceDecisionData } from '../../policy/resolve/precedence.ts';
import { issuesOf, readLibraryScenario, readTextAs } from './library.ts';
import { overlayScenario } from './overlay.ts';
import { isPresetId, presetOf } from './presets.ts';
import type {
  OverlayLayer,
  ReadNote,
  ScenarioRefusal,
  ScenarioRepo,
  ScenarioResolution,
} from './scenario.types.ts';

/**
 * Сценарий задачи по ссылке (02 §Scenario, G12): уровень 3 — пресет из кода или версия из
 * библиотеки человека, поверх — файл проекта каждого репозитория задачи (уровень 4, только
 * сужает). Уровень 5 (слой пользователя) файла сценария не имеет (G4): от него ядро берёт только
 * ход навыка (`agentdeck.steps` → подшаги `within` в брифе, `bootstrap/conductor-wiring/
 * scenario.ts`) и «правила модели только понижают» (судья права, подагенты); прочие ключи навыков
 * не читаются, проза не разбирается никогда (00:127). Нечитаемый или негодный файл — отказ
 * запуска с именем и пресетами взамен, никогда не тихая подмена (02:32, F25).
 */

/** Файл проекта уровня 4 внутри репозитория. Ядро его не пишет и не требует. */
export const PROJECT_SCENARIO_FILE = join('.agentdeck', 'scenario.json');

export interface ResolveDeps {
  /** `<дом ядра>/scenarios` (`layoutOf(home).scenarios`). */
  libraryDir: string;
}

function factKind(fact: Fact<unknown>): ReadNote['kind'] {
  if ('value' in fact) return 'value';
  return 'absent' in fact ? 'absent' : 'unknown';
}

type Base = { scenario: Scenario } | { refusal: ScenarioRefusal };

async function baseOf(ref: ScenarioRef, deps: ResolveDeps, facts: ReadNote[]): Promise<Base> {
  const label = `${ref.id}@${ref.version}`;
  if (isPresetId(ref.id)) {
    const preset = presetOf(ref);
    return preset
      ? { scenario: preset }
      : {
          refusal: {
            level: 3,
            source: label,
            reason: `preset ${ref.id} has no version ${ref.version}`,
          },
        };
  }
  const read = await readLibraryScenario(deps.libraryDir, ref);
  facts.push({
    readClass: 'scenario.library',
    kind: read.kind === 'value' || read.kind === 'invalid' ? 'value' : read.kind,
  });
  if (read.kind === 'value') return { scenario: read.scenario };
  const reason =
    read.kind === 'absent'
      ? 'no such scenario in the library'
      : `${read.kind === 'unknown' ? 'unreadable' : 'invalid'}: ${read.reason}`;
  return { refusal: { level: 3, source: `library ${label}`, reason } };
}

async function projectLayer(
  repo: ScenarioRepo,
  facts: ReadNote[],
): Promise<{ layer: OverlayLayer | null } | { refusal: ScenarioRefusal }> {
  const source = `${repo.repoKey}: ${PROJECT_SCENARIO_FILE.replaceAll('\\', '/')}`;
  const text = await readTextAs('scenario.project', join(repo.path, PROJECT_SCENARIO_FILE));
  facts.push({ readClass: 'scenario.project', kind: factKind(text) });
  if ('absent' in text) return { layer: null };
  if ('unknown' in text) {
    // Класс `scenario.project` на `unknown` — отказ: нечитаемый файл не «файла нет» (P44).
    return { refusal: { level: 4, source, reason: `unreadable: ${text.unknown}` } };
  }
  let json: unknown;
  try {
    json = JSON.parse(text.value);
  } catch (error) {
    return { refusal: { level: 4, source, reason: `not JSON: ${(error as Error).message}` } };
  }
  const parsed = projectScenarioSchema.safeParse(json);
  if (!parsed.success)
    return { refusal: { level: 4, source, reason: issuesOf(parsed.error).join('; ') } };
  return { layer: { level: 4, source, file: parsed.data } };
}

export async function resolveScenario(
  ref: ScenarioRef,
  repos: readonly ScenarioRepo[],
  deps: ResolveDeps,
): Promise<ScenarioResolution> {
  const facts: ReadNote[] = [];
  const refusals: ScenarioRefusal[] = [];
  const base = await baseOf(ref, deps, facts);
  if ('refusal' in base) refusals.push(base.refusal);
  const layers: OverlayLayer[] = [];
  // Каждый файл читается и при отказе основы: человек видит все препятствия разом.
  for (const repo of repos) {
    const got = await projectLayer(repo, facts);
    if ('refusal' in got) refusals.push(got.refusal);
    else if (got.layer) layers.push(got.layer);
  }
  if ('refusal' in base || refusals.length > 0)
    return { ok: false, refusals, offer: PRESET_IDS, facts };
  const result = overlayScenario(base.scenario, layers);
  if (result.refused) {
    return {
      ok: false,
      refusals: result.rejected.map((e) => ({
        level: 3,
        source: `${ref.id}@${ref.version}`,
        reason: e.reason,
      })),
      offer: PRESET_IDS,
      facts,
    };
  }
  return {
    ok: true,
    scenario: result.scenario,
    base: ref,
    overlay: { applied: result.applied, rejected: result.rejected },
    precedence: result.precedence,
    facts,
  };
}

/**
 * Данные ОДНОЙ строки `decision {class:'precedence'}` разрешения (G1, P80): ключи сценария и
 * набор маршрутов задачи рядом. Оценка, правка сценария и деление зовут её над одинаковым
 * входом — решение одно и то же, какой бы дорогой ни пришло.
 */
export function scenarioPrecedence(
  got: Extract<ScenarioResolution, { ok: true }>,
  allowed: { routes: readonly unknown[]; level: number },
): ReturnType<typeof precedenceDecisionData> {
  return precedenceDecisionData(
    [...got.precedence, allowedSetPrecedence(allowed.routes, allowed.level)],
    got.facts,
  );
}
