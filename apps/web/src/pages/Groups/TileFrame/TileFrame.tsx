import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { TileFrameProps } from './TileFrame.types';
import styles from './TileFrame.module.scss';

/**
 * Карточка сетки групп: имя, метки, «Когда», тело (что группа делает и из
 * чего состоит), числа и предупреждение — всегда на одних и тех же местах,
 * чтобы глаз находил их без чтения. С `onOpen` имя — кнопка, открывающая окно, и
 * её цель растянута на всю карточку; без него (сетка прежних групп только для
 * чтения) имя — просто текст. Действия (`aside`) — отдельные остановки Tab.
 */
export function TileFrame({
  name,
  onOpen,
  badges,
  when,
  whenEmpty,
  whenLabel,
  children,
  counts,
  warnings = [],
  aside,
  anchor,
  anchorAlias,
}: TileFrameProps) {
  return (
    <article
      className={styles.tile}
      data-agent-anchor={anchor}
      data-agent-anchor-alias={anchorAlias}
    >
      <div className={styles.head}>
        <Typography variant="body" weight="medium" as="h3" className={styles.name}>
          {onOpen ? (
            <button type="button" className={styles.open} onClick={onOpen}>
              {name}
            </button>
          ) : (
            name
          )}
        </Typography>
        {aside && <div className={styles.aside}>{aside}</div>}
      </div>
      <div className={styles.badges}>{badges}</div>
      <Typography variant="body-sm" color={when ? 'muted' : 'subtle'} className={styles.when}>
        <span className={styles.whenLabel}>{whenLabel}: </span>
        {when || whenEmpty}
      </Typography>
      {children && <div className={styles.body}>{children}</div>}
      <Typography variant="caption" color="subtle" as="p" className={styles.counts}>
        {counts}
      </Typography>
      {warnings.length > 0 && (
        <div className={styles.warnings}>
          {warnings.map((warning) => (
            <Typography key={warning} variant="caption" as="p" className={styles.warning}>
              <Icon name="warning" size={16} />
              <span>{warning}</span>
            </Typography>
          ))}
        </div>
      )}
    </article>
  );
}
