import { Fragment } from 'react';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import styles from './diagram.module.scss';
import type { FlowDiagramProps } from './diagram.types';

/**
 * Путь данных: узлы со стрелками между ними. Схема — это упорядоченный
 * список шагов, поэтому размечена как <ol>: скринридер прочитает её по
 * порядку, а стрелки остаются оформлением и от него скрыты.
 *
 * На узком экране строка сама переходит в колонку, и стрелки поворачиваются
 * вниз — отдельного мобильного варианта не нужно.
 */
export function FlowDiagram({ nodes, edgeLabels, ariaLabel, className }: FlowDiagramProps) {
  return (
    <ol className={[styles.flow, className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      {nodes.map((node, index) => (
        <Fragment key={node.id}>
          {index > 0 && (
            <li className={styles.edge} aria-hidden="true">
              <span className={styles.edgeLine} />
              {edgeLabels?.[index - 1] && (
                <Typography variant="caption" color="subtle" as="span" className={styles.edgeLabel}>
                  {edgeLabels[index - 1]}
                </Typography>
              )}
            </li>
          )}

          <li className={`${styles.node} ${styles[`tone-${node.tone ?? 'neutral'}`]}`}>
            {node.icon && <Icon name={node.icon} size={24} className={styles.nodeIcon} />}
            <Typography
              variant={node.isMono ? 'mono' : 'body-sm'}
              weight="medium"
              as="span"
              className={styles.nodeLabel}
            >
              {node.label}
            </Typography>
            {node.caption && (
              <Typography variant="caption" color="muted" as="span" className={styles.nodeCaption}>
                {node.caption}
              </Typography>
            )}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
