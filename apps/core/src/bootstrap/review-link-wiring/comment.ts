import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { ForgeThread } from '@agentdeck/contracts/core/forge';
import type { RefusedSpan } from '../../publisher/text/index.ts';

/**
 * Тексты ревью по ссылке (этап 10, F8): итог в MR — одна заметка «Замечания ревью (N)» с
 * нумерованным списком (как запасной путь старой панели `reviewSummaryComment`), и секции брифа:
 * открытые нити MR (контекст ревью) и замечания для шага правки.
 */

export type Finding = NonNullable<StepDoneCall['findings']>[number];

/** Предел текста одного замечания в заметке и брифе: длинная простыня не съедает MR и контекст. */
export const FINDING_TEXT_MAX = 1000;
/** Сколько замечаний перечисляет бриф правки; остальное — в заметке ревью шага. */
export const FINDINGS_IN_BRIEF = 40;
const NOTE_MAX = 2000;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)} […]` : s);

const lineOf = (f: Finding): string =>
  `\`${f.file}:${f.line}\` [${f.severity}] — ${clip(f.text.replace(/\s+/g, ' ').trim(), FINDING_TEXT_MAX)}`;

/** Заметка в MR: заголовок с числом и нумерованный список; язык — язык задачи. */
export function reviewSummaryComment(findings: readonly Finding[], lang: 'ru' | 'en'): string {
  const head = lang === 'en' ? 'Review findings' : 'Замечания ревью';
  return [
    `**${head} (${findings.length})**`,
    '',
    ...findings.map((f, i) => `${i + 1}. ${lineOf(f)}`),
  ].join('\n');
}

/**
 * Куски, которые сито текста публикации не выпускает (локальный путь, id записи, секрет), —
 * вырезаются, а не отказывают всей заметке: замечание без пути полезнее, чем не отписанный MR.
 */
export function redact(text: string, spans: readonly RefusedSpan[]): string {
  let out = '';
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += `${text.slice(at, s.start)}[…]`;
    at = s.end;
  }
  return out + text.slice(at);
}

/** Бриф шага правки: что нашёл ревьюер (без этого правка видела бы только итог шага ревью). */
export function findingsBrief(findings: readonly Finding[]): string | null {
  if (findings.length === 0) return null;
  const shown = findings.slice(0, FINDINGS_IN_BRIEF);
  const more = findings.length - shown.length;
  return [
    `Review findings to fix (${findings.length}):`,
    ...shown.map((f, i) => `${i + 1}. ${lineOf(f)}`),
    ...(more > 0 ? [`+${more} more: see the review step summary.`] : []),
  ].join('\n');
}

/**
 * Бриф разбора и ревью: база диффа и открытые нити MR — контекст, а не то, на что отвечать
 * (ответы в нити — шаг `answer-reviewers` другого сценария).
 */
export function mrContextBrief(input: {
  url: string;
  reviewBase: string;
  targetBranch: string;
  threads: readonly ForgeThread[] | string;
}): string {
  const head = [
    `Merge request under review: ${input.url}.`,
    `Review base (merge base with ${input.targetBranch}): ${input.reviewBase}. ` +
      `The MR changes are git diff ${input.reviewBase}...HEAD in the copy (the unit_diff tool shows the same).`,
  ];
  if (typeof input.threads === 'string')
    return [...head, `MR threads could not be read: ${input.threads}. Do not guess them.`].join(
      '\n',
    );
  const open = input.threads.filter((t) => !t.resolved && t.notes.length > 0);
  if (open.length === 0) return [...head, 'The MR has no open threads.'].join('\n');
  return [
    ...head,
    `Open MR threads (${open.length}) — context only, do not answer them in this task:`,
    ...open.map((t) =>
      [`thread ${t.id}:`, ...t.notes.map((n) => `  ${n.author}: ${clip(n.body, NOTE_MAX)}`)].join(
        '\n',
      ),
    ),
  ].join('\n\n');
}
