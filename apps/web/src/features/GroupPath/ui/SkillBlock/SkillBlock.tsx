import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { TypeChip } from '../TypeChip/TypeChip';
import type { SkillBlockProps } from './SkillBlock.types';
import styles from './SkillBlock.module.scss';

/**
 * Шаги одного скилла одним блоком: заголовок — имя скилла, вид, сколько шагов
 * и что с его числами; тело сворачивается. Свёрнутый блок у длинного пути —
 * главный способ его прочитать: двадцать шагов скилла сжимаются в одну строку.
 * Свои шаги, вставленные внутрь скилла, живут в том же блоке — они идут в том
 * же ходе, что и скилл.
 */
export function SkillBlock({
  title,
  type,
  count,
  knobsText,
  isOpen,
  onToggle,
  children,
}: SkillBlockProps) {
  const { t } = useTranslation();
  // useId, а не id скилла: «a.b» и «a_b» после замены знаков совпадали, и
  // заголовок одного блока управлял телом другого.
  const bodyId = useId();
  return (
    <li className={styles.block}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          aria-label={`${t('groupBuilder.block.toggle', { title })}, ${t('groupBuilder.block.steps', { count })}`}
          onClick={onToggle}
        >
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={16} />
          <span className={styles.title}>{title}</span>
          <span className={styles.count}>{t('groupBuilder.block.steps', { count })}</span>
        </button>
        <TypeChip type={type} />
        <span className={styles.knobs}>{knobsText}</span>
      </div>
      <ol id={bodyId} className={styles.body} hidden={!isOpen}>
        {children}
      </ol>
    </li>
  );
}
