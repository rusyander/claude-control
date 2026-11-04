import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { useTickingNow } from '../../lib/useTickingNow';
import { HubSummary } from '../HubSummary/HubSummary';
import { RetiredChats } from '../RetiredChats/RetiredChats';
import { GroupCard } from '../GroupCard/GroupCard';
import type { ChildStagesProps } from '../ChildStages.types';
import styles from './ChildStages.module.scss';
import { hubCardKey } from '../../lib/hubCardKey';
import { orderHubGroups } from '../../lib/orderHubGroups';
import { countedGroups } from '../../lib/countedGroups';

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
 * Действий два: открыть звено (в этом же окне — каталог у разговора свой,
 * вкладка копии не нужна) и остановить или продолжить ВСЁ дерево разом. Разом —
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
  sectionsOpen = false,
  foreign,
  providerId,
  questions,
  onAnswer,
  permissions,
  onPermissionDecide,
}: ChildStagesProps) {
  const { t } = useTranslation();
  // Время групп тикает, только пока что-то идёт.
  const now = useTickingNow(groups.some((group) => group.isRunning));
  if (groups.length === 0) return null;

  // Отброшенные перезапуском чаты (L20) — не группы: ни в счёт, ни в строки.
  const retired = groups.filter((group) => group.retired);
  // В работе — сверху, законченные — ниже (G2): ждущая ответа группа не тонет
  // под доставленными.
  const live = orderHubGroups(groups.filter((group) => !group.retired));
  const paused = tree?.paused;
  const canPause = !paused && (tree?.running ?? 0) > 0 && Boolean(onPauseAll);
  const canResume = Boolean(paused) && Boolean(onResumeAll);

  return (
    <div className={styles.card} data-child-hub>
      <div className={styles.head}>
        <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
          {/* Считаются группы: строка разбора — общая, не группа (L37: «12
              групп» при одиннадцати). */}
          {t('chat.cascade.hub.title', { count: countedGroups(groups).length })}
        </Typography>
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

      <HubSummary groups={live} now={now} />

      {/* Карточки групп — с отступом друг от друга: кнопки каждой живут в её
          карточке и не читаются кнопками соседней (владелец 05.10). */}
      <div className={styles.groups}>
        {live.map((group) => (
          <GroupCard
            key={hubCardKey(group)}
            group={group}
            {...(providerId ? { providerId } : {})}
            onOpen={onOpen}
            {...(onAnswer && group.chatId && questions?.has(group.chatId)
              ? { questions: questions.get(group.chatId), onAnswer }
              : {})}
            {...(onPermissionDecide && group.chatId && permissions?.has(group.chatId)
              ? { permissions: permissions.get(group.chatId), onPermissionDecide }
              : {})}
          />
        ))}
      </div>

      {/* Под карточками групп — то, что осталось человеку: шаги и тикеты групп.
          Всё под карточками групп свёрнуто до заголовков (владелец 22.10.2026). */}

      <RetiredChats chats={retired} onOpen={onOpen} defaultExpanded={sectionsOpen} />
    </div>
  );
}
