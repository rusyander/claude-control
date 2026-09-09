import { useTranslation } from 'react-i18next';
import type { SplitOverlapView } from '@agentdeck/contracts/chat-handoff';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import styles from './ChildStages.module.scss';

/**
 * Пересечения веток разделения (Т6) — разделом в сводке групп.
 *
 * Разбор уровня 1 разводит группы по владениям ЗАРАНЕЕ, и заранее же ошибается:
 * узнаётся это при слиянии, когда переделывать дорого. Здесь показано, что
 * ветки задели на самом деле: файл — какие группы, и красным те, у кого он вне
 * объявленного владения.
 *
 * Панель ничего не сливает и не правит — это решение владельца, и раздел его не
 * пересматривает: порядок из `after` здесь подсказка, а не кнопка.
 */
export function SplitOverlapPanel({
  overlap,
  titleOf,
  onCheck,
  busy,
}: {
  /** Нет — сверки ещё не было: показываем один заголовок с кнопкой. */
  overlap?: SplitOverlapView;
  /** Название группы по её номеру — в пересечениях живут индексы, не имена. */
  titleOf: (index: number) => string;
  /** Пересчитать; нет обработчика — кнопки нет (сверка выключена на сервере). */
  onCheck?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  // Считать нечего и не считали — раздела нет вовсе: пустая строка «пересечений
  // нет» до первой сверки означала бы, что панель что-то проверила.
  if (!overlap && !onCheck) return null;

  const files = overlap?.files ?? [];
  const order = overlap?.mergeOrder ?? [];
  // Три состояния подписи: не считали, посчитали и пусто, посчитали и вот что.
  // Первое от второго отличается принципиально: «пересечений нет» на месте
  // непроверенного — враньё, за которое человек заплатит при слиянии.
  let headline = t('chat.cascade.overlap.idle');
  if (overlap) {
    headline =
      files.length > 0
        ? t('chat.cascade.overlap.title', { count: files.length })
        : t('chat.cascade.overlap.none');
  }

  return (
    <div className={styles.overlap} data-hub-overlap={overlap ? 'checked' : 'idle'}>
      <div className={styles.overlapHead}>
        <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
          {headline}
        </Typography>
        {onCheck && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={busy}
            title={t('chat.cascade.overlap.hint')}
            onClick={onCheck}
          >
            {t('chat.cascade.overlap.check')}
          </Button>
        )}
      </div>

      {files.map((file) => (
        <div
          key={file.path}
          className={`${styles.overlapRow} ${file.outside.length > 0 ? styles.overlapBad : ''}`}
          data-overlap-file={file.outside.length > 0 ? 'outside' : 'shared'}
        >
          <Typography
            variant="caption"
            as="span"
            truncate
            className={styles.overlapPath}
            title={file.path}
          >
            {file.path}
          </Typography>
          <Typography variant="caption" color="subtle" as="span" className={styles.overlapGroups}>
            {file.groups.map(titleOf).join(', ')}
            {file.outside.length > 0
              ? ` · ${t('chat.cascade.overlap.outside', {
                  names: file.outside.map(titleOf).join(', '),
                })}`
              : ''}
          </Typography>
        </div>
      ))}

      {/* Порядок слияния — подсказка из ожиданий разбора, и только: сливает
          человек, панель веток не трогает. Одна группа порядка не имеет. */}
      {order.length > 1 && (
        <Typography variant="caption" color="subtle" as="span">
          {t('chat.cascade.overlap.mergeOrder', { names: order.map(titleOf).join(' → ') })}
        </Typography>
      )}

      {/* Ветка, которую прочитать не удалось, — не «пересечений нет»: молчать об
          этом значило бы выдать неполный счёт за полный. */}
      {(overlap?.unread ?? []).length > 0 && (
        <Typography variant="caption" color="subtle" as="span" data-overlap-unread>
          {t('chat.cascade.overlap.unread', {
            names: (overlap?.unread ?? [])
              .map((item) => `${titleOf(item.index)} (${item.reason})`)
              .join('; '),
          })}
        </Typography>
      )}
    </div>
  );
}
