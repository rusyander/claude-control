import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Aider.
 *
 * Инструкции у Aider — СПИСОК ССЫЛОК (ключ `read` в `~/.aider.conf.yml`), а не
 * файл: панель кладёт свой файл рядом с конфигом и добавляет ссылку на него.
 * Чужие записи списка остаются на месте — их ведёт человек, и перенос их не
 * трогает.
 */
export const emitToAider: Emitter = (env, deps) => emitUniversalSections(env, deps);
