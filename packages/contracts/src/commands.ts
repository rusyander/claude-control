import { object, string, array, boolean, enum as enumOf, type infer as Infer } from 'zod';

/**
 * Слэш-команды — то, что появляется в палитре по нажатию `/`.
 *
 * Они не лежат в одном месте: часть даёт сам CLI (встроенные), часть — скиллы
 * пользователя, часть — файлы команд, часть — установленные плагины. Раздел
 * сводит их в один список: что это, что делает, кому принадлежит и куда идти
 * править. Он ЧИТАЮЩИЙ: сама команда правится там, где живёт (скилл — в разделе
 * скиллов, плагин — в разделе плагинов).
 */

/**
 * Откуда команда взялась:
 * - `builtin` — встроена в CLI (включая «bundled skills» — они тоже приходят с
 *   CLI, а не из файлов пользователя). Файла на диске нет, править нечего;
 * - `skill` — скилл пользователя (`SKILL.md`), вызывается как `/имя`;
 * - `command` — файл команды (`commands/имя.md`, у других CLI — свой формат);
 * - `plugin` — команда или скилл установленного плагина, вызывается с префиксом
 *   плагина.
 */
export const commandSourceSchema = enumOf(['builtin', 'skill', 'command', 'plugin']);

/**
 * Куда ведёт кнопка «Открыть». Не у всякой команды есть страница: у встроенной
 * править нечего, у файла чужого CLI своей страницы в панели пока нет — тогда
 * показываем путь, а не ведём в никуда.
 */
export const commandTargetSchema = enumOf(['skill', 'plugin', 'none']);

export const slashCommandSchema = object({
  /** Уникален в пределах списка: источник + вызов (`skill:/deep-review`). */
  id: string(),
  /** Как её набирают: `/deep-review`, `/commit-commands:commit`. */
  invocation: string(),
  /** Имя без слэша и без префикса плагина — по нему считаются семьи команд. */
  name: string(),
  source: commandSourceSchema,
  /** Что делает. У скиллов и плагинов — текст автора, панель его не переводит. */
  description: string(),
  /**
   * Кому принадлежит: имя плагина, «скилл», имя CLI. Показывается в карточке,
   * по нему же группируются команды одного владельца.
   */
  owner: string().optional(),
  /** Абсолютный путь файла — чтобы было видно, откуда взялось. */
  path: string().optional(),
  /**
   * Выключенное показываем, а не прячем: команда исчезла из палитры не потому,
   * что её нет, а потому что скилл или плагин выключен — это и надо увидеть.
   */
  isEnabled: boolean(),
  /** Подсказка по аргументам из шапки файла (`argument-hint`). */
  argumentHint: string().optional(),
  /** Другие имена той же команды (`/cost` = `/usage`). */
  aliases: array(string()).default([]),
  /** Команды, на которые ссылается её описание, — «см. также». */
  related: array(string()).default([]),
  target: commandTargetSchema,
  /** Идентификатор для перехода: имя скилла, `имя@маркетплейс` у плагина. */
  targetId: string().optional(),
});

export type SlashCommand = Infer<typeof slashCommandSchema>;

/**
 * Ответ `GET /api/commands` — команды АКТИВНОГО провайдера, собранные с диска.
 * Встроенные сюда не входят: их каталог ведёт панель на клиенте (CLI списка
 * своих команд наружу не отдаёт).
 */
export const commandsResponseSchema = object({
  provider: string(),
  commands: array(slashCommandSchema),
  /**
   * Что не прочиталось и почему — например, каталог команд отсутствует. Пустые
   * места лучше назвать, чем показать пустой список без объяснения.
   */
  notes: array(string()).default([]),
});

export type CommandsResponse = Infer<typeof commandsResponseSchema>;
