import type { SlashCommand } from '@agentdeck/contracts';
import type { BuiltinCommand } from './builtinCommands';

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

/** Фильтр по источнику: `all` — всё подряд. */
export type CommandFilter = 'all' | SlashCommand['source'];
