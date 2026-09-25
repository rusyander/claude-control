/**
 * Находки группы разделения ВНЕ её задач (95b): дефект, замеченный по дороге,
 * который группа не чинит — он чужой, — но и молча терять его нельзя.
 *
 * Группа пишет в ответ блок `<agentdeck:ticket>`, сервер вынимает его из текста
 * хода и кладёт в запись группы, хаб показывает список «Предложить тикет» с
 * кнопкой «копировать». Тикет в трекере панель НЕ заводит: запись в трекер —
 * отдельное согласие человека на каждую операцию, и кнопка «скопировать» — вся
 * помощь, которую тут можно дать без него.
 *
 * Почему блок, а не догадка по свободному тексту: у отчёта агента «заметил, что
 * …» встречается на каждом шагу, и эвристика давала бы ложные тикеты и не
 * давала бы устойчивых полей (что, где, почему).
 *
 * Формат (поля — по строке, значение может продолжаться следующими строками):
 *
 * ```
 * <agentdeck:ticket>
 * title: коротко, что сломано
 * where: путь/к/файлу.ts:42 или экран/маршрут
 * why: чем это плохо и как воспроизвести
 * </agentdeck:ticket>
 * ```
 */

import { blockLang } from './brand.ts';

/** Метка блока — под именем продукта, как у остальных блоков панели. */
export const SPLIT_TICKET_TAG = blockLang('ticket');

/** Предложение тикета, как его написала группа. */
export interface SplitTicketProposal {
  title: string;
  /** Где дефект: файл со строкой, экран, маршрут. */
  where: string;
  /** Чем плох и как воспроизвести. */
  why: string;
}

/** Предложение в записи группы: когда панель его впервые увидела (ISO). */
export interface SplitTicketView extends SplitTicketProposal {
  at: string;
  /**
   * Задача заведена в трекере кнопкой хаба после подтверждения человека: ключ
   * задачи и когда. Отметка — у всех групп с тем же дефектом, и второй раз та же
   * находка не заводится.
   */
  filed?: { key: string; at: string };
}

/** Потолки полей и числа: запись живёт в `state.json`, и болтливый агент не должен её раздуть. */
const FIELD_MAX = { title: 200, where: 400, why: 1500 } as const;
/** Сколько предложений держит одна группа; сверх — новые не принимаются. */
export const SPLIT_TICKETS_MAX = 20;

/**
 * Шаг, который группа сделать не может, а человек — может (находка 112 живого
 * прогона 24.09): зависимость между MR (в инструментах трекера такой операции
 * нет, прямой REST без согласия запрещён), доступ, настройка чужого сервиса.
 * Тем же блоком, что и тикет, — иначе шаг тонул в итоговом тексте, и MR уходил
 * на слияние без зависимости. Хаб показывает список «Сделать человеку».
 *
 * ```
 * <agentdeck:human>
 * action: что сделать — «выставить зависимость MR !808 от !789»
 * where: ссылка или место, где это делается
 * why: зачем и почему группа не может сама
 * </agentdeck:human>
 * ```
 */
export const SPLIT_HUMAN_TAG = blockLang('human');

/** Шаг человеку, как его написала группа. */
export interface SplitHumanStepProposal {
  action: string;
  /** Где это делается: ссылка на MR, страница настроек, сервис. */
  where: string;
  /** Зачем и почему группа не может сама. */
  why: string;
}

/** Шаг в записи группы: когда панель его впервые увидела (ISO). */
export interface SplitHumanStepView extends SplitHumanStepProposal {
  at: string;
}

/** Любой блок панели в тексте хода — тикет или шаг человеку. */
const BLOCK = new RegExp(`<(${SPLIT_TICKET_TAG}|${SPLIT_HUMAN_TAG})>([\\s\\S]*?)</\\1>`, 'g');
const FIELD = /^\s*([a-z]+)\s*:\s*(.*)$/i;

/**
 * Куски текста вне блоков кода (итоговое ревью 25.09, m10): сообщение,
 * ОПИСЫВАЮЩЕЕ формат блока примером в ``` … ```, не теряет пример в ленте, и
 * сервер не записывает из него тикет-призрак. Незакрытый блок кода тянется до
 * конца текста — как его и рисует лента.
 */
const FENCE = /(```[\s\S]*?(?:```|$))/;

function mapOutsideFences(text: string, map: (part: string) => string): string {
  return text
    .split(FENCE)
    .map((part, index) => (index % 2 === 0 ? map(part) : part))
    .join('');
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Поля блоков данного тега из текста хода (вне блоков кода), сырые. */
function scanBlocks<K extends string>(
  text: string,
  tag: string,
  keys: readonly K[],
): Record<K, string>[] {
  const found: Record<K, string>[] = [];
  const outside = text
    .split(FENCE)
    .filter((_, index) => index % 2 === 0)
    .join('\n');
  for (const match of outside.matchAll(BLOCK)) {
    if (match[1] !== tag) continue;
    const fields = Object.fromEntries(keys.map((key) => [key, ''])) as Record<K, string>;
    let current: K | undefined;
    for (const line of (match[2] ?? '').split('\n')) {
      const field = FIELD.exec(line);
      const key = (field?.[1] ?? '').toLowerCase() as K;
      if (field && keys.includes(key)) {
        current = key;
        fields[current] = field[2] ?? '';
      } else if (current) {
        // Продолжение значения — следующая строка того же поля.
        fields[current] += `\n${line}`;
      }
    }
    found.push(fields);
  }
  return found;
}

/**
 * Блоки тикетов из текста хода. Блок без названия — не тикет: показать в
 * списке нечего. Блок, у которого нет ни «где», ни «почему», — тоже: такую
 * заявку человеку не завести, а подсказывать ей поля панель не может.
 */
export function scanSplitTickets(text: string): SplitTicketProposal[] {
  const found: SplitTicketProposal[] = [];
  for (const fields of scanBlocks(text, SPLIT_TICKET_TAG, ['title', 'where', 'why'] as const)) {
    const ticket = {
      title: clip(fields.title, FIELD_MAX.title),
      where: clip(fields.where, FIELD_MAX.where),
      why: clip(fields.why, FIELD_MAX.why),
    };
    if (ticket.title && (ticket.where || ticket.why)) found.push(ticket);
  }
  return found;
}

/** Шаги человеку из текста хода. Без самого шага (`action`) показывать нечего. */
export function scanSplitHumanSteps(text: string): SplitHumanStepProposal[] {
  const found: SplitHumanStepProposal[] = [];
  for (const fields of scanBlocks(text, SPLIT_HUMAN_TAG, ['action', 'where', 'why'] as const)) {
    const step = {
      action: clip(fields.action, FIELD_MAX.title),
      where: clip(fields.where, FIELD_MAX.where),
      why: clip(fields.why, FIELD_MAX.why),
    };
    if (step.action) found.push(step);
  }
  return found;
}

/**
 * Текст хода без блоков панели — тикетов и шагов человеку. Итог хода читается по последнему абзацу
 * (вопрос ли это, какой хвост показать, какой MR назван), и блок в конце
 * ответа читался бы вместо него: «why: … как воспроизвести?» — вопросом
 * человеку, ссылка на чужой MR в «where» — MR группы.
 *
 * Тем же вызовом блок прячет лента: тикет живёт в хабе списком «Предложить
 * тикет», а сырой тег в пузыре читается мусором. Пока ответ идёт
 * (`streaming`), незакрытый блок прячется вместе с хвостом — иначе поля
 * секундами стоят в ленте, пока агент не допишет закрывающий тег.
 */
export function withoutSplitTickets(text: string, options?: { streaming?: boolean }): string {
  let rest = mapOutsideFences(text, (part) => part.replace(BLOCK, ''));
  if (options?.streaming) {
    const parts = rest.split(FENCE);
    const last = parts.length - 1;
    // Незакрытый тег ищется только в хвосте вне кода — пример в ``` не режется.
    const tail = parts[last] ?? '';
    const open =
      last % 2 === 0
        ? Math.max(
            tail.lastIndexOf(`<${SPLIT_TICKET_TAG}>`),
            tail.lastIndexOf(`<${SPLIT_HUMAN_TAG}>`),
          )
        : -1;
    if (open >= 0) {
      parts[last] = (parts[last] ?? '').slice(0, open);
      rest = parts.join('');
    }
  }
  // Текст без блоков не трогается вовсе: обрезать края чужого текста не за что.
  return rest === text ? text : rest.trim();
}

/**
 * Ключ повтора: название и место без регистра и лишних пробелов. Группа
 * пишет один и тот же блок и в ходе, и в итоговом отчёте, а проверка доставки
 * перечитывает тот же ход — без ключа список рос бы копиями.
 */
export function splitTicketKey(ticket: Pick<SplitTicketProposal, 'title' | 'where'>): string {
  const norm = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(ticket.title)}|${norm(ticket.where)}`;
}

/** Новые предложения к уже известным: без повторов, не больше потолка. */
export function mergeSplitTickets(
  known: readonly SplitTicketView[] | undefined,
  found: readonly SplitTicketProposal[],
  at: string,
): SplitTicketView[] {
  const merged = [...(known ?? [])];
  const seen = new Set(merged.map(splitTicketKey));
  for (const ticket of found) {
    if (merged.length >= SPLIT_TICKETS_MAX) break;
    const key = splitTicketKey(ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...ticket, at });
  }
  return merged;
}

/** Ключ повтора шага: сам шаг и место, как у тикета. */
export function splitHumanStepKey(step: Pick<SplitHumanStepProposal, 'action' | 'where'>): string {
  return splitTicketKey({ title: step.action, where: step.where });
}

/** Новые шаги к уже известным: без повторов, не больше потолка. */
export function mergeSplitHumanSteps(
  known: readonly SplitHumanStepView[] | undefined,
  found: readonly SplitHumanStepProposal[],
  at: string,
): SplitHumanStepView[] {
  const merged = [...(known ?? [])];
  const seen = new Set(merged.map(splitHumanStepKey));
  for (const step of found) {
    if (merged.length >= SPLIT_TICKETS_MAX) break;
    const key = splitHumanStepKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...step, at });
  }
  return merged;
}
