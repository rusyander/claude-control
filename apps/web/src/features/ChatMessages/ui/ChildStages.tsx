import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { countedGroups, triageElapsedMs, triageLive } from '../lib/hubSummary';
import { useTickingNow } from '../lib/useTickingNow';
import { SplitOverlapPanel } from './SplitOverlapPanel';
import { PlanCancel } from './PlanCancel';
import { HubSummary } from './HubSummary';
import { RetiredChats } from './RetiredChats';
import { GroupCard } from './GroupCard';
import { SplitFollowUps } from './SplitFollowUps';
import { TriageChip } from './TriageChip';
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

      {/* Карточки групп — с отступом друг от друга: кнопки каждой живут в её
          карточке и не читаются кнопками соседней (владелец 05.10). */}
      <div className={styles.groups}>
        {live.map((group) => (
          <GroupCard
            key={group.chatId ?? group.title}
            group={group}
            {...(split?.parentChatId ? { parentChatId: split.parentChatId } : {})}
            onOpen={onOpen}
            {...(onAnswerHold ? { onAnswerHold } : {})}
            {...(holdBusy !== undefined ? { holdBusy } : {})}
            {...(onRelease ? { onRelease } : {})}
            {...(releaseBusy !== undefined ? { releaseBusy } : {})}
            {...(onResumeInterrupted ? { onResumeInterrupted } : {})}
            {...(resumeInterruptedBusy !== undefined ? { resumeInterruptedBusy } : {})}
          />
        ))}
      </div>

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
