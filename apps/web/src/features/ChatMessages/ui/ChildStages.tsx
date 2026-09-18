import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDuration } from '@shared/lib/format-duration';
import { triageChipState } from '../lib/triageChipState';
import { SplitOverlapPanel } from './SplitOverlapPanel';
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
  foreign,
}: ChildStagesProps) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;

  const paused = tree?.paused;
  const canPause = !paused && (tree?.running ?? 0) > 0 && Boolean(onPauseAll);
  const canResume = Boolean(paused) && Boolean(onResumeAll);
  const split = tree?.split;

  return (
    <div className={styles.card} data-child-hub>
      <div className={styles.head}>
        <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
          {t('chat.cascade.hub.title', { count: groups.length })}
        </Typography>
        {/* Итог разбора — одной фишкой: применён, не получен, ещё идёт. Что
            панель в нём поправила, видно по наведению: это оправдание её
            самоуправства, а не новость. */}
        {split && <TriageChip triage={split.triage} />}
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
      </div>

      {groups.map((group) =>
        group.chatId ? (
          <button
            key={group.chatId}
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
                  question={group.hold.question}
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
    </div>
  );
}

/**
 * Итог разбора одной фишкой: идёт, применён, не получен, оборван перезапуском.
 * Что панель в разборе поправила (потерянные задачи, снятые круги ожиданий) —
 * по наведению: это оправдание её самоуправства, а не новость, ради которой
 * стоит занимать строку.
 *
 * Оборванный разбор — отдельная подпись, а не оттенок «не получен»: там группы
 * ПОШЛИ как предложено, здесь они не пошли вовсе и ждут ответа человека.
 */
function TriageChip({ triage }: { triage: SplitPlanView['triage'] }) {
  const { t } = useTranslation();
  const state = triageChipState(triage);
  const label = {
    running: t('chat.cascade.hub.triageRunning'),
    applied: t('chat.cascade.hub.triageApplied'),
    missing: t('chat.cascade.hub.triageMissing'),
    interrupted: t('chat.cascade.hub.triageInterrupted'),
  }[state];
  const repairs = triage?.repairs ?? [];

  return (
    <Typography
      variant="caption"
      color="subtle"
      as="span"
      className={styles.chip}
      data-hub-triage={state}
      title={repairs.join('\n') || undefined}
    >
      {label}
      {repairs.length > 0 ? ` · ${t('chat.cascade.hub.repairs', { count: repairs.length })}` : ''}
    </Typography>
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
  if (group.model) parts.push(group.model);
  if (group.firstEditAfterMs !== undefined) {
    parts.push(
      t('chat.cascade.hub.firstEdit', { time: formatDuration(group.firstEditAfterMs, t) }),
    );
  }
  if (group.workMs !== undefined) {
    parts.push(t('chat.cascade.hub.work', { time: formatDuration(group.workMs, t) }));
  }

  return (
    <Stack gap="0" className={styles.text}>
      <span className={styles.titleLine}>
        <Typography variant="body-sm" as="span" truncate>
          {group.title}
        </Typography>
        {group.isPaused && (
          <Typography variant="caption" color="subtle" as="span" className={styles.chip}>
            {t('chat.cascade.tree.paused')}
          </Typography>
        )}
      </span>
      <Typography variant="caption" color="subtle" as="span" truncate>
        {parts.join(' · ')}
      </Typography>
    </Stack>
  );
}

/** Чего ждёт группа без чата — словами, которые человек может проверить по сводке. */
function pendingText(group: ChildStageGroup, t: TFunction): string {
  switch (group.pending) {
    case 'failed':
      return t('chat.cascade.hub.failed', { message: group.error ?? '' });
    case 'held':
      return t('chat.cascade.hub.held');
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
