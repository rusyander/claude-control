import { intakeCardSchema, type IntakeSource } from '@agentdeck/contracts/core/intake';
import type { ReconMap } from '@agentdeck/contracts/core/lead';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { AcceptanceRow, CardBuilt } from './intake.types.ts';
import { structuredAcceptanceOf } from './source.ts';

/**
 * Карточка приёма (P133-P134): цель, критерии (строки `requirement.extracted` — одна нумерация),
 * область, ограничения, не больше четырёх развилок с рекомендацией. Сборка — одним судом схемы
 * (`intakeCardSchema`): пятая развилка или рекомендация вне вариантов — отказ, каждая причина
 * названа, а не молча срезана.
 */

const GOAL_MAX = 2000;

/** Откуда критерий карточки: поле трекера — `structured`, правка человека — `human`, иначе проза. */
function fromOf(source: AcceptanceRow['source']): 'structured' | 'prose' | 'human' {
  if (source === 'ticket') return 'structured';
  return source === 'human' ? 'human' : 'prose';
}

/** Критерии приёма: все требования задачи, кроме найденных ревью (их на приёме ещё нет). */
function acceptanceOf(rows: readonly AcceptanceRow[]) {
  return rows
    .filter((r) => r.source !== 'review')
    .map((r) => ({ requirementId: r.id, text: r.text, from: fromOf(r.source) }));
}

function built(input: unknown): CardBuilt {
  const parsed = intakeCardSchema.safeParse(input);
  if (parsed.success) return { ok: true, card: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(card)'}: ${i.message}`),
  };
}

/** Первая непустая строка текста, не длиннее цели карточки. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, GOAL_MAX);
}

/**
 * Карточка из структурных источников (путь «сама»): цель — заголовок первого источника (или
 * первая строка тела, или запроса), критерии — уже записанные строки требований из полей.
 */
export function cardFromSources(
  sources: readonly IntakeSource[],
  rows: readonly AcceptanceRow[],
  digest: string,
  maskedRequest: string,
): CardBuilt {
  const head = sources[0];
  const goal = head?.title ?? firstLine(head?.body ?? '');
  return built({
    goal: goal || firstLine(maskedRequest),
    acceptance: acceptanceOf(rows),
    area: { paths: [], units: [] },
    constraints: [],
    unknowns: [],
    sourceDigest: digest,
  });
}

/**
 * Критерии источников, которых не вместит НИ ОДНА карточка (больше 100, текст сверх предела после
 * маски): шаг разбора собирает карточку из тех же строк требований и упрётся в ту же схему, так
 * что задача встала бы навсегда. Оценка отказывает сразу, назвав причину; `null` — вмещаются.
 */
export function acceptanceProblem(sources: readonly IntakeSource[]): string | null {
  const texts = structuredAcceptanceOf(sources);
  const id = newId();
  const probe = intakeCardSchema.shape.acceptance.safeParse(
    texts.map((text) => ({ requirementId: id, text, from: 'structured' })),
  );
  if (probe.success) return null;
  const why = probe.error.issues.map((i) => `${i.path.join('.') || '(list)'}: ${i.message}`);
  return `intake card: ${texts.length} acceptance criteria across the sources do not fit one card (${why.slice(0, 3).join('; ')}) — send fewer criteria or one source per task`;
}

/**
 * Карточка из заявления шага разбора: цель — его итог, критерии — требования задачи, развилки —
 * неизвестные с выбранным вариантом как рекомендацией, область — файлы карты разведки и единицы,
 * которых они касаются.
 */
export function cardFromClaim(
  claim: StepDoneCall,
  map: ReconMap | null,
  rows: readonly AcceptanceRow[],
  units: readonly string[],
  digest: string,
): CardBuilt {
  return built({
    goal: claim.summary,
    acceptance: acceptanceOf(rows),
    area: { paths: (map?.files ?? []).map((f) => f.path), units: [...units] },
    constraints: [],
    unknowns: (claim.forks ?? []).map((f) => ({
      question: f.question,
      recommendation: f.chosen,
      options: f.options,
    })),
    sourceDigest: digest,
  });
}
