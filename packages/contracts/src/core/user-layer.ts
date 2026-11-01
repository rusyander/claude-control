import { z } from 'zod';
import type { GRANT_OPS } from './journal-data.ts';

/**
 * Слой пользователя в сеансе ядра (06 §User layer, 03 §Layer control, фаза 7): метка платформы,
 * опись слоя, отчёт экрана запуска, наблюдения `observe`, документ `agentdeck state`. Чистые типы
 * и схемы — опись читает переходник, решение «с каким слоем пошёл сеанс» — один судья
 * (`LayerRunDecision`, класс `layer-run`).
 */

/**
 * Первая строка КАЖДОГО текста, который ядро пишет в сессию (06:119, P37, G2): хук человека
 * отличает голос платформы от человека. ASCII, строки — только LF.
 */
export const PLATFORM_MARKER = '<!-- agentdeck:platform -->';
/** Вторая строка, когда ядро передаёт слова человека (сообщение шагу, поздний ответ). */
export const FROM_HUMAN_LINE = 'agentdeck-from: human';
export const SEND_ORIGINS = ['platform', 'human'] as const;
export type SendOrigin = (typeof SEND_ORIGINS)[number];

/** Режим хуков человека: `observe` — хук исполняется, вердикт снимается и записывается (G7). */
export const HOOK_MODES = ['on', 'observe', 'off'] as const;
export type HookMode = (typeof HOOK_MODES)[number];
export const SKILL_MODES = ['on', 'off'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const LAYER_SOURCE_KINDS = [
  'settings',
  'instructions',
  'rules',
  'skill',
  'hook',
  'agent',
] as const;
export const LAYER_SCOPES = ['user', 'project', 'local'] as const;

/** `agentdeck.steps` во frontmatter навыка (02:33) → подшаги `within` шага, который его зовёт. */
export const skillFlowSchema = z.strictObject({
  steps: z
    .array(z.strictObject({ id: z.string().min(1).max(60), title: z.string().min(1).max(200) }))
    .min(1)
    .max(20),
});
export type SkillFlow = z.infer<typeof skillFlowSchema>;

export interface UserLayerInventory {
  /** Переходник (имя из реестра). */
  cli: string;
  /** sha256 по отсортированному списку (путь, sha256 | `unread:<причина>`) + канонический JSON настроек (01:18). */
  hash: string;
  sources: {
    kind: (typeof LAYER_SOURCE_KINDS)[number];
    scope: (typeof LAYER_SCOPES)[number];
    path: string;
    sha256: string;
    bytes: number;
  }[];
  hooks: {
    key: string;
    event: string;
    matcher: string | null;
    command: string;
    sourcePath: string;
  }[];
  skills: { name: string; path: string; flow: SkillFlow | null; extraKeys: string[] }[];
  /** Определения подагентов: `model` `null` — наследует (не выше модели сеанса). */
  agents: { name: string; model: string | null; path: string }[];
  /** Ничего не пропускается молча (F25): непрочитанный файл назван и входит в хеш как непрочитанный. */
  unread: { path: string; reason: string }[];
}

export const LINT_RULES = [
  'push',
  'mr',
  'ci-wait',
  'whole-suite',
  'merge',
  'approve',
  'frontmatter-key',
] as const;
export type LintRule = (typeof LINT_RULES)[number];

export interface LaunchLintWarning {
  rule: LintRule;
  /** Путь файла слоя. */
  source: string;
  line: number;
  /** ≤ 200 символов, маскировано DLP. */
  text: string;
  /** Что ядро делает вместо этого (en); панель показывает ru/en по id правила. */
  instead: string;
}

/** Что показывает экран запуска (07:23-24): поле `EstimateReply.userLayer`. */
export interface UserLayerReport {
  /** `null` — опись неизвестна (причина в `detail`). */
  hash: string | null;
  asked: { hooks: HookMode; skills: SkillMode };
  ran: { hooks: HookMode; skills: SkillMode };
  /** Каждая подмена названа: «qwen: no layer control → on», «observe: user skills not re-supplied». */
  detail: string[];
  warnings: LaunchLintWarning[];
  sources: number;
}

/** Строка подтверждения гранта на экране запуска (06:108-112). */
export interface GrantConfirmation {
  repoKey: string;
  globs: string[];
  ops: (typeof GRANT_OPS)[number][];
  matchedOwnedPaths: string[];
}

/** Наблюдение режима `observe` по хуку за сессию (P87): вызовы, «отказал бы», сбои. */
export const hookObservationSchema = z.strictObject({
  /** Ключ хука из описи. */
  hook: z.string().min(1).max(500),
  event: z.string().min(1).max(100),
  calls: z.number().int().nonnegative(),
  /** Команда хука отказала, запись пропустила. */
  wouldBlock: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});
export type HookObservation = z.infer<typeof hookObservationSchema>;
/** Предел строк наблюдений в одной строке журнала `layer.observed`. */
export const HOOK_OBSERVATIONS_MAX = 200;

/** `agentdeck state` (03:82) — для авторов хуков: только чтение, без секретов. */
export const SESSION_STATE_V = 1;
export interface SessionStateDoc {
  v: typeof SESSION_STATE_V;
  /** `snapshot` — файл запуска: ядро недоступно, данные на момент старта сессии. */
  source: 'core' | 'snapshot';
  /** seq журнала, по которому собран документ. */
  asOf: number;
  task: string;
  step: { id: string; kind: string; title: string; defId: string };
  requirements: { id: string; text: string; verdict: string | null }[];
  ownedPaths: string[];
  requiredChecks: string[];
  budgets: {
    tokens: { spent: number; limit: number | null };
    minutes: { spent: number; limit: number | null };
  };
  ciWait: boolean;
  layer: { hooks: HookMode; skills: SkillMode };
}

/** Сигналы этапа (вид `signal` — свободная строка; список — для шаблонов панели). */
export const USER_LAYER_SIGNALS = ['hook-block', 'hook-loop', 'layer-loss'] as const;
export type UserLayerSignal = (typeof USER_LAYER_SIGNALS)[number];

/**
 * Класс решений `layer-run` (`decisions.ts`): с каким слоем сеанс пошёл на деле. Входы — режимы,
 * которые просили, возможности переходника, доверие к исходному репозиторию, хеш описи. CLI без
 * управления слоем идёт `on`, и это названо (06:117, G3).
 */
export interface LayerRunDecision {
  asked: { hooks: HookMode; skills: SkillMode };
  ran: { hooks: HookMode; skills: SkillMode };
  /** Настройки репозитория дошли до сеанса; `false` — только его `deny`, данными ядра. */
  repoLayer: boolean;
  trust: 'panel' | 'cli' | 'none' | 'unknown';
  /** Хеш описи слоя; `null` — опись не прочитана. */
  inventoryHash: string | null;
  /** Каждая подмена и потеря названа (G-b: потеря видна и в журнале, не молча). */
  detail: string[];
}
