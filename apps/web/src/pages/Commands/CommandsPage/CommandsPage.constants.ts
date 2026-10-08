import type { CommandFilter } from '@entities/Command';

/** Порядок кнопок фильтра по источнику команды. */
export const FILTERS: CommandFilter[] = ['all', 'skill', 'command', 'plugin', 'builtin'];
