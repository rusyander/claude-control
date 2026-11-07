import { z } from 'zod';
import { sha256Hex, uuidv7 } from './ids.ts';

/**
 * Приём задачи ведущим (этап 11, P133-P134): из чего задача пришла и что ведущий из этого понял.
 * Источник — снимок, а не ссылка: трекер читает панель, ядро получает текст, поля и отпечаток и
 * больше в трекер не ходит. Текст снимка — данные: ни настройку, ни права, ни правила публикации
 * он не меняет. Карточка — понятое: цель, критерии приёмки (строки `requirement.extracted`, одна
 * нумерация), область, ограничения и не больше четырёх развилок, каждая с рекомендацией.
 */

const line = (max: number) => z.string().min(1).max(max);
const nonNeg = z.number().int().nonnegative();

export const INTAKE_SOURCE_KINDS = ['tracker', 'text', 'voice', 'group-item'] as const;
export type IntakeSourceKind = (typeof INTAKE_SOURCE_KINDS)[number];

/** Тело снимка — как запрос оценки (`estimateFieldsSchema.request`). */
export const INTAKE_BODY_MAX = 64_000;
/** Развилок на приёме не больше: больше — задача не понята, а не «вопросов много» (P133). */
export const INTAKE_UNKNOWNS_MAX = 4;
/** Пунктов источника в одной оценке (`estimateFieldsSchema.sources`) не больше. */
export const INTAKE_SOURCES_MAX = 16;

/** Критерии приёмки списком приходят только из полей трекера или пункта группы, не из прозы. */
const STRUCTURED_AC_KINDS: ReadonlySet<IntakeSourceKind> = new Set(['tracker', 'group-item']);

export const intakeSourceSchema = z
  .strictObject({
    kind: z.enum(INTAKE_SOURCE_KINDS),
    /** Ключ задачи трекера (`PROJ-12`) или пункта группы; у трекера обязателен. */
    key: line(200).optional(),
    title: line(300).optional(),
    body: z.string().max(INTAKE_BODY_MAX),
    /** Поля трекера как есть (статус, метки, приоритет): данные, не команды. */
    fields: z.record(line(100), z.json()).optional(),
    /** Структурные критерии приёмки трекера или пункта группы; критерии из прозы — вывод модели. */
    acceptance: z.array(line(2000)).min(1).max(100).optional(),
    links: z
      .array(z.strictObject({ url: line(2000), title: line(300).optional() }))
      .max(50)
      .optional(),
    /** Когда снимок снят (стена, мс). */
    fetchedAt: nonNeg,
    /** sha256 снимка: тот же отпечаток — тот же источник, повтор приёма не нужен. */
    digest: sha256Hex,
  })
  .superRefine((source, ctx) => {
    if (source.kind === 'tracker' && source.key === undefined)
      ctx.addIssue({ code: 'custom', path: ['key'], message: 'tracker source needs a key' });
    if (source.acceptance !== undefined && !STRUCTURED_AC_KINDS.has(source.kind))
      ctx.addIssue({
        code: 'custom',
        path: ['acceptance'],
        message: `structured acceptance comes only from tracker or group-item, not ${source.kind}`,
      });
  });
export type IntakeSource = z.infer<typeof intakeSourceSchema>;

/** Откуда критерий: поле трекера, проза запроса (модель) или правка человека. */
export const ACCEPTANCE_FROM = ['structured', 'prose', 'human'] as const;
export type AcceptanceFrom = (typeof ACCEPTANCE_FROM)[number];

const unknownSchema = z
  .strictObject({
    question: line(1000),
    recommendation: line(300),
    options: z.array(line(300)).min(2).max(8),
  })
  .refine((u) => u.options.includes(u.recommendation), {
    path: ['recommendation'],
    message: 'recommendation must be one of the options',
  });

export const intakeCardSchema = z.strictObject({
  goal: line(2000),
  /** `requirementId` — id строки `requirement.extracted`: второго списка критериев нет (P134). */
  acceptance: z
    .array(
      z.strictObject({ requirementId: uuidv7, text: line(2000), from: z.enum(ACCEPTANCE_FROM) }),
    )
    .max(100),
  area: z.strictObject({
    paths: z.array(line(500)).max(200),
    units: z.array(line(200)).max(20),
  }),
  constraints: z.array(line(1000)).max(50),
  unknowns: z.array(unknownSchema).max(INTAKE_UNKNOWNS_MAX),
  /** Отпечаток источника (одного или сводный по нескольким), из которого карточка собрана. */
  sourceDigest: sha256Hex,
});
export type IntakeCard = z.infer<typeof intakeCardSchema>;

/**
 * Варианты ответа на вопрос карточки (W2-6): подписи на языке панели запуска, ядро сверяет ответ
 * с подписями ВСЕХ языков. Здесь, а не в ядре: подтверждение карточек группы с экрана запуска
 * шлёт ту же подпись, что карточка вопроса в ленте задачи.
 */
export const INTAKE_ANSWERS = {
  ru: { confirm: 'Подтвердить карточку', stop: 'Остановить задачу' },
  en: { confirm: 'Confirm the card', stop: 'Stop the task' },
} as const;
export type IntakeAnswer = keyof (typeof INTAKE_ANSWERS)['ru'];

/**
 * Ключ вопроса карточки задачи (`human.asked.dedupe`, вид `asks[].dedupe`): по нему панель
 * отличает вопрос карточки от вопроса класса того же источника `intake`.
 */
export const intakeDedupe = (taskId: string): string => `intake:${taskId}`;
/** Ключ вопроса класса задачи (`classify` в `lead.alwaysAsk`): ответ — в ленте задачи. */
export const classifyDedupe = (taskId: string): string => `classify:${taskId}`;

/** Исходы класса решений `intake`: карточка принята сама или идёт вопросом человеку. */
export const INTAKE_VERDICTS = ['auto', 'ask'] as const;
export type IntakeVerdict = (typeof INTAKE_VERDICTS)[number];

/**
 * Решение класса `intake` (модуль `conductor/intake`): принять карточку без человека или спросить.
 * Причины — английская проза ядра, по одной на условие, которое решило исход (P133).
 */
export interface IntakeDecision {
  verdict: IntakeVerdict;
  sourceKinds: IntakeSourceKind[];
  /** Сколько критериев пришло структурно; `0` у текста и голоса. */
  structuredAcceptance: number;
  unknowns: number;
  /** `intake` в `lead.alwaysAsk`: принять само нельзя (D25). */
  alwaysAsk: boolean;
  reasons: string[];
}
