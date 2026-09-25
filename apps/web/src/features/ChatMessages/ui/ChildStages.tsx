import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDuration } from '@shared/lib/format-duration';
import { cn } from '@shared/lib/cn';
import { serverFieldList, serverFieldText } from '@shared/config/i18n';
import { countedGroups, triageElapsedMs, triageLive } from '../lib/hubSummary';
import { useTickingNow } from '../lib/useTickingNow';
import { SplitOverlapPanel } from './SplitOverlapPanel';
import { GroupCopyCleanup } from './GroupCopyCleanup';
import { PlanCancel } from './PlanCancel';
import { GroupControl } from './GroupControl';
import { HubSummary } from './HubSummary';
import { RetiredChats } from './RetiredChats';
import { GroupAcceptance } from './GroupAcceptance';
import { GroupAutoNotices } from './GroupAutoNotices';
import { SplitFollowUps } from './SplitFollowUps';
import { TriageChip } from './TriageChip';
import type { ChildStageGroup, ChildStagesProps } from './ChildStages.types';
import styles from './ChildStages.module.scss';

/**
 * Сводка групп разделения в родительском разговоре: кто на каком звене и чем
 * ведётся.
 *
 * Зачем отдельная карточка, когда есть список чатов: список показывает
 * РАЗГОВОРЫ, а конвейер добавил каждой группе до четырёх, и понять по полутора
 * десяткам строк, на чём стоят три группы, нельзя. Здесь одна строка — одна
 * группа, и пройденные звенья подписаны подряд: «план › работа › ревью»
 * читается за секунду.
 *
 * Действий три: открыть звено (в этом же окне — каталог у разговора свой,
 * вкладка копии не нужна), остановить или продолжить ВСЁ дерево разом и
 * ответить на вопрос разбора (Т1) группе, у которой чата ещё нет. Разом —
 * потому что по одному не выходит: пока человек гасит третий чат, у первого
 * уже стартовало ревью. Пауза живёт на сервере и глушит там же автостарты, так
 * что кнопка лишь показывает состояние и нажимается.
 */
export function ChildStages({
  groups,
  onOpen,
  tree,
  onPauseAll,
  onResumeAll,
  treeBusy,
  onAnswerHold,
  holdBusy,
  onRelease,
  releaseBusy,
  onCheckOverlap,
  overlapBusy,
  onResumeInterrupted,
  resumeInterruptedBusy,
  foreign,
}: ChildStagesProps) {
  const { t } = useTranslation();
  // Время разбора и всего разделения тикает, только пока что-то идёт.
  const now = useTickingNow(groups.some((group) => group.isRunning));
  if (groups.length === 0) return null;

  // Отброшенные перезапуском чаты (L20) — не группы: ни в счёт, ни в строки.
  const retired = groups.filter((group) => group.retired);
  const live = groups.filter((group) => !group.retired);
  const interrupted = live.filter((group) => group.interrupted).length;
  const paused = tree?.paused;
  const canPause = !paused && (tree?.running ?? 0) > 0 && Boolean(onPauseAll);
  const canResume = Boolean(paused) && Boolean(onResumeAll);
  const split = tree?.split;

  return (
    <div className={styles.card} data-child-hub>
      <div className={styles.head}>
        <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
          {/* Считаются группы: строка разбора — общая, не группа (L37: «12
              групп» при одиннадцати). */}
          {t('chat.cascade.hub.title', { count: countedGroups(groups).length })}
        </Typography>
        {/* Итог разбора — одной фишкой: применён, не получен, ещё идёт. Что
            панель в нём поправила, видно по наведению: это оправдание её
            самоуправства, а не новость. */}
        {split && (
          <TriageChip
            triage={split.triage}
            live={triageLive(live, tree)}
            elapsedMs={triageElapsedMs(live, now)}
          />
        )}
        {paused && (
          <Typography variant="caption" color="subtle" as="span" className={styles.chip}>
            {t('chat.cascade.tree.paused')}
          </Typography>
        )}
        {/* Одна кнопка на состояние: идёт что-то — остановить, стоит — продолжить.
            Молчащее дерево без паузы кнопки не получает: останавливать нечего. */}
        {canPause && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={treeBusy}
            title={t('chat.cascade.tree.pauseHint')}
            onClick={onPauseAll}
          >
            {t('chat.cascade.tree.pauseAll', { count: tree?.running ?? 0 })}
          </Button>
        )}
        {canResume && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={treeBusy}
            title={t(
              foreign ? 'chat.cascade.tree.resumeHintForeign' : 'chat.cascade.tree.resumeHint',
            )}
            onClick={onResumeAll}
          >
            {t('chat.cascade.tree.resumeAll', {
              count: (paused?.chats ?? 0) + (paused?.pending ?? 0),
            })}
          </Button>
        )}
        {/* Оборванные группы (WP1c) — одной кнопкой: после выключения машины
            человек не должен обходить группы по одной. */}
        {interrupted > 0 && onResumeInterrupted && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={resumeInterruptedBusy}
            title={t('chat.cascade.hub.resumeInterruptedHint')}
            data-resume-interrupted="all"
            onClick={() => onResumeInterrupted()}
          >
            {t('chat.cascade.hub.resumeAllInterrupted', { count: interrupted })}
          </Button>
        )}
        {split && <PlanCancel split={split} />}
      </div>

      <HubSummary groups={live} now={now} />

      {live.map((group) =>
        group.chatId ? (
          <Fragment key={group.chatId}>
            <button
              type="button"
              className={styles.row}
              data-hub-row="chat"
              onClick={() => onOpen(group.chatId)}
            >
              {/* Идущий прогон пульсирует, законченное звено стоит ровно: работает
                группа или ждёт человека — первое, что тут спрашивают. */}
              <StatusDot
                tone={group.isRunning ? 'success' : 'neutral'}
                pulse={group.isRunning}
                label={t(group.isRunning ? 'chat.cascade.hub.running' : 'chat.cascade.hub.idle')}
              />
              <GroupText group={group} />
            </button>
            {/* Кнопка — соседом строки, а не внутри: строка сама кнопка. */}
            {group.copy && split?.parentChatId && (
              <GroupCopyCleanup
                parentChatId={split.parentChatId}
                index={group.copy.index}
                {...(group.copy.cleaned ? { cleaned: group.copy.cleaned } : {})}
              />
            )}
            {group.interrupted && onResumeInterrupted && (
              <div className={styles.holdActions} data-resume-interrupted="group">
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={resumeInterruptedBusy}
                  title={t('chat.cascade.hub.resumeInterruptedHint')}
                  onClick={() => onResumeInterrupted(group.interrupted?.index)}
                >
                  {t('chat.cascade.hub.resumeInterrupted')}
                </Button>
              </div>
            )}
            {group.control && <GroupControl control={group.control} />}
            {group.acceptance && <GroupAcceptance acceptance={group.acceptance} />}
            {group.autoNotices && <GroupAutoNotices autoNotices={group.autoNotices} />}
          </Fragment>
        ) : (
          <div key={group.title} className={styles.rowStatic} data-hub-row={group.pending}>
            {/* Чата нет — открывать нечего, и точка стоит ровно: группа ждёт, а
                чего именно — сказано строкой ниже. */}
            <StatusDot
              tone={group.pending === 'failed' ? 'danger' : 'neutral'}
              pulse={false}
              label={t('chat.cascade.hub.idle')}
            />
            <Stack gap="var(--spacing-3xs)" className={styles.text}>
              <GroupText group={group} />
              {group.pending === 'held' && group.hold && onAnswerHold && (
                <HoldAnswer
                  question={serverFieldText(group.hold, 'question')}
                  busy={holdBusy}
                  onSend={(answer) => onAnswerHold(group.hold?.index ?? 0, answer)}
                />
              )}
              {/* Группа ждёт предшественников — единственная кнопка, которой её
                  можно сдвинуть: цепочка предшественника могла не кончиться
                  вовсе (прогон остановили, чат удалили, панель перезапустили), и
                  тогда ждать нечего. Решение человека, и подпись говорит, чем
                  он платит: копия всё равно отводится от ветки предшественника,
                  а в задании сказано, что та работа не закончена. */}
              {group.pending === 'waiting' && group.groupIndex !== undefined && onRelease && (
                <div className={styles.holdActions} data-release-group>
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={releaseBusy}
                    title={t('chat.cascade.hub.releaseHint')}
                    onClick={() => onRelease(group.groupIndex ?? 0)}
                  >
                    {t('chat.cascade.hub.release')}
                  </Button>
                </div>
              )}
              {group.control && <GroupControl control={group.control} />}
            </Stack>
          </div>
        ),
      )}

      {/* Пересечения веток (Т6) — последним разделом: это вопрос ПОСЛЕ работы,
          и до него человек добирается, уже прочитав, кто на чём стоит. Имя
          группы берём из сводки, а не из пересечений: в них живут номера. */}
      <SplitOverlapPanel
        {...(split?.overlap ? { overlap: split.overlap } : {})}
        titleOf={(index) => split?.groups[index]?.title ?? String(index + 1)}
        {...(onCheckOverlap ? { onCheck: onCheckOverlap } : {})}
        {...(overlapBusy !== undefined ? { busy: overlapBusy } : {})}
      />

      {/* После пересечений — то, что осталось человеку: шаги и тикеты групп. */}
      {split && <SplitFollowUps split={split} />}

      <RetiredChats chats={retired} onOpen={onOpen} />
    </div>
  );
}

/** Название группы и строка её состояния — одна и та же у строки с чатом и без. */
function GroupText({ group }: { group: ChildStageGroup }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (group.branch) parts.push(group.branch);
  if (group.base) parts.push(t('chat.cascade.hub.base', { branch: group.base }));
  if (group.stages.length > 0) {
    parts.push(group.stages.map((stage) => t(`chat.cascade.stageFull.${stage}`)).join(' › '));
  }
  if (group.pending) parts.push(pendingText(group, t));
  // Сдавшаяся группа с чатом: причина по коду, но не «не завелась» — она
  // работала (живой прогон 25.09, D5: так читались группы после 8–11 минут работы).
  else if (group.error) {
    parts.push(t('chat.cascade.hub.stopped', { message: serverFieldText(group, 'error') }));
  }
  // Строки пробелов доставки — по их кодам, на языке интерфейса.
  const missing = serverFieldList(group, 'deliveryMissing');
  if (group.retries) parts.push(t('chat.cascade.hub.retries', { count: group.retries }));
  if (group.deliveryNudges) {
    parts.push(t('chat.cascade.hub.deliveryNudges', { count: group.deliveryNudges }));
  }
  // Когда оборвалась и сколько раз панель уже продолжала сама: кончились
  // попытки — это видно, а не угадывается по тишине.
  if (group.interrupted) {
    const time = new Date(group.interrupted.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    parts.push(t('chat.cascade.hub.interruptedAt', { time }));
    if (group.interrupted.resumes) {
      parts.push(t('chat.cascade.hub.interruptResumes', { count: group.interrupted.resumes }));
    }
  }
  // ЧТО сделано, а не просто «готово» (Д5): проверка без правок и правки с
  // коммитами читались одинаково, и человек считал задачу выполненной.
  if (group.result) {
    parts.push(t(`chat.cascade.hub.result.${group.result.kind}`));
    if (group.result.commits) {
      parts.push(t('chat.cascade.hub.result.commits', { count: group.result.commits }));
    }
  }
  if (group.model) parts.push(group.model);
  if (group.firstEditAfterMs !== undefined) {
    parts.push(
      t('chat.cascade.hub.firstEdit', { time: formatDuration(group.firstEditAfterMs, t) }),
    );
  }
  // Длительность, а не состояние (L23): «в работе 21м» у остановленного звена
  // читалось как «работает» — состояние говорит точка слева.
  if (group.workMs !== undefined) {
    parts.push(t('chat.cascade.hub.workTime', { time: formatDuration(group.workMs, t) }));
  }

  return (
    <Stack gap="0" className={styles.text}>
      <span className={styles.titleLine}>
        <Typography variant="body-sm" as="span" truncate>
          {group.title}
        </Typography>
        {/* Принято человеком (TK-accepted) — отметка его приёмки, не панели. */}
        {group.acceptance?.acceptedAt && (
          <Typography
            variant="caption"
            color="subtle"
            as="span"
            className={styles.chip}
            title={new Date(group.acceptance.acceptedAt).toLocaleString()}
            data-hub-accepted
          >
            {t('chat.cascade.hub.accept.marker')}
          </Typography>
        )}
        {group.isPaused && (
          <Typography variant="caption" color="subtle" as="span" className={styles.chip}>
            {t('chat.cascade.tree.paused')}
          </Typography>
        )}
        {/* Стоит не просто так, а ждёт — и чаще всего человека (Д3, Д16). */}
        {group.waitingFor && (
          <Typography
            variant="caption"
            as="span"
            className={cn(
              styles.chip,
              (group.waitingFor === 'question' || group.waitingFor === 'decision') &&
                styles.chipAsk,
            )}
            data-hub-waiting={group.waitingFor}
          >
            {t(`chat.cascade.hub.waitingFor.${group.waitingFor}`)}
          </Typography>
        )}
      </span>
      <Typography variant="caption" color="subtle" as="span" truncate>
        {parts.join(' · ')}
      </Typography>
      {/* MR группы (доставка): из хаба — прямо в него, а не через чат группы. */}
      {group.mr && (
        <a
          className={styles.mr}
          href={group.mr}
          target="_blank"
          rel="noreferrer noopener"
          data-hub-mr
        >
          {t('chat.cascade.hub.mr', { id: group.mr.match(/(\d+)$/)?.[1] ?? '' })}
        </a>
      )}
      {/* Чего не хватило до доставки по фактам git: без этого «ждёт» у группы,
          которой панель напомнила доделать MR, не объяснял ничего. */}
      {missing.length > 0 && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          truncate
          title={missing.join('\n')}
          data-hub-delivery-missing
        >
          {t('chat.cascade.hub.deliveryMissing', { list: missing.join('; ') })}
        </Typography>
      )}
      {/* Хвост последнего ответа (Д16): вопрос, заданный текстом, иначе не видно
          из родителя. Целиком — по наведению. */}
      {group.tail && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          truncate
          className={styles.tail}
          title={group.tail}
          data-hub-tail
        >
          «{group.tail}»
        </Typography>
      )}
    </Stack>
  );
}

/** Чего ждёт группа без чата — словами, которые человек может проверить по сводке. */
function pendingText(group: ChildStageGroup, t: TFunction): string {
  switch (group.pending) {
    case 'failed':
      return t('chat.cascade.hub.failed', { message: serverFieldText(group, 'error') });
    case 'held':
      return t('chat.cascade.hub.held');
    case 'queued':
      return t('chat.cascade.hub.queued');
    case 'waiting': {
      const waiting = t('chat.cascade.hub.waiting', { names: (group.waitsFor ?? []).join(', ') });
      return group.holdAnswered ? `${t('chat.cascade.hub.holdAnswered')} · ${waiting}` : waiting;
    }
    default:
      return t('chat.cascade.hub.pending');
  }
}

/**
 * Ответ на вопрос разбора. Форма живёт в строке группы, а не отдельной
 * карточкой: вопрос про ЭТУ группу, и ответ уедет в её план и задание — рядом с
 * названием ему и место. Отправляется кнопкой, не Enter: ответ бывает в
 * несколько строк.
 */
function HoldAnswer({
  question,
  busy,
  onSend,
}: {
  question: string;
  busy?: boolean;
  onSend: (answer: string) => void;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const trimmed = answer.trim();

  return (
    <div className={styles.hold} data-hold-form>
      <TextField
        label={question}
        value={answer}
        onChange={setAnswer}
        placeholder={t('chat.cascade.hub.holdPlaceholder')}
        multiline
        rows={2}
        disabled={busy}
      />
      <div className={styles.holdActions}>
        <Button
          size="sm"
          variant="primary"
          isLoading={busy}
          disabled={!trimmed}
          onClick={() => onSend(trimmed)}
        >
          {t('chat.cascade.hub.holdSend')}
        </Button>
      </div>
    </div>
  );
}
