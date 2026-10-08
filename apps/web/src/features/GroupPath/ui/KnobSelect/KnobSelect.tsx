import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { KnobSelectProps } from './KnobSelect.types';
import styles from './KnobSelect.module.scss';
import { knobOutOfRange } from '../../model/knobOutOfRange';
import { knobNumbers } from '../../model/knobNumbers';
import { knobLabel } from '../../model/knobLabel';
import { KNOB_AUTO } from '../../model/knobs.constants';
import { knobSelectValue } from '../../model/knobSelectValue';
import { knobEditValue } from '../../model/knobEditValue';

/**
 * Число скилла прямо на строке шага: «Авто (в скилле: N)» и числа от min до
 * max. Выбирают, а не набирают — ошибиться границей нельзя, а «12» не уходит
 * по дороге единицей. Нативный select: клавиатура, дикторы и телефон работают
 * с ним без нашей помощи.
 */
export function KnobSelect({ knob, stepTitle, isSaving, onChange }: KnobSelectProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const label = knobLabel(knob, i18n.language);
  const value = knobSelectValue(knob);
  const outside = knobOutOfRange(knob);
  const outsideOption = outside !== undefined && (
    <option value={String(outside)}>
      {t('groupKnobs.outOfRange', { value: outside, min: knob.min, max: knob.max })}
    </option>
  );

  return (
    <span className={styles.knob}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <select
        id={id}
        className={`${styles.select} ${value === KNOB_AUTO ? '' : styles.pinned}`}
        value={value}
        disabled={isSaving}
        aria-label={t('groupKnobs.selectAria', { label, step: stepTitle })}
        title={t('groupKnobs.autoHint')}
        onChange={(event) => onChange(knobEditValue(event.target.value))}
      >
        <option value={KNOB_AUTO}>{t('groupKnobs.auto', { value: knob.default })}</option>
        {outside !== undefined && outside < knob.min && outsideOption}
        {knobNumbers(knob).map((number) => (
          <option key={number} value={String(number)}>
            {number}
          </option>
        ))}
        {outside !== undefined && outside > knob.max && outsideOption}
      </select>
    </span>
  );
}
