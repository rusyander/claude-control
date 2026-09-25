import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { GroupControlState } from '../ui/GroupControl.types';
import { acceptanceOf } from './groupAcceptance';

/**
 * Ключ строки хаба для звена группы. Номер группы из связи — первым (Д12):
 * ветку, прочитанную из разговора, агент волен сменить (или уйти в detached
 * HEAD), и одна группа распадалась на две строки. Номера нет (связь старше
 * поля) — ветка, затем имя группы, затем сам разговор.
 */
export function splitGroupKey(link: {
  groupIndex?: number | undefined;
  branch?: string | undefined;
  title?: string | undefined;
  id: string;
}): string {
  if (typeof link.groupIndex === 'number') return `#${link.groupIndex}`;
  return link.branch || link.title || link.id;
}

/**
 * Склейка строк хаба с записью конвейера уровней: порядок старта плюс группы,
 * у которых чата ЕЩЁ НЕТ.
 *
 * Живёт в фиче, а не рядом с одной из страниц, потому что лент переписки в
 * панели две — своя у Claude и своя у чужого CLI, — и группу без чата надо
 * показать в обеих: пока разбор считает, пока группа ждёт предшественников,
 * пока она ждёт ОТВЕТА ЧЕЛОВЕКА. Последнее особенно: отвечают на вопрос разбора
 * прямо здесь, и строки, которой нет, не существует и вопроса.
 *
 * Отличаются страницы только источником готовых строк — список чатов и реестр
 * прогонов у Claude, дерево у чужого CLI, — и потому сюда приходит уже готовая
 * карта «ключ группы → строка», посчитанного `splitGroupKey`.
 */
export function mergeSplitGroups(
  byKey: Map<string, ChildStageGroup>,
  split: SplitPlanView,
): ChildStageGroup[] {
  // Порядок конвейера: разбор, потом группы как он их выстроил, потом всё, что
  // в конвейере не значится (чаты старше него или заведённые руками).
  const ordered: ChildStageGroup[] = [];
  const taken = new Set<string>();
  const take = (key: string | undefined): void => {
    if (!key || taken.has(key)) return;
    const row = byKey.get(key);
    if (!row) return;
    taken.add(key);
    ordered.push(row);
  };

  take([...byKey.entries()].find(([, row]) => row.stages.includes('triage'))?.[0]);
  const order = [
    ...split.order,
    ...split.groups.map((group) => group.index).filter((index) => !split.order.includes(index)),
  ];
  for (const index of order) {
    const group = split.groups.find((item) => item.index === index);
    if (!group) continue;
    const found =
      findRow(byKey, splitGroupKey({ groupIndex: group.index, id: '' }), group.chatId) ??
      findRow(byKey, group.branch || group.title, group.chatId);
    if (found) {
      taken.add(found.key);
      ordered.push({
        ...found.row,
        title: group.title || found.row.title,
        // Состояние по конвейеру — для счётчиков сводки хаба (L37).
        status: group.status,
        ...(group.base ? { base: group.base } : {}),
        // Чего ждёт группа, у которой чат есть (Д3): решения по ревью, фона,
        // повтора. Вопрос из транскрипта точнее — его не перекрываем.
        ...(!found.row.waitingFor && group.waitingFor && !found.row.isRunning
          ? { waitingFor: group.waitingFor }
          : {}),
        // Итог и хвост ответа — про ПРОШЛЫЙ ход (Д5, Д16): у идущего звена они
        // уже неправда, новый ответ ещё пишется.
        ...(!found.row.isRunning && group.result ? { result: group.result } : {}),
        ...(!found.row.isRunning && group.tail ? { tail: group.tail } : {}),
        // Ссылка на MR — факт, а не прошлый ход: MR не исчезает, пока группа
        // снова работает (правит по ревью), поэтому видна и у идущего звена.
        ...(group.mr ? { mr: group.mr } : {}),
        // Группа сдалась (Д10): без причины строка с чатом выглядела просто
        // остановившейся, и «попытки кончились» человек не узнавал ниоткуда.
        ...(!found.row.isRunning && group.status === 'failed' ? errorOf(group) : {}),
        ...(!found.row.isRunning && group.retries ? { retries: group.retries } : {}),
        // Чего не хватило до доставки — видно и у идущего звена: это то, что
        // группа сейчас доделывает по напоминанию панели.
        ...deliveryMissingOf(group),
        ...(group.deliveryNudges ? { deliveryNudges: group.deliveryNudges } : {}),
        // Оборванная группа (WP1c): идущему звену кнопка не нужна — его уже
        // продолжили.
        ...(!found.row.isRunning && group.waitingFor === 'interrupted' && group.interruptedAt
          ? {
              interrupted: {
                index: group.index,
                at: group.interruptedAt,
                ...(group.interruptResumes ? { resumes: group.interruptResumes } : {}),
              },
            }
          : {}),
        // Закрытая группа с копией (Д19): предложить убрать. Идущему звену —
        // нет: сносить каталог из-под агента нельзя.
        ...(!found.row.isRunning &&
        group.path &&
        (group.status === 'done' || group.status === 'failed')
          ? {
              copy: {
                index: group.index,
                ...(group.cleaned ? { cleaned: group.cleaned.branch } : {}),
              },
            }
          : {}),
        // Пауза одной группы (журнал 81a) — метка строки и кнопка «Продолжить».
        ...(group.status === 'paused' ? { isPaused: true } : {}),
        ...controlOf(group, split),
        // Ручная приёмка доставленной группы (TK-accepted).
        ...acceptanceOf(group, split, found.row.isRunning),
        // Разрешённое по строке «с отметкой» — и у идущего звена: это то, что
        // прошло без человека прямо сейчас.
        ...(group.autoNotices?.length
          ? {
              autoNotices: {
                parentChatId: split.parentChatId,
                index: group.index,
                notices: group.autoNotices,
              },
            }
          : {}),
      });
      continue;
    }
    ordered.push(pendingRow(group, split));
  }
  for (const [key] of byKey) take(key);
  return ordered;
}

type SplitGroup = SplitPlanView['groups'][number];

/** Причина сбоя — вместе с кодом: без него английский хаб показал бы русскую строку. */
function errorOf(group: SplitGroup): Pick<ChildStageGroup, 'error' | 'errorCode' | 'errorParams'> {
  if (!group.error) return {};
  return {
    error: group.error,
    ...(group.errorCode ? { errorCode: group.errorCode } : {}),
    ...(group.errorParams ? { errorParams: group.errorParams } : {}),
  };
}

/** Чего не хватило до доставки — вместе с кодами строк (по индексу). */
function deliveryMissingOf(
  group: SplitGroup,
): Pick<ChildStageGroup, 'deliveryMissing' | 'deliveryMissingCodes'> {
  if (!group.deliveryMissing) return {};
  return {
    deliveryMissing: group.deliveryMissing,
    ...(group.deliveryMissingCodes ? { deliveryMissingCodes: group.deliveryMissingCodes } : {}),
  };
}

/** Строка группы конвейера среди строк по чатам: по ключу ветки, иначе по чату. */
function findRow(
  byKey: Map<string, ChildStageGroup>,
  key: string,
  chatId: string | undefined,
): { key: string; row: ChildStageGroup } | undefined {
  const direct = byKey.get(key);
  if (direct) return { key, row: direct };
  if (!chatId) return undefined;
  for (const [known, row] of byKey) if (row.chatId === chatId) return { key: known, row };
  return undefined;
}

/**
 * Строка группы без чата: конвейер её ещё не завёл. Что именно она ждёт —
 * единственное, что тут можно показать, и единственное, что человеку нужно:
 * «ждёт ответа» — это про него.
 */
function pendingRow(group: SplitPlanView['groups'][number], split: SplitPlanView): ChildStageGroup {
  const titleOf = (index: number): string =>
    split.groups.find((item) => item.index === index)?.title ?? `#${index + 1}`;
  // Ждущее состояние конвейера — как есть; всё остальное («pending», а также
  // «started»/«done» у группы, чей чат до списка ещё не доехал) читается как
  // «ждёт итога разбора»: строке нужно сказать, почему группы не видно.
  const known = ['held', 'waiting', 'failed'] as const;
  // Разбор уже применён, а группа всё ещё `pending` — она ждёт места: сколько
  // групп идёт разом, решает настройка проекта.
  const pending: ChildStageGroup['pending'] =
    known.find((status) => status === group.status) ??
    (group.status === 'pending' && split.triage ? 'queued' : 'pending');
  return {
    chatId: '',
    title: group.title,
    ...(group.branch ? { branch: group.branch } : {}),
    stages: [],
    isRunning: false,
    pending,
    // Номер группы в конвейере: им адресуются обе двери к стоящей группе —
    // ответ на вопрос разбора и «отпустить», не дожидаясь предшественников.
    groupIndex: group.index,
    ...(group.after.length > 0 ? { waitsFor: group.after.map(titleOf) } : {}),
    ...(group.hold
      ? {
          hold: {
            index: group.index,
            question: group.hold,
            // Код переезжает под именем поля, в котором вопрос тут лежит:
            // переводит его общий `serverFieldText`, а он ищет код по полю.
            ...(group.holdCode ? { questionCode: group.holdCode } : {}),
            ...(group.holdParams ? { questionParams: group.holdParams } : {}),
          },
        }
      : {}),
    ...(group.holdAnswer ? { holdAnswered: true } : {}),
    ...(group.base ? { base: group.base } : {}),
    ...errorOf(group),
    ...(pending === 'queued' ? controlOf(group, split) : {}),
  };
}

/**
 * Что можно сделать с группой из строки (журнал 81, 89): работающую или
 * ждущую — на паузу, остановленную — продолжить, ждущую места — запустить
 * сейчас. Оборванной своя кнопка «Продолжить» (WP1c), и вторая ей не нужна.
 * Срок сброса лимита — у самой группы, у очереди — общий по разделению.
 */
function controlOf(
  group: SplitPlanView['groups'][number],
  split: SplitPlanView,
): Pick<ChildStageGroup, 'control'> {
  const action = controlAction(group);
  if (!action) return {};
  const limitUntil = group.waitingFor === 'limit' ? group.limitUntil : undefined;
  const queueLimit = action === 'start' ? split.limitUntil : undefined;
  const until = limitUntil ?? queueLimit;
  return {
    control: {
      parentChatId: split.parentChatId,
      index: group.index,
      action,
      ...(until ? { limitUntil: until } : {}),
    },
  };
}

function controlAction(
  group: SplitPlanView['groups'][number],
): GroupControlState['action'] | undefined {
  if (group.status === 'paused') return 'resume';
  if (group.status === 'pending') return 'start';
  const working =
    group.status === 'started' || group.status === 'background' || group.status === 'awaiting';
  return working && group.waitingFor !== 'interrupted' ? 'pause' : undefined;
}
