import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { overlapFold } from '../lib/overlapFold';
import type { SplitOverlapPanelProps } from './SplitOverlapPanel.types';
import styles from './ChildStages.module.scss';
import own from './SplitOverlapPanel.module.scss';

/**
 * Пересечения веток разделения (Т6) — разделом в сводке групп.
 *
 * Разбор уровня 1 разводит группы по владениям ЗАРАНЕЕ, и заранее же ошибается:
 * узнаётся это при слиянии, когда переделывать дорого. Здесь показано, что
 * ветки задели на самом деле: файл — какие группы, и красным те, у кого он вне
 * объявленного владения.
 *
 * Длинный список свёрнут (см. `overlapFold`): число файлов и число «вне
 * владения» видны в свёрнутом виде, сами строки — по нажатию на заголовок.
 *
 * Панель ничего не сливает и не правит — это решение владельца, и раздел его не
 * пересматривает: порядок из `after` здесь подсказка, а не кнопка.
 */
export function SplitOverlapPanel({
  overlap,
  titleOf,
  onCheck,
  busy,
  defaultExpanded = false,
}: SplitOverlapPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Считать нечего и не считали — раздела нет вовсе: пустая строка «пересечений
  // нет» до первой сверки означала бы, что панель что-то проверила.
  if (!overlap && !onCheck) return null;

  const files = overlap?.files ?? [];
  const order = overlap?.mergeOrder ?? [];
  const outsideCount = files.filter((file) => file.outside.length > 0).length;
  const fold = overlapFold(files.length, expanded);
  // Метка для проверок и QA-скриптов; у короткого списка сворачивать нечего.
  let foldMark: 'open' | 'closed' | undefined;
  if (fold.foldable) foldMark = fold.showRows ? 'open' : 'closed';
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
    <div
      className={styles.overlap}
      data-hub-overlap={overlap ? 'checked' : 'idle'}
      data-overlap-fold={foldMark}
    >
      <div className={styles.overlapHead}>
        {/* Заголовок и есть переключатель: число файлов в нём видно и в
            свёрнутом виде, а отдельная кнопка «показать» рядом с ним только
            удлиняла бы и без того тесную строку со «Сверить ветки». */}
        {fold.foldable ? (
          <button
            type="button"
            className={own.toggle}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={fold.showRows}
            title={t(
              fold.showRows ? 'chat.cascade.overlap.collapse' : 'chat.cascade.overlap.expand',
            )}
          >
            <Icon name={fold.showRows ? 'chevronDown' : 'chevronRight'} size={16} />
            <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
              {headline}
            </Typography>
          </button>
        ) : (
          <Typography variant="caption" color="subtle" as="span" className={styles.headText}>
            {headline}
          </Typography>
        )}
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

      {/* Свёрнутым раздел не прячет единственное красное: файлы вне владения —
          это нарушенные границы разбора, о них надо знать, не раскрывая список. */}
      {!fold.showRows && outsideCount > 0 && (
        <Typography variant="caption" color="danger" as="div" className={own.outsideCount}>
          {t('chat.cascade.overlap.outsideCount', { count: outsideCount })}
        </Typography>
      )}

      {fold.showRows &&
        files.map((file) => (
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
          человек, панель веток не трогает. Одна группа порядка не имеет.
          Строкой-блоком: строчными элементами порядок и «Не прочитано» ниже
          слипались в одно предложение («…страницыНе прочитано»). */}
      {order.length > 1 && (
        <Typography variant="caption" color="subtle" as="div">
          {t('chat.cascade.overlap.mergeOrder', { names: order.map(titleOf).join(' → ') })}
        </Typography>
      )}

      {/* Ветка, которую прочитать не удалось, — не «пересечений нет»: молчать об
          этом значило бы выдать неполный счёт за полный. */}
      {(overlap?.unread ?? []).length > 0 && (
        <Typography variant="caption" color="subtle" as="div" data-overlap-unread>
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
