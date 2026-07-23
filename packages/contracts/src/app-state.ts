import { object, string, array, record, type infer as Infer } from 'zod';
import { groupSchema, automationSchema } from './groups';
import { hookSchema } from './hooks';
import { projectSchema } from './projects';
import { appSettingsSchema } from './app-settings';

/**
 * Схема состояния панели (`state.json`) для проверки импорта.
 *
 * `POST /api/settings/import` принимает снимок чужой машины и раньше доверял ему
 * без проверки: испорченный или подсунутый файл оседал в `state.json` как есть.
 * Схема ловит структурный мусор (тело не объект, `groups` не массив, кривые
 * настройки) ДО записи, а неизвестные поля отбрасывает, чтобы не засорять файл.
 *
 * Все поля необязательны намеренно: `importState` сливает импорт с дефолтами,
 * поэтому неполный или снятый со старой версии снимок — норма, а не ошибка.
 * Поля дублируют `AppState` сервера; расходиться им нельзя.
 */
export const importStateSchema = object({
  groups: array(groupSchema).optional(),
  automations: array(automationSchema).optional(),
  /** Вид сущности → идентификаторы выключенных вручную. */
  disabled: record(string(), array(string())).optional(),
  /** Вид → id сущности → группы, которые её гасят. */
  disabledByGroup: record(string(), record(string(), array(string()))).optional(),
  /** Снимки выключенных хуков (их текст живёт только здесь). */
  disabledHooks: record(string(), hookSchema).optional(),
  /** id группы → имена env-ключей, записанных ею в settings.json. */
  envByGroup: record(string(), array(string())).optional(),
  /** Реестр проектов уровня конфигурации — запомненные пути к их каталогам. */
  projects: array(projectSchema).optional(),
  /** Настройки самого приложения — проверяются контрактной схемой настроек. */
  settings: appSettingsSchema.partial().optional(),
});

export type ImportState = Infer<typeof importStateSchema>;
