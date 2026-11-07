import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LEAD_ALWAYS_ASK,
  LEAD_PARALLELISM_MAX,
  LEAD_ROLES,
  type LeadSettingsPatch,
  type Promotion,
} from '@agentdeck/contracts/core/lead';
import type { EffectiveLeadSettings } from '@agentdeck/contracts/core/lead-resolve';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import {
  MACHINE_SCOPE,
  withAlwaysAsk,
  withParallelism,
  withPromotion,
  type LeadScope,
} from '../../model/leadSettings';
import { RoleRowEditor } from './RoleRowEditor';
import styles from './LeadSettingsCard.module.scss';

interface LeadAdvancedProps {
  patch: LeadSettingsPatch;
  effective: EffectiveLeadSettings;
  /** Предел машины `queue.sessionSlots`. */
  cap: number;
  scope: LeadScope;
  disabled: boolean;
  onPatch: (next: LeadSettingsPatch) => void;
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  disabled: boolean;
  onChange: (raw: string) => void;
  marker: string;
}) {
  const id = useId();
  // Пока поле в фокусе, в нём набранный текст, а не значение уровня: пустое поле откатилось бы к
  // унаследованному числу, а «0.» — к «0», и набрать «3» поверх «4» или «0.5» было бы нельзя.
  // Ушёл фокус — поле снова показывает действующее значение.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div className={styles.number} {...{ [props.marker]: '' }}>
      <label htmlFor={id} className={styles.numberLabel}>
        {props.label}
      </label>
      <input
        id={id}
        type="number"
        className={styles.numberInput}
        value={typed ?? String(props.value)}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        disabled={props.disabled}
        onFocus={() => setTyped(String(props.value))}
        onBlur={() => setTyped(null)}
        onChange={(e) => {
          setTyped(e.target.value);
          props.onChange(e.target.value);
        }}
      />
    </div>
  );
}

/**
 * Подробности ведения: параллельность с пределом машины, строки ролей (ступень, усилие без `max`,
 * модель — только явный выбор), подъём по обучению и «всегда спрашивать». Значения — действующие;
 * правка пишет поле уровня, остальное остаётся профилю.
 */
export function LeadAdvanced({
  patch,
  effective,
  cap,
  scope,
  disabled,
  onPatch,
}: LeadAdvancedProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.lead';
  const { settings, roleSources, warnings } = effective;
  const own = scope === MACHINE_SCOPE ? 'defaults' : 'project';
  const promotion = settings.promotion;
  const setPromotion = (field: keyof Promotion) => (raw: string) =>
    onPatch(withPromotion(patch, promotion, field, raw));
  return (
    <Stack gap="var(--spacing-sm)" data-lead-advanced-body>
      <Stack gap="var(--spacing-3xs)">
        <NumberField
          label={t(`${P}.parallelism`)}
          value={patch.parallelism ?? settings.parallelism}
          min={1}
          max={Math.min(cap, LEAD_PARALLELISM_MAX)}
          disabled={disabled}
          onChange={(raw) => onPatch(withParallelism(patch, raw))}
          marker="data-lead-parallelism"
        />
        <Typography variant="caption" color="muted" as="p" data-lead-parallelism-cap>
          {t(`${P}.parallelismCap`, { cap })}
        </Typography>
        {warnings.map((w) => (
          <Typography key={w.field} variant="caption" color="warning" as="p" data-lead-warning>
            {t(`${P}.parallelismCut`, { asked: w.asked, applied: w.applied })}
          </Typography>
        ))}
      </Stack>
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium" as="span">
          {t(`${P}.roles`)}
        </Typography>
        <Typography variant="caption" color="muted" as="p">
          {t(`${P}.noMax`)}
        </Typography>
        <div className={styles.roles} role="group" aria-label={t(`${P}.roles`)}>
          {LEAD_ROLES.map((role) => (
            <RoleRowEditor
              key={role}
              role={role}
              row={settings.roles[role]}
              source={roleSources[role]}
              overridden={roleSources[role] === own && patch.roles?.[role] !== undefined}
              patch={patch}
              disabled={disabled}
              onPatch={onPatch}
            />
          ))}
        </div>
      </Stack>
      <fieldset className={styles.group} data-lead-promotion>
        <legend className={styles.legend}>{t(`${P}.promotion`)}</legend>
        <div className={styles.numbers}>
          <NumberField
            label={t(`${P}.promotionThreshold`)}
            value={promotion.threshold}
            min={0.05}
            max={1}
            step={0.05}
            disabled={disabled}
            onChange={setPromotion('threshold')}
            marker="data-lead-promotion-threshold"
          />
          <NumberField
            label={t(`${P}.promotionWindow`)}
            value={promotion.window}
            min={1}
            max={20}
            disabled={disabled}
            onChange={setPromotion('window')}
            marker="data-lead-promotion-window"
          />
          <NumberField
            label={t(`${P}.promotionMinSamples`)}
            value={promotion.minSamples}
            min={1}
            max={promotion.window}
            disabled={disabled}
            onChange={setPromotion('minSamples')}
            marker="data-lead-promotion-min"
          />
        </div>
      </fieldset>
      <fieldset className={styles.group} data-lead-always-ask>
        <legend className={styles.legend}>{t(`${P}.alwaysAsk`)}</legend>
        <Stack direction="row" gap="var(--spacing-sm)" wrap>
          {LEAD_ALWAYS_ASK.map((ask) => (
            <label key={ask} className={styles.check}>
              <input
                type="checkbox"
                checked={settings.alwaysAsk.includes(ask)}
                disabled={disabled}
                onChange={(e) =>
                  onPatch(withAlwaysAsk(patch, settings.alwaysAsk, ask, e.target.checked))
                }
                data-lead-ask={ask}
              />
              {t(`${P}.ask.${ask}`)}
            </label>
          ))}
        </Stack>
      </fieldset>
    </Stack>
  );
}
