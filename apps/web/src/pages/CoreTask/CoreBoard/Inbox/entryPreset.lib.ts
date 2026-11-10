import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { BoardMoveBody } from '@agentdeck/contracts/core/panel-api';
import { boardMoveBody } from '@entities/CoreTask';

/**
 * Смена пресета записи до старта (W2-D, P164): ход доски `set-preset`. Выбор — пресеты, которыми
 * человек запускает запись с полями; ответы ревьюерам, чат, вопрос модели и ревью по ссылке
 * открывают свои дороги, не доска. Можно ли и годна ли предпосылка — решает ядро (отказ 409 с
 * причиной); окно не угадывает.
 */

export const ENTRY_PRESETS = [
  'feature',
  'bug-fix',
  'refactor',
  'review-only',
  'tracker-ticket',
  'lead',
] as const;

/** Выбор виден ровно у записи, которой ядро разрешило ход `set-preset` (`card.moves`). */
export function canSetPreset(card: Pick<BoardCard, 'kind' | 'moves'>): boolean {
  return card.kind === 'entry' && card.moves.includes('set-preset');
}

/**
 * Варианты выбора: пресеты доски и — первым — нынешний пресет записи, если его нет в списке
 * (сценарий библиотеки, ревью по ссылке): выбор показывает правду, а не первый попавшийся.
 */
export function presetChoices(current: string | undefined): string[] {
  const all: string[] = [...ENTRY_PRESETS];
  return current && !all.includes(current) ? [current, ...all] : all;
}

/** Тело хода: тот же `boardMoveBody` доски плюс новый пресет. */
export function setPresetBody(
  entryId: string,
  preset: string,
  proof: { nonce: string; page: string },
  cmdId?: string,
): BoardMoveBody {
  return { ...boardMoveBody({ entryId, to: 'set-preset' }, proof, cmdId), preset };
}

/**
 * Отказ смены пресета для человека: ключ строки `coreInbox.entryPreset.refusals.*`, значения в неё
 * и проза ядра как есть — английская по контракту (`moves.ts` `presetChangeProblems`), поэтому
 * только подсказкой. Незнакомая причина — общее «ядро отказало», ответа нет — «ядро не ответило».
 */
export interface PresetRefusal {
  key: string;
  values: Record<string, string>;
  raw: string;
}

const REFUSAL_RULES: ReadonlyArray<
  readonly [RegExp, string, (m: RegExpMatchArray) => Record<string, string>]
> = [
  [/the ask preset is created only by its own route/, 'ask', () => ({})],
  [
    /runs library scenario (\S+); change it in the launch form/,
    'library',
    (m) => ({ id: m[1] ?? '' }),
  ],
  [/a chat is not a board task/, 'chat', () => ({})],
  [/answer-reviewers tasks are opened by the forge poll/, 'answerReviewers', () => ({})],
  [/unknown preset (\S+)/, 'unknownPreset', (m) => ({ preset: m[1] ?? '' })],
  [/a link launch needs the \S+ preset/, 'linkNeedsReview', () => ({})],
  [/preset starts from a link launch/, 'reviewNeedsLink', () => ({})],
  [/group items and other sources in one estimate/, 'groupMixed', () => ({})],
  [/needs a tracker snapshot/, 'trackerSnapshot', () => ({})],
  [/^move set-preset is not allowed from/, 'notAllowed', () => ({})],
  [/^no board entry /, 'gone', () => ({})],
];

export function presetRefusalOf(error: unknown): PresetRefusal {
  const response = (error as { response?: { data?: unknown } } | null)?.response;
  const data = (response?.data ?? {}) as { reason?: unknown; error?: unknown };
  const raw =
    [data.reason, data.error].find((v): v is string => typeof v === 'string' && v !== '') ??
    (error instanceof Error ? error.message : String(error));
  if (!response) return { key: 'noAnswer', values: {}, raw };
  for (const [re, key, values] of REFUSAL_RULES) {
    const m = raw.match(re);
    if (m) return { key, values: values(m), raw };
  }
  return { key: 'generic', values: {}, raw };
}
