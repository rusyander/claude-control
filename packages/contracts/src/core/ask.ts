import { z } from 'zod';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import { uuidv7 } from './ids.ts';
import { taskEnvNameSchema } from './journal-data.ts';
import { allowedRouteSchema } from './route-schema.ts';
import { sessionCarryShape } from './session-carry.ts';
import {
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_TYPES,
  AGENT_IMAGE_WIRE_MAX_BYTES,
} from '../agent-images.ts';

/**
 * Лёгкая сессия ядра «ask» (этап 10, F2, проход 2c; 00 «единственный запускатель»): один ход модели
 * без репозитория — служебный вопрос панели (группы, ассистент) или ход агента панели. Задача
 * сценария `ask@1`: один шаг чата, который ядро закрывает само на конце первого хода; место —
 * временный каталог ядра, снимаемый на конце задачи; встроенных инструментов нет вовсе.
 *
 * Инструменты панели — ТОЛЬКО известный ядру сервер `panel-bridge` (путь к его скрипту ядро
 * находит само). Вызывающий передаёт лишь адрес панели на loopback и токен этой одной сессии:
 * ни команды, ни своего сервера MCP здесь нет и не будет. Токен живёт в памяти ядра до конца
 * задачи, в журнал и логи не попадает (маска секретов).
 */

export const ASK_PRESET = 'ask';
export const ASK_TOOLS = ['none', 'panel-bridge'] as const;
export type AskTools = (typeof ASK_TOOLS)[number];
/** Имя сервера инструментов панели в сессии: инструменты модели — `mcp__panel-bridge__<действие>`. */
export const PANEL_BRIDGE_SERVER = 'panel-bridge';

const REGISTRY_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Адрес панели — только loopback по http: токен сессии не уходит на чужой хост. */
/**
 * Картинка вопроса: тот же закрытый список типов и пределы, что у полей картинок панели
 * (`agent-images`). Байты сверяются с объявленным типом в ядре до создания задачи.
 */
export const askImageSchema = z.strictObject({
  name: z.string().min(1).max(200),
  mediaType: z.enum(AGENT_IMAGE_TYPES),
  /** base64 без префикса `data:`; предел — по длине строки, как меряет API модели. */
  base64: z
    .string()
    .min(16)
    .max(Math.ceil(AGENT_IMAGE_WIRE_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type AskImage = z.infer<typeof askImageSchema>;
/** Картинка, которую ядро отдаёт CLI вместе с отправкой: файл на диске ядра и его тип. */
export interface SendImage {
  mediaType: AskImage['mediaType'];
  path: string;
}
/** Тело `POST /v1/ask` с картинками больше общего предела API ядра: свой предел маршрута. */
export const ASK_BODY_LIMIT =
  AGENT_IMAGE_MAX_COUNT * (Math.ceil(AGENT_IMAGE_WIRE_MAX_BYTES / 3) * 4 + 512) + 512 * 1024;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/;

/**
 * Набор панели вопросу чужого CLI (этап 10, G13): то, что прежнее окно помощника давало процессу
 * чужого CLI окружением маршрута (`route.kit.env`: дом Qwen набора и т.п.), а набор Codex — текстом.
 * Только два поля из переноса сеанса (`session-carry.ts`): дописка после брифа вопроса и ИМЕНА
 * переменных пина; значения — `askBodySchema.env`, вне полей (журнал их не видит). Ни плагинов, ни
 * сужений, ни argv: слой человека в вопрос не идёт, и набор не открывает его заново.
 */
export const askSessionSchema = z.strictObject({
  append: sessionCarryShape.append,
  env: z.array(taskEnvNameSchema).min(1).max(32).optional(),
});
export type AskSession = z.infer<typeof askSessionSchema>;

export const askFieldsSchema = z
  .strictObject({
    title: z.string().min(1).max(300),
    /** Слово модели первым ходом (вся переписка агента панели — одним текстом, как сейчас). */
    prompt: z.string().min(1).max(256_000),
    /** Системная часть брифа; нет — бриф ядра «ответь на вопрос». */
    system: z.string().min(1).max(64_000).optional(),
    /** CLI, которым идёт ход (`set-cli` задачи); нет — суд маршрута ядра. */
    adapter: z.string().regex(REGISTRY_ID).optional(),
    /** Потребитель контура (`assistant` и т.п.): модель контура для этого потребителя. */
    consumer: z.string().regex(REGISTRY_ID).optional(),
    /**
     * Маршруты, выбранные человеком в панели (профиль агента, группы): тот же суд, что `set-route`
     * (реестр, обязательный контур), — уровень 2. Нет — набор запуска ядра (вход CLI).
     */
    routes: z.array(allowedRouteSchema).min(1).max(16).optional(),
    /** Потолок модели хода (модель профиля); нет — модель CLI по умолчанию. */
    model: z.string().min(1).max(200).optional(),
    tools: z.enum(ASK_TOOLS),
    /**
     * Картинки к слову модели (этап 10, F2, проход 2d): ядро кладёт их файлами в каталог задачи и
     * отдаёт CLI блоками `image` первого хода; CLI без доказанной подачи картинок — отказ дороги.
     */
    images: z.array(askImageSchema).min(1).max(AGENT_IMAGE_MAX_COUNT).optional(),
    /** Набор панели вопросу чужого CLI (G13) — `askSessionSchema`. */
    session: askSessionSchema.optional(),
    panelBridge: z
      .strictObject({
        url: z.string().regex(LOOPBACK_URL),
        /** Токен ЭТОЙ сессии, выданный панелью; ядро кладёт его только в окружение моста. */
        token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
        /** Разговор агента панели: мост называет его панели в каждом вызове. */
        conversation: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,80}$/)
          .optional(),
      })
      .optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.tools === 'panel-bridge') !== (f.panelBridge !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['panelBridge'],
        message: 'panelBridge is required with tools "panel-bridge" and forbidden otherwise',
      });
    }
  });
export type AskFields = z.infer<typeof askFieldsSchema>;

/** Тело `POST /v1/ask`; `proof` — тот же, что у команды и оценки (число загрузки, подпись). */
export const askBodySchema = z.strictObject({
  cmdId: uuidv7,
  fields: askFieldsSchema,
  proof: commandProofSchema,
  /**
   * ЗНАЧЕНИЯ переменных `fields.session.env` (G13), как у оценки: вне `fields`, в журнал не ложатся,
   * живут в книге окружения задачи в памяти ядра до конца вопроса.
   */
  env: z.record(taskEnvNameSchema, z.string().max(32_000)).optional(),
});
export type AskBody = z.infer<typeof askBodySchema>;

/** Ответ: задача хода; ход читается потоком сеанса задачи, как у чата. */
export interface AskReply {
  taskId: string;
  replayed: boolean;
}

/** Что из просьбы ложится в `task.created.ask` — без токена: секрет в журнал не пишется. */
export interface AskJournal {
  tools: AskTools;
  /** Картинки — файлы каталога задачи (без содержимого): имя человека, тип, файл, размер. */
  images?: { name: string; mediaType: AskImage['mediaType']; file: string; bytes: number }[];
  consumer?: string;
  bridge?: { url: string; conversation?: string };
}

export function parseAskBody(
  input: unknown,
): { ok: true; body: AskBody } | { ok: false; issues: CommandIssue[] } {
  const parsed = askBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: commandIssues(parsed.error.issues, '', input) };
  return { ok: true, body: parsed.data };
}
