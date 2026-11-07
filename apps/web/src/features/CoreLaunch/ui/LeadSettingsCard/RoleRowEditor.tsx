import { useTranslation } from 'react-i18next';
import type {
  LeadRole,
  LeadSettingsPatch,
  LeadSource,
  RoleRow,
} from '@agentdeck/contracts/core/lead';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import {
  LEAD_EFFORTS,
  LEAD_MODELS,
  LEAD_TIERS,
  withoutRole,
  withRoleField,
} from '../../model/leadSettings';
import styles from './LeadSettingsCard.module.scss';

interface RoleRowEditorProps {
  role: LeadRole;
  /** Действующая строка роли. */
  row: RoleRow;
  source: LeadSource;
  /** Строка задана правкой этого уровня — её можно вернуть профилю. */
  overridden: boolean;
  patch: LeadSettingsPatch;
  disabled: boolean;
  onPatch: (next: LeadSettingsPatch) => void;
}

/** Варианты с действующим значением, даже если реестр его не знает: значение не пропадает молча. */
const withCurrent = (list: readonly string[], current: string | undefined): string[] =>
  current && !list.includes(current) ? [...list, current] : [...list];

/**
 * Строка роли: ступень лестницы, усилие (без `max` — его ядро не выбирает) и модель — только
 * явный выбор человека, по умолчанию модель ступени. Строка пишется целиком, как её читает ядро.
 */
export function RoleRowEditor({
  role,
  row,
  source,
  overridden,
  patch,
  disabled,
  onPatch,
}: RoleRowEditorProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.lead';
  const name = t(`${P}.role.${role}`);
  const set = (field: 'tier' | 'effort' | 'model') => (value: string) =>
    onPatch(withRoleField(patch, row, role, field, value));
  return (
    <div className={styles.roleRow} data-lead-role={role} data-lead-role-source={source}>
      <span className={styles.roleName}>
        <Typography variant="body-sm" weight="medium" as="span">
          {name}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`${P}.fromSource.${source}`)}
        </Typography>
      </span>
      <select
        className={styles.select}
        aria-label={t(`${P}.tierLabel`, { role: name })}
        value={row.tier}
        disabled={disabled}
        onChange={(e) => set('tier')(e.target.value)}
        data-lead-role-tier
      >
        {LEAD_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {t(`${P}.tier.${tier}`)}
          </option>
        ))}
      </select>
      <select
        className={styles.select}
        aria-label={t(`${P}.effortLabel`, { role: name })}
        value={row.effort ?? ''}
        disabled={disabled}
        onChange={(e) => set('effort')(e.target.value)}
        data-lead-role-effort
      >
        <option value="">{t(`${P}.effortDefault`)}</option>
        {withCurrent(LEAD_EFFORTS, row.effort).map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <select
        className={styles.select}
        aria-label={t(`${P}.modelLabel`, { role: name })}
        value={row.model ?? ''}
        disabled={disabled}
        onChange={(e) => set('model')(e.target.value)}
        data-lead-role-model
      >
        <option value="">{t(`${P}.modelDefault`)}</option>
        {withCurrent(LEAD_MODELS, row.model).map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      {overridden ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPatch(withoutRole(patch, role))}
          disabled={disabled}
          aria-label={t(`${P}.roleResetLabel`, { role: name })}
          data-lead-role-reset
        >
          {t(`${P}.roleReset`)}
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}
