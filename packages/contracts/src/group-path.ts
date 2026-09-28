import { object, string, array, boolean, number, enum as zodEnum, type infer as Infer } from 'zod';
import { CASCADE_STAGES, type CascadeStage } from './model-cascade.ts';
import type { AgentImage } from './agent-images.ts';

/**
 * «Путь» группы — порядок работы над задачей как список шагов.
 *
 * Встроенные стадии конвейера (разбор, план, работа, ревью, правки, доставка)
 * НЕ хранятся: они выводятся из `CASCADE_STAGES` при чтении, иначе у каждой
 * группы лежала бы своя копия списка, которая расходится с кодом при первой же
 * новой стадии. Хранятся только свои шаги человека, каждый привязан к стадии,
 * ПОСЛЕ которой он идёт (`anchor`), и порядком внутри неё (`order`).
 *
 * Шаг двуязычный: человек правит одну сторону, ассистент переводит вторую, а
 * прогон читает только `prompt.en` — модели инструкции даются по-английски.
 */

/** После каких стадий можно вставить свой шаг. `push` — ручной клик, после него пути нет. */
export const PATH_ANCHORS = CASCADE_STAGES.filter(
  (stage): stage is Exclude<CascadeStage, 'push'> => stage !== 'push',
);
export type PathAnchor = (typeof PATH_ANCHORS)[number];
export const pathAnchorSchema = zodEnum(PATH_ANCHORS as unknown as [PathAnchor, ...PathAnchor[]]);

export const pathLangSchema = zodEnum(['ru', 'en']);
export type PathLang = Infer<typeof pathLangSchema>;

/** Текст на двух языках. Пустая сторона — ещё не переведено. */
export const localizedTextSchema = object({
  ru: string().default(''),
  en: string().default(''),
});
export type LocalizedText = Infer<typeof localizedTextSchema>;

/** Чем может стать шаг, когда его «повысили» до настоящей сущности конфига. */
export const pathResourceTypeSchema = zodEnum(['skill', 'hook', 'rule', 'script']);
export type PathResourceType = Infer<typeof pathResourceTypeSchema>;

const MAX_STEP_TEXT = 8_000;
const MAX_STEP_TITLE = 200;

/**
 * Место шага ВНУТРИ пронумерованного порядка скилла-участника: «после его
 * шага N». Такой шаг не отдельный ход после стадии — скилл идёт одним ходом,
 * — а строка в дописке прогона: «применяя скилл X, сразу после его шага …».
 * Шаг скилла узнаётся по заголовку (`after`), номер (`index`) — запасной путь,
 * если заголовок переименовали; `index: -1` и пустой `after` — до первого шага.
 */
export const pathWithinSchema = object({
  skillId: string().min(1),
  index: number().int().min(-1),
  after: string().max(MAX_STEP_TITLE).default(''),
});
export type PathWithin = Infer<typeof pathWithinSchema>;

export const pathStepSchema = object({
  id: string().min(1),
  anchor: pathAnchorSchema,
  order: number().int().nonnegative(),
  /** Шаг внутри порядка скилла (стадия тогда — `work`, где идут шаги скиллов). */
  within: pathWithinSchema.optional(),
  /**
   * `prompt` — шаг — это текст, который панель отдаёт модели ходом после стадии.
   * `resource` — шаг стал скиллом/хуком/правилом, и ход только велит его
   * применить (правило и хук действуют и так — как участники группы).
   */
  kind: zodEnum(['prompt', 'resource']),
  title: localizedTextSchema,
  prompt: localizedTextSchema,
  /** Какую сторону человек правил последней — от неё переводится вторая. */
  source: pathLangSchema,
  resource: object({ type: pathResourceTypeSchema, id: string().min(1) }).optional(),
  /** Чем шаг считается закрытым; пусто — шаг без проверки. */
  gate: localizedTextSchema.optional(),
  /**
   * Шаг перенесён из старого «Порядка работы» (`scenario.steps`): текст один на
   * обе стороны, и перевода ещё не было. Карточка просит перевести.
   */
  needsTranslation: boolean().optional(),
  createdAt: string(),
});
export type PathStep = Infer<typeof pathStepSchema>;

export const groupPathSchema = object({
  steps: array(pathStepSchema).default([]),
});
export type GroupPath = Infer<typeof groupPathSchema>;

/** Проверка длины шага при сохранении: список уезжает в прогон ЗАДАНИЕМ. */
export function pathStepTooLong(step: PathStep): boolean {
  const texts = [step.prompt.ru, step.prompt.en, step.gate?.ru ?? '', step.gate?.en ?? ''];
  return (
    texts.some((text) => text.length > MAX_STEP_TEXT) ||
    step.title.ru.length > MAX_STEP_TITLE ||
    step.title.en.length > MAX_STEP_TITLE
  );
}

/**
 * Строка собранного пути — то, что рисует вкладка «Путь» и по чему идёт
 * конвейер. Собирает сервер (`buildPath`), клиент порядок не пересчитывает.
 */
export type PathEntry =
  /** Встроенная стадия конвейера: серая, «встроенный», не правится. */
  | { kind: 'builtin'; stage: PathAnchor }
  /**
   * Шаг из пронумерованного порядка скилла-участника (как у ticket-delivery):
   * выводится из текста скилла при чтении, только для показа.
   */
  | { kind: 'skill-step'; skillId: string; index: number; title: string }
  /** Свой шаг человека. */
  | { kind: 'custom'; step: PathStep };

export interface GroupPathView {
  groupId: string;
  entries: PathEntry[];
  /**
   * Скиллы-участники, чей текст есть, но не прочёлся (файл занят, нет прав):
   * их шагов в `entries` нет. Без этого поля группа молча показывала одни стадии.
   */
  unreadable?: string[];
}

/** Правка списка своих шагов одним запросом: вставка, перенос, правка, удаление. */
export const pathStepsEditSchema = object({
  steps: array(pathStepSchema),
});
export type PathStepsEdit = Infer<typeof pathStepsEditSchema>;

/**
 * Перенос старого «Порядка работы» в путь. Шаги сценария становятся своими
 * шагами после `work` (там они и действовали — подсказкой по ходу работы), текст
 * один на обе стороны, с меткой «нужен перевод».
 */
export function migrateScenarioSteps(
  scenario: { steps: { title: string; body: string; gate: string }[] } | undefined,
  now: string,
  makeId: (index: number) => string,
): PathStep[] {
  if (!scenario) return [];
  return scenario.steps
    .filter((step) => step.title.trim() || step.body.trim())
    .map((step, index) => {
      const gate = step.gate.trim();
      return {
        id: makeId(index),
        anchor: 'work' as const,
        order: index,
        kind: 'prompt' as const,
        title: { ru: step.title, en: step.title },
        prompt: { ru: step.body, en: step.body },
        source: 'ru' as const,
        ...(gate ? { gate: { ru: gate, en: gate } } : {}),
        needsTranslation: true,
        createdAt: now,
      };
    });
}

/**
 * Ответ ассистента шага (кнопка «Принять»). Блок в ответе модели; панель
 * показывает вопросы и похожие ресурсы, пока человек не подтвердит.
 */
export const PATH_STEP_BLOCK_KIND = 'path-step';

export const pathStepProposalSchema = object({
  /** Уже есть ресурс, который делает ровно это. */
  match: object({ type: pathResourceTypeSchema, id: string(), why: string() }).optional(),
  /** Похожие ресурсы: «есть похожий скилл X, делает Y». */
  similar: array(object({ type: pathResourceTypeSchema, id: string(), why: string() })).default([]),
  questions: array(string()).default([]),
  title: localizedTextSchema,
  prompt: localizedTextSchema,
  gate: localizedTextSchema.optional(),
  /** Предложение сделать шаг глобальным ресурсом; черновик — текст файла. */
  promote: object({ type: pathResourceTypeSchema, draft: string() }).optional(),
});
export type PathStepProposal = Infer<typeof pathStepProposalSchema>;

/** Запрос к ассистенту шага. `translate` — только перевод второй стороны. */
export const pathStepDraftRequestSchema = object({
  mode: zodEnum(['author', 'translate']).default('author'),
  /** Сырой текст человека (author) или правленая сторона (translate). */
  text: string().min(1).max(MAX_STEP_TEXT),
  lang: pathLangSchema.default('ru'),
  anchor: pathAnchorSchema,
  /** Шаг встаёт внутрь порядка скилла — ассистенту это место называется. */
  within: pathWithinSchema.optional(),
  /** Шаг, который правится; нет — новый. */
  stepId: string().optional(),
  /** Ответ человека на вопросы ассистента — следующий круг того же разговора. */
  conversationId: string().optional(),
  /**
   * Шаг, как он сейчас в окне (обе стороны), — для `translate`. Без него
   * переводчик видел только текст промпта: правка названия или условия
   * готовности не доходила до второй стороны, а сохранённый шаг подсовывал
   * модели старую версию.
   */
  current: object({
    title: localizedTextSchema,
    prompt: localizedTextSchema,
    gate: localizedTextSchema.optional(),
  }).optional(),
});
export type PathStepDraftRequest = Infer<typeof pathStepDraftRequestSchema>;

/**
 * Тело запроса ассистенту шага: картинки идут рядом со схемой — их проверяет
 * сервер общей проверкой (`readAgentImages`), с именем файла в отказе.
 */
export type PathStepDraftBody = PathStepDraftRequest & { images?: AgentImage[] };

/**
 * Сводка ресурса «что делает / как работает» на двух языках. Кэш по хэшу
 * содержимого в каталоге данных панели: повторный показ бесплатный, пока файл
 * не менялся.
 */
export const resourceSummarySchema = object({
  hash: string(),
  ru: string(),
  en: string(),
});
export type ResourceSummary = Infer<typeof resourceSummarySchema>;

/** Ответ ассистента шага: разговор продолжается тем же `conversationId`. */
export interface PathStepDraftResult {
  conversationId: string;
  proposal: PathStepProposal;
}

/** «Сделать глобальным»: шаг становится ресурсом через обычные писатели сущностей. */
export const pathPromoteRequestSchema = object({
  stepId: string().min(1),
  type: pathResourceTypeSchema,
  /**
   * Текст будущего файла: тело скилла или правила. У хука — JSON
   * `{event, matcher?, command}`: у хука нет «текста», есть запись настроек.
   */
  draft: string().min(1).max(64_000),
});
export type PathPromoteRequest = Infer<typeof pathPromoteRequestSchema>;
