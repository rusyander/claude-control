import { enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Из какого файла настроек прочитана запись.
 *
 * Claude Code читает `settings.json` и `settings.local.json` одинаково — но
 * второй личный: он не переносится между машинами и обычно не коммитится.
 * Панель показывает его записи, потому что иначе картина «что сейчас
 * действует» была бы неполной, и помечает их только на чтение: переписывать
 * чужой личный файл своим форматом она не берётся.
 */
export const settingsSourceSchema = zodEnum(['settings', 'settings-local']);

export type SettingsSource = Infer<typeof settingsSourceSchema>;

/** Префикс идентификатора у записей из локального файла. */
export const LOCAL_ID_PREFIX = 'local:';

/**
 * Идентификаторы хуков и прав позиционные (событие плюс индексы, решение плюс
 * паттерн), поэтому в двух файлах они совпадают. Без префикса правка хука из
 * основного файла попадала бы в одноимённый локальный.
 */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}
