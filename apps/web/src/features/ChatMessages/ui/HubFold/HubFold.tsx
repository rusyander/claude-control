import { useState } from 'react';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { HubFoldProps } from './HubFold.types';
import styles from './HubFold.module.scss';

/**
 * Свёрнутый раздел хаба под карточками групп (владелец 22.10.2026): шаги
 * человеку, предложенные тикеты, неактивные чаты. Развёрнутыми они занимали
 * хаб целиком, и карточки групп — то, ради чего на хаб смотрят, — уезжали за
 * экран. Заголовок с числом виден всегда, содержимое — по нажатию на него.
 */
export function HubFold({
  title,
  hint,
  defaultExpanded = false,
  tone,
  actions,
  children,
}: HubFoldProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toggle = (
    <button
      type="button"
      className={styles.toggle}
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
      data-hub-fold={expanded ? 'open' : 'closed'}
      {...(hint ? { title: hint } : {})}
    >
      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />
      <Typography variant="caption" color={tone ?? 'subtle'} as="span">
        {title}
      </Typography>
    </button>
  );

  return (
    <>
      {actions ? (
        <div className={styles.head}>
          {toggle}
          <div className={styles.actions}>{actions}</div>
        </div>
      ) : (
        toggle
      )}
      {expanded && children}
    </>
  );
}
