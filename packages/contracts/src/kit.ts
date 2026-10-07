import { boolean, object, string, enum as zodEnum } from 'zod';
import type { DiffLine } from './history.ts';
import { kitModeSchema, type KitMode } from './local-models.ts';

/**
 * Встроенный набор панели (В2): навыки, команды-пайплайны, правила и хуки,
 * которые едут с приложением и подключаются к агенту слоем запуска.
 */

export const kitItemKinds = ['skill', 'command', 'agent', 'rule', 'hook'] as const;
export type KitItemKind = (typeof kitItemKinds)[number];

/** Виды, у которых есть одноимённый двойник в глобальном слое человека. */
export const kitTwinKinds = ['skill', 'command', 'agent'] as const;
export type KitTwinKind = (typeof kitTwinKinds)[number];

/**
 * `builtin` — как в приложении; `modified` — поверх него лежит копия «моё»;
 * `added` — встроенного нет, элемент взят человеком из глобального слоя.
 */
export type KitItemOrigin = 'builtin' | 'modified' | 'added';

export interface KitItem {
  /** Путь файла внутри набора (`skills/read-before-edit/SKILL.md`) — он же ключ. */
  id: string;
  kind: KitItemKind;
  name: string;
  description: string;
  origin: KitItemOrigin;
  enabled: boolean;
  /**
   * У человека в `~/.claude` есть навык, команда или субагент с тем же именем. В
   * гибриде побеждает выбранная сторона; по умолчанию — пользовательская.
   */
  conflict?: {
    userPath: string;
    winner: 'user' | 'kit';
    /** Текст набора и глобальный совпадают (без учёта концов строк и хвостовых пробелов). */
    same: boolean;
  };
}

/** Почему провайдер не получает набор — код для словаря, не текст. */
export type KitUnsupportedReason = 'no-run-layer' | 'not-installed';

export interface KitProviderView {
  id: string;
  title: string;
  mode: KitMode;
  /** Режимы, которые этот CLI умеет; пусто — набор к нему не доезжает. */
  modes: KitMode[];
  reason?: KitUnsupportedReason;
  /** Режим действует только на контуре локальной модели (Qwen Code «Наши»). */
  localOnly?: boolean;
  /** Что из набора доезжает до CLI; нет поля — всё. У Codex — правила и навыки. */
  carries?: KitItemKind[];
}

/** Навык, команда или субагент, который есть только в глобальном слое. */
export interface KitGlobalItem {
  kind: KitTwinKind;
  name: string;
  path: string;
  description: string;
}

export interface KitResponse {
  version: string;
  items: KitItem[];
  providers: KitProviderView[];
  /** Где лежат копии «моё» — их правит и агент по кнопке «Улучшить». */
  mineDir: string;
  builtinDir: string;
  /** Глобальный слой Claude Code, с которым идёт сверка. */
  globalDir: string;
  globalOnly: KitGlobalItem[];
}

export interface KitItemContent {
  id: string;
  builtin: string;
  /** Копия «моё»; нет — `null`. */
  mine: string | null;
  /** Одноимённый глобальный файл; нет — `null`. */
  global: string | null;
  /** Построчная разница «глобальный → набор»; нет двойника или текст слишком велик — `null`. */
  diff: DiffLine[] | null;
}

const kitIdSchema = string().min(1).max(300);

export const kitModeBodySchema = object({ provider: string().min(1).max(40), mode: kitModeSchema });
export const kitItemWriteSchema = object({ id: kitIdSchema, content: string().max(200_000) });
export const kitItemEnabledSchema = object({ id: kitIdSchema, enabled: boolean() });
export const kitConflictSchema = object({ id: kitIdSchema, winner: zodEnum(['user', 'kit']) });
export const kitGlobalExportSchema = object({ id: kitIdSchema });
export const kitGlobalImportSchema = object({
  kind: zodEnum(kitTwinKinds),
  name: string()
    .min(1)
    .max(120)
    .regex(/^[\p{L}\p{N}_.-]+$/u),
});
