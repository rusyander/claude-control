import type { SlashCommand } from '@claude-control/contracts';
import { BUILTIN_COMMANDS, type BuiltinCommand } from './builtinCommands';

/**
 * Один список команд из двух половин: прочитанное с диска (скиллы, файлы команд,
 * плагины) и встроенное в CLI (каталог панели). Здесь же — поиск и семьи.
 *
 * Семья — ответ на вопрос «с чем эта команда ходит парой». Считается по двум
 * признакам сразу: общий префикс имени (`/design`, `/design-sync`,
 * `/design-login`) и общий владелец (команды одного плагина). Ничего вести
 * руками не нужно — и врать такой признак не может, в отличие от разбора чужого
 * текста.
 */

export type CommandLocale = 'ru' | 'en';

export interface CommandRow extends SlashCommand {
  /** Встроенная команда: поведение зашито в CLI, файла и страницы у неё нет. */
  isBuiltin: boolean;
  /** Что это по сути: обычная команда, «bundled skill» или связка агентов. */
  builtinKind?: BuiltinCommand['kind'];
  /** Команда убрана из CLI — ищут её зря. */
  isRemoved?: boolean;
  /** Ключ семьи: общий префикс имени или владелец. */
  familyKey?: string;
  /** Другие команды той же семьи — их имена показываются в карточке. */
  family: string[];
}

/** Встроенные — в тот же вид, что и прочитанные с диска. */
export function builtinRows(locale: CommandLocale): SlashCommand[] {
  return BUILTIN_COMMANDS.map((command) => ({
    id: `builtin:/${command.name}`,
    invocation: `/${command.name}`,
    name: command.name,
    source: 'builtin' as const,
    description: locale === 'ru' ? command.ru : command.en,
    owner: 'Claude Code',
    isEnabled: !command.removed,
    aliases: command.aliases ?? [],
    related: command.related ?? [],
    target: 'none' as const,
  }));
}

/**
 * Собрать список для показа: встроенные + прочитанные с диска, с посчитанными
 * семьями. Совпадение по вызову решается в пользу файла: если у человека есть
 * свой `/doctor`, показывать надо ЕГО, а не одноимённую встроенную.
 */
export function buildCommandRows(
  fromDisk: SlashCommand[],
  locale: CommandLocale,
  includeBuiltins = true,
): CommandRow[] {
  const seen = new Set(fromDisk.map((command) => command.invocation));
  const builtins = includeBuiltins
    ? builtinRows(locale).filter((command) => !seen.has(command.invocation))
    : [];

  const merged = [...fromDisk, ...builtins];
  const meta = new Map(BUILTIN_COMMANDS.map((command) => [command.name, command]));
  const families = buildFamilies(merged);

  return merged
    .map((command): CommandRow => {
      const builtin = command.source === 'builtin' ? meta.get(command.name) : undefined;
      const familyKey = familyKeyOf(command, families);
      const family = familyKey
        ? (families.get(familyKey) ?? []).filter((item) => item !== command.invocation)
        : [];

      return {
        ...command,
        isBuiltin: command.source === 'builtin',
        ...(builtin ? { builtinKind: builtin.kind } : {}),
        ...(builtin?.removed ? { isRemoved: true } : {}),
        ...(familyKey && family.length > 0 ? { familyKey } : {}),
        family,
      };
    })
    .sort((a, b) => a.invocation.localeCompare(b.invocation));
}

/**
 * Семьи: у команд плагина ключ — сам плагин, у остальных — первое слово имени
 * (`design-sync` → `design`). Семья из одного — не семья, такие ключи
 * выбрасываем: подпись «в семье: —» ничего не сообщает.
 */
function buildFamilies(commands: SlashCommand[]): Map<string, string[]> {
  const families = new Map<string, string[]>();

  for (const command of commands) {
    const key = rawFamilyKey(command);
    if (!key) continue;
    families.set(key, [...(families.get(key) ?? []), command.invocation]);
  }

  for (const [key, members] of families) {
    if (members.length < 2) families.delete(key);
  }
  return families;
}

function rawFamilyKey(command: SlashCommand): string | undefined {
  if (command.source === 'plugin') return command.owner;
  const head = command.name.split(/[-:]/)[0];
  return head && head.length > 1 ? head : undefined;
}

function familyKeyOf(command: SlashCommand, families: Map<string, string[]>): string | undefined {
  const key = rawFamilyKey(command);
  return key && families.has(key) ? key : undefined;
}

/**
 * Поиск по всему, что человек может помнить: имя, вызов, описание, владелец,
 * другие имена той же команды. Запрос со слэшем ищется так же, как без него —
 * набирать команду привычно именно со слэшем.
 */
export function filterCommands(rows: CommandRow[], query: string): CommandRow[] {
  const needle = query.trim().toLowerCase().replace(/^\//, '');
  if (!needle) return rows;

  return rows.filter((row) =>
    [row.name, row.invocation, row.description, row.owner ?? '', ...row.aliases]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

/** Фильтр по источнику: `all` — всё подряд. */
export type CommandFilter = 'all' | SlashCommand['source'];

export function filterBySource(rows: CommandRow[], filter: CommandFilter): CommandRow[] {
  return filter === 'all' ? rows : rows.filter((row) => row.source === filter);
}

/** Сколько команд каждого источника — для подписей на фильтрах. */
export function countBySource(rows: CommandRow[]): Record<CommandFilter, number> {
  const counts: Record<CommandFilter, number> = {
    all: rows.length,
    builtin: 0,
    skill: 0,
    command: 0,
    plugin: 0,
  };
  for (const row of rows) counts[row.source] += 1;
  return counts;
}
