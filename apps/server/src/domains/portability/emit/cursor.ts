import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Cursor CLI.
 *
 * Единственная цель, у которой инструкции — КАТАЛОГ ПРАВИЛ `~/.cursor/rules`, а
 * не файл: каждая запись едет своим `.mdc` с шапкой. Панель этот CLI не
 * запускает (`cliRunnable` не задан), поэтому эмуляции у него не существует
 * вовсе — механизма нет ⇒ запись уходит текстом правила либо не уходит.
 */
export const emitToCursor: Emitter = (env, deps) => emitUniversalSections(env, deps);
