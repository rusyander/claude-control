import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { knobId } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { KnobSelect } from '../KnobSelect/KnobSelect';
import { TypeChip } from '../TypeChip/TypeChip';
import type { PathEntryRowProps } from './PathEntryRow.types';
import styles from './PathEntryRow.module.scss';
import { pickLang } from '../../lib/pickLang';
import { RowHint } from './RowHint/RowHint';
import { useHint } from '../../model/useHint';

/**
 * Строка конструктора — компактная, чтобы восемьдесят шагов читались одним
 * экраном: номер, название на языке интерфейса и вид шага — одна кнопка (она
 * открывает окно шага, наведение или фокус показывают подсказку), под ней одна
 * строка «что делает». Числа шага — списками в строке. Свой шаг ещё и
 * переносится за ручку, правится и убирается.
 */
export function PathEntryRow({
  row,
  number,
  words,
  type,
  fallback,
  knobsNote,
  isKnobSaving,
  isDragging,
  dragHandle,
  onOpen,
  onKnob,
  onEdit,
  onRemove,
}: PathEntryRowProps) {
  const { t, i18n } = useTranslation();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hint = useHint(anchorRef);
  // useId, а не ключ строки: «whole:a.b» и «whole:a_b» после замены знаков
  // совпадали, и подсказка одной строки читалась у другой.
  const hintId = useId();
  const step = row.kind === 'entry' && row.entry.kind === 'custom' ? row.entry.step : undefined;
  const gate = step?.gate ? pickLang(step.gate, i18n.language) : '';
  const line = words.isDescribing ? t('groupBuilder.describing') : words.line;

  return (
    <li
      className={`${styles.row} ${styles[`type-${type}`] ?? ''} ${isDragging ? styles.dragging : ''}`}
    >
      {dragHandle ? (
        <button
          type="button"
          className={styles.handle}
          aria-label={t('groupBuilder.drag.handle', { title: words.title })}
          aria-describedby={`${hintId}-drag`}
          title={t('groupBuilder.drag.handleHint')}
          {...dragHandle}
        >
          <Icon name="grip" size={16} />
          <span id={`${hintId}-drag`} hidden>
            {t('groupBuilder.drag.handleHint')}
          </span>
        </button>
      ) : (
        <span className={styles.handleSpace} aria-hidden="true" />
      )}
      <span className={styles.number} aria-hidden="true">
        {number}
      </span>
      <div className={styles.body}>
        <span
          ref={anchorRef}
          className={styles.anchor}
          onMouseEnter={hint.show}
          onMouseLeave={hint.hide}
        >
          <button
            type="button"
            className={styles.open}
            aria-describedby={hintId}
            onClick={onOpen}
            onFocus={hint.show}
            onBlur={hint.hide}
          >
            <span className={styles.title}>{words.title}</span>
            <TypeChip type={type} />
            {step?.needsTranslation && (
              <Badge tone="warning">{t('groupPath.needsTranslation')}</Badge>
            )}
          </button>
          <RowHint id={hintId} isShown={hint.isShown} words={words} fallback={fallback} />
        </span>
        {line && (
          <span className={`${styles.line} ${words.isDescribing ? styles.lineMuted : ''}`}>
            {line}
          </span>
        )}
        {(step?.anchor === 'triage' || gate) && (
          <span className={styles.meta}>
            {step?.anchor === 'triage' && t('groupPath.triageChat')}
            {gate && t('groupPath.gate', { gate })}
          </span>
        )}
        {knobsNote && <span className={styles.meta}>{knobsNote}</span>}
        {row.knobs.length > 0 && (
          <div className={styles.knobs}>
            {row.knobs.map((knob) => (
              <KnobSelect
                key={knobId(knob)}
                knob={knob}
                stepTitle={words.title}
                isSaving={isKnobSaving}
                onChange={(value) => onKnob(knob, value)}
              />
            ))}
          </div>
        )}
      </div>
      {step && (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="edit" size={16} />}
            onClick={() => onEdit(step)}
            aria-label={t('groupPath.edit', { title: words.title })}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="trash" size={16} />}
            onClick={() => onRemove(step)}
            aria-label={t('groupPath.remove', { title: words.title })}
          />
        </div>
      )}
    </li>
  );
}
