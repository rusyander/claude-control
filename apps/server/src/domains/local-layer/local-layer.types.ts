/**
 * Локальный слой проекта: командный слой (`CLAUDE.md`, `.claude/rules`, хуки
 * `.claude/settings.json`, навыки, MCP из `.mcp.json`), собранный в
 * `<проект>/.agent/local-layer/` и подключённый к чату флагами запуска вместо
 * самого командного слоя (`--setting-sources user,local`).
 *
 * Качество не теряется по построению: каждый командный кусок едет либо дословно,
 * либо сжатым, но только пока сжатие сделано с ТЕКУЩЕЙ версии куска; замена
 * командного хука действует, только пока командный файл тот, что она улучшает.
 */

import type { LocalLayerMode, LocalLayerStatus } from '@agentdeck/contracts';

export type {
  LayerReason,
  LocalLayerMode,
  LocalLayerStatus,
  OverrideState,
  OverrideStatus,
} from '@agentdeck/contracts';

/**
 * Замена командных хуков их версией из коммита (например, ещё не влитого MR).
 * `entries` — скрипты хуков (пути от корня), остальное берётся замыканием их
 * относительных импортов.
 */
export interface LayerOverrideSpec {
  ref: string;
  entries: string[];
  why?: string;
}

/** `layer.json` — единственное, что пишет человек или агент. */
export interface LayerConfig {
  mode: LocalLayerMode;
  overrides: LayerOverrideSpec[];
}

/** Файл инструкций, как его прочёл бы CLI: абсолютный путь и текст без шапки. */
export interface TextEntry {
  path: string;
  text: string;
}

/** Правило по путям: приходит, когда агент впервые трогает подходящий файл. */
export interface PathRule extends TextEntry {
  /** Каталог, от которого считаются шаблоны. */
  base: string;
  globs: string[];
}

export interface TeamLayer {
  root: string;
  /** То, что CLI кладёт в начало сессии: цепочка `CLAUDE.md`, импорты, правила без `paths`. */
  instructions: TextEntry[];
  pathRules: PathRule[];
  settingsPath?: string;
  settings?: Record<string, unknown>;
  /** Каталоги навыков, файлы агентов и команд — абсолютные пути. */
  skills: string[];
  agents: string[];
  commands: string[];
  /** Включённые серверы `.mcp.json` — ровно те, что CLI поднял бы сам. */
  mcp: Record<string, unknown>;
  /** Снятые `claudeMdExcludes` — их нет и в слое. */
  excluded: string[];
}

/** Что прогон получает от слоя. */
export interface LayerRunExtras {
  args: string[];
  append: string;
  settings: Record<string, unknown>;
  status: LocalLayerStatus;
}
