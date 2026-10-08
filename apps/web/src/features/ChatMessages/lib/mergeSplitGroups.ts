import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { GroupControlAction } from '../ui/GroupControl.types';
import { acceptanceOf } from './groupAcceptance';
import { recheckOf } from './groupRecheck';
import { mergeOrderOf } from './mergeOrder';
import { splitGroupKey } from './splitGroupKey';

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
  // Очередь слияния считается по всему плану разом: номер группы зависит от соседей.
  const mergeOrder = mergeOrderOf(split);
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
      const queued = mergeOrder.get(group.index);
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
        ...(group.testsVerdict ? { testsVerdict: group.testsVerdict } : {}),
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
        ...controlOf(group, split, true),
        // Ручная приёмка доставленной группы (TK-accepted).
        ...acceptanceOf(group, split, found.row.isRunning),
        // «Перепроверить MR» доставленной группы (владелец 05.10).
        ...recheckOf(group, split, found.row.isRunning),
        // «Перевести задачи» группы (G4): видна у любой группы с ключами трекера —
        // MR не нужен, и без подключённой Jira тоже (окно скажет, где подключить).
        ...(group.taskKeys?.length
          ? {
              taskMove: {
                index: group.index,
                keys: group.taskKeys,
                connected: Boolean(split.jiraTasks),
              },
            }
          : {}),
        ...(group.mrClosed ? { mrClosed: group.mrClosed } : {}),
        ...(queued ? { mergeOrder: queued } : {}),
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
  const known = ['held', 'waiting', 'failed', 'paused'] as const;
  // Разбор уже применён, а группа всё ещё `pending` — она ждёт места: сколько
  // групп идёт разом, решает настройка проекта.
  const pending: ChildStageGroup['pending'] =
    known.find((status) => status === group.status) ??
    (group.status === 'pending' && split.triage ? 'queued' : undefined) ??
    // Стартовала, а чата нет: идёт подготовка копии (живой прогон 29.09 —
    // минуты `npm ci` читались как «ничего не запустилось»).
    // Только без чата: чат, не доехавший до списка, — не подготовка и не обрыв.
    (group.status === 'started' && !group.chatId ? 'setup' : undefined) ??
    (group.status === 'awaiting' && group.waitingFor === 'interrupted' && !group.chatId
      ? 'interrupted'
      : 'pending');
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
    // Закрытая группа с копией и без чата (убранная человеком после обрыва):
    // её копию тоже можно убрать.
    ...(group.path && group.status === 'failed'
      ? {
          copy: {
            index: group.index,
            ...(group.cleaned ? { cleaned: group.cleaned.branch } : {}),
          },
        }
      : {}),
    ...(pending !== 'pending' ? controlOf(group, split, false) : {}),
  };
}

/**
 * Что можно сделать с группой из строки (журнал 81, 89): работающую или
 * ждущую — на паузу, остановленную — продолжить, ждущую места — запустить
 * сейчас или придержать (живой прогон 29.09). Оборванной с чатом своя кнопка
 * «Продолжить» (WP1c), и вторая ей не нужна; оборванной ДО чата продолжать
 * нечего — «Завести заново» или «Убрать», иначе строка — тупик.
 * Срок сброса лимита — у самой группы, у очереди — общий по разделению.
 */
function controlOf(
  group: SplitPlanView['groups'][number],
  split: SplitPlanView,
  hasChat: boolean,
): Pick<ChildStageGroup, 'control'> {
  // Ф16: посреди разбора порядок групп решает он — «Запустить сейчас» сервер
  // отказывает (`split-start-triage`), а «Пауза» ждущей группы ничего не
  // держит: кнопки строки гаснут до итога разбора.
  const triaging = Boolean(split.triageChatId && !split.triage);
  const actions =
    triaging && group.status === 'pending'
      ? []
      : controlActions(group, hasChat, Boolean(split.cancelledAt));
  if (actions.length === 0) return {};
  const limitUntil = group.waitingFor === 'limit' ? group.limitUntil : undefined;
  const queueLimit = actions[0] === 'start' ? split.limitUntil : undefined;
  const until = limitUntil ?? queueLimit;
  // Пауза из очереди: места группа не держит — «Продолжить» вернёт её в
  // очередь. Решает сервер: старт до записи копии место уже держит.
  const fromQueue = group.status === 'paused' && !group.seated;
  return {
    control: {
      parentChatId: split.parentChatId,
      index: group.index,
      actions,
      ...(fromQueue ? { fromQueue: true } : {}),
      ...(until ? { limitUntil: until } : {}),
    },
  };
}

function controlActions(
  group: SplitPlanView['groups'][number],
  hasChat: boolean,
  cancelled: boolean,
): GroupControlAction[] {
  // Пауза держит место под потолком: ненужную группу человек убирает, не
  // отменяя весь план.
  if (group.status === 'paused') return ['resume', 'drop'];
  // Остановилась недоделанной (владелец 05.10): сдалась на сбое — доступ CLI
  // кончился, повторы исчерпаны, доставка не сошлась — или ход без итога ревью.
  // Строка сдавшейся группы была без единой кнопки. Продолжать можно, пока
  // есть разговор и копия, а план не отменён.
  const unfinished =
    group.status === 'failed' ||
    (group.status === 'awaiting' && group.waitingFor === 'review-missing');
  // «Убрать» — без возврата: убранной группе «Продолжить» нет (ревью R3).
  const continuable =
    !cancelled && !group.droppedAt && (hasChat || group.chatId) && group.path && !group.cleaned;
  if (unfinished && continuable) {
    return group.status === 'failed' ? ['continue'] : ['continue', 'pause'];
  }
  if (group.status === 'pending') return ['start', 'pause'];
  if (group.status === 'awaiting' && group.waitingFor === 'interrupted') {
    return hasChat || group.chatId ? [] : ['restart', 'drop'];
  }
  const working =
    group.status === 'started' || group.status === 'background' || group.status === 'awaiting';
  return working ? ['pause'] : [];
}
