import { z } from 'zod';
import { uuidv7 } from './ids.ts';

/**
 * Проход по стенду (этап 12, D23–D24, 08d P177–P180): шаг `walk` водит браузер только
 * инструментами ядра, и каждое действие — строка журнала `browse.step` со смысловой целью (роль и
 * имя, test id, подпись, текст), а не CSS-селектором: из этих строк панель собирает спек
 * Playwright чистой функцией, и тот же спек потом гоняется без модели. Действие, которого ядро не
 * умеет (наведение, перетаскивание, выбор файла), — отказ `unsupported` и строка `browse.gap`:
 * отчёт называет, что осталось непроверенным. Схемы строгие: лишнее поле — отказ разбора.
 */

const line = (max: number) => z.string().min(1).max(max);

/** Действия прохода — ровно то, что умеет спек Playwright из записи (R3). */
export const BROWSE_ACTIONS = [
  'open',
  'click',
  'fill',
  'press',
  'select',
  'expect',
  'snapshot',
] as const;
export type BrowseAction = (typeof BROWSE_ACTIONS)[number];

/** Чего ядро не делает: модель называет — отказ `unsupported` и пробел в отчёте (P177). */
export const BROWSE_GAP_ACTIONS = ['hover', 'drag', 'file-pick', 'other'] as const;
export type BrowseGapAction = (typeof BROWSE_GAP_ACTIONS)[number];

/** Ожидание шага `expect`: видно, скрыто, текст, значение поля, адрес страницы. */
export const BROWSE_EXPECTS = ['visible', 'hidden', 'text', 'value', 'url'] as const;
export type BrowseExpect = (typeof BROWSE_EXPECTS)[number];

/** Отказы инструментов прохода, которые названы в свойствах (P177); прочие — свои коды зоны. */
export const BROWSE_REFUSALS = {
  /** Chromium не установлен: сообщение называет команду установки для этой ОС. */
  noBrowser: 'no-browser',
  /** Наведение, перетаскивание, выбор файла: пробел записан, страница не тронута. */
  unsupported: 'unsupported',
} as const;

/**
 * Смысловая цель — один из четырёх способов, которыми спек ищет элемент (`getByRole`,
 * `getByTestId`, `getByLabel`, `getByText`). CSS-селектора нет намеренно: запись о вёрстке
 * ломается от любой правки стилей, а запись о смысле — только от правки поведения.
 */
export const browseTargetSchema = z.union([
  z.strictObject({ role: line(64), name: line(500) }),
  z.strictObject({ testId: line(200) }),
  z.strictObject({ label: line(500) }),
  z.strictObject({ text: line(500) }),
]);
export type BrowseTarget = z.infer<typeof browseTargetSchema>;

/**
 * Секрет стенда по имени (доступы окружения блока «Тесты»): значение подставляет ядро внутри
 * инструмента, в журнал, ответ модели и снимок оно не попадает (P178).
 */
export const browseSecretSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env name')
    .max(200),
});
export type BrowseSecret = z.infer<typeof browseSecretSchema>;

/**
 * Проверки ядра после каждого действия (P177): ошибки консоли, упавшие запросы своего источника,
 * пустая страница, страница не откликнулась. Счётчики, а не тексты: текст консоли мог бы унести
 * секрет; что именно — `problems`, уже под маской сессии.
 */
export const browseChecksSchema = z.strictObject({
  console: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blank: z.boolean(),
  stale: z.boolean(),
});
export type BrowseChecks = z.infer<typeof browseChecksSchema>;

/**
 * Строка журнала `browse.step`: n — порядок в шаге (с 1), `url` — адрес после действия. У `fill`
 * ровно одно из `value` / `secret`; у `press` `value` — клавиша; у `expect` — `expect` и, кроме
 * `visible` / `hidden`, ожидаемое `value`. Правила пар судит схема инструмента, журнал хранит факт.
 */
export const browseStepSchema = z.strictObject({
  stepId: uuidv7,
  n: z.number().int().positive(),
  action: z.enum(BROWSE_ACTIONS),
  target: browseTargetSchema.optional(),
  value: z.string().max(4000).optional(),
  secret: browseSecretSchema.optional(),
  expect: z.enum(BROWSE_EXPECTS).optional(),
  url: z.string().max(4000),
  checks: browseChecksSchema,
  /** Что нашли проверки — короткими строками под маской сессии; нет — нечего назвать. */
  problems: z.array(z.string().max(500)).max(20).optional(),
  ok: z.boolean(),
});
export type BrowseStep = z.infer<typeof browseStepSchema>;

/** Строка журнала `browse.gap`: действие вне умений ядра и почему оно понадобилось модели. */
export const browseGapSchema = z.strictObject({
  stepId: uuidv7,
  action: z.enum(BROWSE_GAP_ACTIONS),
  target: browseTargetSchema.optional(),
  why: line(2000),
});
export type BrowseGap = z.infer<typeof browseGapSchema>;

/**
 * Ответ `GET /v1/tasks/:id/walk`: строки прохода задачи по порядку журнала — то, из чего панель
 * собирает спек (R3). `ended` — задача кончилась, записи больше не прибудет.
 */
export interface WalkReply {
  taskId: string;
  steps: BrowseStep[];
  gaps: BrowseGap[];
  ended: boolean;
}
