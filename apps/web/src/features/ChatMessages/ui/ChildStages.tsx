import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import type { ChildStagesProps } from './ChildStages.types';
import styles from './ChildStages.module.scss';

/**
 * Сводка групп разделения в родительском разговоре: кто на каком звене и чем
 * ведётся.
 *
 * Зачем отдельная карточка, когда есть список чатов: список показывает
 * РАЗГОВОРЫ, а конвейер добавил каждой группе до трёх, и понять по девяти
 * строкам, на чём стоят три группы, нельзя. Здесь одна строка — одна группа, и
 * пройденные звенья подписаны подряд: «работа › ревью» читается за секунду.
 *
 * Карточка не решает ничего и ничего не спрашивает — этим она отличается от
 * соседних карточек вопросов и прав. Единственное действие: открыть звено, и то
 * в этом же окне, потому что каталог у разговора свой и вкладка копии не нужна.
 */
export function ChildStages({ groups, onOpen }: ChildStagesProps) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;

  return (
    <div className={styles.card}>
      <Typography variant="caption" color="subtle" as="div" className={styles.head}>
        {t('chat.cascade.hub.title', { count: groups.length })}
      </Typography>

      {groups.map((group) => (
        <button
          key={group.chatId}
          type="button"
          className={styles.row}
          onClick={() => onOpen(group.chatId)}
        >
          {/* Идущий прогон пульсирует, законченное звено стоит ровно: работает
              группа или ждёт человека — первое, что тут спрашивают. */}
          <StatusDot
            tone={group.isRunning ? 'success' : 'neutral'}
            pulse={group.isRunning}
            label={t(group.isRunning ? 'chat.cascade.hub.running' : 'chat.cascade.hub.idle')}
          />

          <Stack gap="0" className={styles.text}>
            <Typography variant="body-sm" as="span" truncate>
              {group.title}
            </Typography>
            <Typography variant="caption" color="subtle" as="span" truncate>
              {group.branch ? `${group.branch} · ` : ''}
              {group.stages.map((stage) => t(`chat.cascade.stageFull.${stage}`)).join(' › ')}
              {group.model ? ` · ${group.model}` : ''}
            </Typography>
          </Stack>
        </button>
      ))}
    </div>
  );
}
