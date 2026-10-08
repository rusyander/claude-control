import type { RowText } from './describe.types';

/**
 * Сводка ресурса проекта спрашивается в его проекте: у одноимённого общего
 * ресурса — другой файл, а кэш запросов без проекта делил бы описание на все группы.
 */
export function inProject(text: RowText, project: string | undefined): RowText {
  return text.kind === 'summary' && project ? { ...text, project } : text;
}
