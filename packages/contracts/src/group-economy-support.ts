import { enum as zodEnum, object, partialRecord, type infer as Infer } from 'zod';
import type { GroupEconomy } from './group-economy.ts';
import { economyMessageParams } from './server-messages/economy.ts';
import type { EconomyMessageCode } from './server-messages/table.ts';

/**
 * Где рычаг экономии групп действует — по каждому CLI (план экономии чужих CLI, 22.10.2026).
 *
 * Рычаги страницы «Настройки → Группы» общие на все CLI, а действуют по-разному:
 * у Claude все родные, у Codex и Qwen Code часть — ключом самого CLI, часть
 * панель изображает сама, а часть у CLI не существует вовсе. Каталог провайдера
 * объявляет это один раз, сервер отдаёт в `ProviderInfo.groupEconomy`, страница
 * рисует по нему отметки «Где действует». Иначе человек включал рычаг и не знал,
 * почему на Qwen Code он ничего не меняет.
 */

/**
 * Девять рычагов, у которых бывает «где действует». `keepWarmPings` — число
 * пингов рычага `keepWarm`, своей отметки ему не нужно.
 */
export const GROUP_ECONOMY_LEVERS = [
  'compactWindow',
  'bashOutputChars',
  'readOutputTokens',
  'cacheTtl',
  'detachIde',
  'sonnetDeliver',
  'freshOnColdResume',
  'keepWarm',
  'workHabits',
] as const satisfies readonly (keyof GroupEconomy)[];

export type GroupEconomyLever = (typeof GROUP_ECONOMY_LEVERS)[number];

/**
 * Как рычаг доходит до CLI:
 * - `native` — ключом или переменной самого CLI;
 * - `emulated` — панель делает это сама (строка в задании, свой выбор модели);
 * - `meaningless` — у этого способа запуска рычагу нечего менять;
 * - `impossible` — ключа у CLI нет;
 * - `disproportionate` — ключ есть, но цена его включения выше выигрыша.
 */
export const LEVER_SUPPORT_VALUES = [
  'native',
  'emulated',
  'meaningless',
  'impossible',
  'disproportionate',
] as const;

export type LeverSupport = (typeof LEVER_SUPPORT_VALUES)[number];

/**
 * Подсказки к отметке — коды текстов сервера (`server-messages/economy.ts`): почему
 * рычаг не действует или при каком условии действует.
 */
export const ECONOMY_NOTE_CODES = Object.keys(economyMessageParams) as EconomyMessageCode[];

/**
 * Отметка одного рычага: состояние и подсказка. У недействующего (`meaningless`,
 * `impossible`, `disproportionate`) подсказка ОБЯЗАТЕЛЬНА — причина; у действующего
 * (`native`, `emulated`) — по желанию, и тогда это условие («только при входе через
 * Anthropic», «когда окно модели известно»): страница пишет «с условием» словом.
 * Подсказка — код, а не строка: клиенты переводят его своими словарями, и английский
 * интерфейс не показывает русскую фразу сервера.
 */
export const leverSupportEntrySchema = object({
  support: zodEnum(LEVER_SUPPORT_VALUES),
  note: zodEnum(ECONOMY_NOTE_CODES as [EconomyMessageCode, ...EconomyMessageCode[]]).optional(),
});

export type LeverSupportEntry = Infer<typeof leverSupportEntrySchema>;

/**
 * Карта провайдера: рычаг → отметка. Неполная намеренно — рычаг без отметки
 * значит «каталог ещё не объявил», и страница его просто не рисует. Чужой ключ
 * отвергается (`invalid_key` самого zod): опечатка в каталоге не должна молча пропадать.
 */
export const groupEconomySupportSchema = partialRecord(
  zodEnum(GROUP_ECONOMY_LEVERS),
  leverSupportEntrySchema,
);

export type GroupEconomySupport = Partial<Record<GroupEconomyLever, LeverSupportEntry>>;

/** Действует ли рычаг у CLI вообще: родной ключ или работа панели. */
export function leverWorks(entry: LeverSupportEntry | undefined): boolean {
  return entry?.support === 'native' || entry?.support === 'emulated';
}
