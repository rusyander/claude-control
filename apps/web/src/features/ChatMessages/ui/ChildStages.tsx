import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { serverFieldText } from '@shared/config/i18n';
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
import { GroupStepLine } from './GroupMeta';
import { GroupText } from './GroupText';
import type { ChildStagesProps } from './ChildStages.types';
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
              <GroupText
                group={group}
                step={<GroupStepLine chatId={group.chatId} isRunning={group.isRunning} />}
              />
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
              {group.copy && split?.parentChatId && (
                <GroupCopyCleanup
                  parentChatId={split.parentChatId}
                  index={group.copy.index}
                  {...(group.copy.cleaned ? { cleaned: group.copy.cleaned } : {})}
                />
              )}
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
