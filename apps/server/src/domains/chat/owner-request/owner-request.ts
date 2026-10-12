import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import {
  OWNER_REQUEST_OPENER,
  ownerRequestBlock,
  splitOwnerRequest,
} from '@agentdeck/contracts/quality-floor';
import { SPLIT_REQUEST_LINE } from '@agentdeck/contracts/task-split';
import {
  findTranscript,
  readWholeTranscriptRecords,
  type TranscriptRecord,
} from '../ChatHistory/ChatHistory.ts';
import { isDialogMessage, textOf } from '../ChatRecords/ChatRecords.ts';
import { stripChildrenBrief } from '../children-brief/children-brief.ts';
import { withoutPanelPreamble } from '../panel-preamble.ts';
import { readChat } from '../../provider-chat/store/store.ts';

/**
 * Слова владельца из разговора-родителя (U1) — для блока «Owner's request,
 * verbatim» в каждой группе разделения. Берёт панель, а не агент родителя:
 * агент пересказывал, и условия владельца терялись по дороге.
 *
 * Берётся весь разговор (с последнего `/clear` — это уже другой транскрипт), а
 * не «с прошлого разделения»: человек, отменивший план и попросивший разделить
 * заново, написал задание ДО первого разделения, и окно «после» его бы потеряло.
 */

/**
 * Служебные вставки среды внутри реплики человека: напоминания, открытый файл,
 * вывод локальной команды, уведомления фоновых задач. Это не слова владельца.
 */
const ENVIRONMENT_TAGS =
  /<(ide_[a-z_]+|command-[a-z]+|local-command-[a-z]+|task-notification|system-reminder|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const INTERRUPTED = /\[Request interrupted by user[^\]]*\]/g;
const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Слеш-команда — тоже слова владельца: «/review <ссылка> отпиши в MR» несёт
 * задание в аргументах (TQ-08, 12.10.2026: аргументы срезались вместе с
 * тегами, и просьба, набранная командой набора, до групп не доходила).
 * Команда без аргументов (`/clear`) заданием не считается.
 */
function commandLine(text: string): string {
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  if (!args) return '';
  const name = COMMAND_NAME.exec(text)?.[1] ?? '';
  return name ? `${name.startsWith('/') ? name : `/${name}`} ${args}` : args;
}

/**
 * Слова владельца в одной реплике — без вставок среды и без преамбул панели,
 * переводы строк сохранены (дословно, а не сжатым в строку названием чата).
 * Реплика, целиком написанная панелью (задание звена, просьба «Разделить»), —
 * пусто.
 *
 * Родитель сам группа прошлого разделения: его первая реплика — задание панели
 * с блоком слов владельца. Отсюда уходят только эти слова: добавки агента и
 * задачи группы владелец не писал.
 */
export function ownerWords(text: string): string[] {
  const command = commandLine(text);
  const said = [command, stripChildrenBrief(text).replace(ENVIRONMENT_TAGS, '')]
    .join('\n')
    .replace(INTERRUPTED, '')
    .trim();
  if (!said || said.startsWith(SPLIT_REQUEST_LINE)) return [];
  const at = said.indexOf(OWNER_REQUEST_OPENER);
  if (at >= 0) {
    const nested = splitOwnerRequest(said.slice(at)).messages;
    if (nested.length > 0) return nested;
  }
  const own = withoutPanelPreamble(said).trim();
  return own ? [own] : [];
}

/** Реплики владельца из транскрипта Claude, по порядку. Ветки субагентов — мимо. */
export function ownerMessagesOf(records: readonly TranscriptRecord[]): string[] {
  return records
    .filter((record) => !record.isSidechain && record.type === 'user' && isDialogMessage(record))
    .flatMap((record) => ownerWords(textOf(record)));
}

export interface OwnerRequestSource {
  /** Каталог транскриптов Claude (`~/.claude/projects`). */
  projectsDir: string;
  /** Каталог данных панели — там разговоры чужих CLI. */
  appData: string;
}

/**
 * Блок слов владельца для разговора-родителя. Ключ чужого CLI — именованный
 * (`codex:…`), у Claude — идентификатор сессии. Разговор не найден или слов в
 * нём нет — `undefined`, и разделение идёт как раньше, по общему контексту агента.
 */
export function readOwnerRequest(
  source: OwnerRequestSource,
  parentKey: string | undefined,
): string | undefined {
  if (!parentKey) return undefined;
  const foreign = parseForeignChatKey(parentKey);
  if (foreign) {
    const chat = readChat(source.appData, foreign.providerId, foreign.chatId);
    const said = (chat?.messages ?? [])
      .filter((message) => message.role === 'user')
      .flatMap((message) => ownerWords(message.content));
    return ownerRequestBlock(said);
  }
  const path = findTranscript(source.projectsDir, parentKey);
  if (!path) return undefined;
  return ownerRequestBlock(ownerMessagesOf(readWholeTranscriptRecords(path)));
}
