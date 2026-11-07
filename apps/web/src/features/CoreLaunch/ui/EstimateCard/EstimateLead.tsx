import { useTranslation } from 'react-i18next';
import { LEAD_ROLES } from '@agentdeck/contracts/core/lead';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreConfig } from '../../api/launchApi';
import { estimateRoles } from '../../model/leadSettings';
import styles from '../rows.module.scss';

interface EstimateLeadProps {
  lead: NonNullable<EstimateReply['lead']>;
  /** Ключ репозитория задачи из ленты; пока не пришёл — `null`. */
  repoKey: string | null;
  /** «Настроить для этого проекта»: область карточки ведения — проект задачи. */
  onScope?: (repoKey: string) => void;
}

/**
 * Ведение в ответе оценки (P144): профиль, класс (до разведки не решён), сколько сеансов сразу,
 * ожидание места сеанса и ступени ролей. Ступеней ответ ядра не несёт — их считает тот же
 * резолвер по записанной настройке; срезанное пределом машины названо.
 */
export function EstimateLead({ lead, repoKey, onScope }: EstimateLeadProps) {
  const { t, i18n } = useTranslation();
  const P = 'coreLaunch.leadEstimate';
  const L = 'coreLaunch.lead';
  const config = useCoreConfig();
  const roles = estimateRoles(config.data, repoKey, lead.profile);
  const wait = waitText(lead.sessionWaitMs, (key, value) =>
    t(`${P}.${key}`, value === undefined ? {} : { value: value.toLocaleString(i18n.language) }),
  );
  return (
    <Stack
      gap="var(--spacing-xs)"
      data-estimate-lead
      data-lead-profile={lead.profile}
      data-lead-parallelism={lead.parallelism}
    >
      <Typography variant="body-sm" weight="medium" as="h3">
        {t(`${P}.heading`)}
      </Typography>
      <div className={styles.facts}>
        <Fact label={t(`${P}.profile`)} value={t(`${L}.profiles.${lead.profile}`)} />
        <Fact
          label={t(`${P}.class`)}
          value={lead.class ?? t(`${P}.classPending`)}
          marker="data-estimate-lead-class"
        />
        <Fact label={t(`${P}.parallelism`)} value={String(lead.parallelism)} />
        <Fact label={t(`${P}.wait`)} value={wait} marker="data-estimate-lead-wait" />
      </div>
      {lead.warnings.map((w) => (
        <Typography key={w.field} variant="caption" color="warning" as="p">
          {t(`${L}.parallelismCut`, { asked: w.asked, applied: w.applied })}
        </Typography>
      ))}
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="muted" as="span">
          {t(`${P}.roles`)}
        </Typography>
        <ul className={styles.plainList}>
          {LEAD_ROLES.map((role) => {
            const row = roles[role];
            const params = {
              tier: t(`${L}.tier.${row.tier}`),
              effort: row.effort ?? t(`${L}.effortDefault`),
              model: row.model ?? '',
            };
            return (
              <li key={role} data-estimate-lead-role={role}>
                <Typography variant="caption" as="span">
                  {`${t(`${L}.role.${role}`)}: ${t(row.model ? `${P}.roleRowModel` : `${P}.roleRow`, params)}`}
                </Typography>
              </li>
            );
          })}
        </ul>
      </Stack>
      {onScope && (
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Button
            size="sm"
            variant="secondary"
            disabled={!repoKey}
            onClick={() => {
              if (repoKey) onScope(repoKey);
            }}
            data-lead-scope-this
          >
            {t(`${P}.scopeThis`)}
          </Button>
          {!repoKey && (
            <Typography variant="caption" color="muted" as="span">
              {t(`${P}.scopeWaiting`)}
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Ожидание места сеанса из оценки ядра: `null` — ядро не оценило (нет истории сеансов или мест не
 * прочло), 0 — место свободно, иначе секунды до минуты и минуты дальше.
 */
function waitText(
  ms: number | null,
  say: (key: 'waitUnknown' | 'waitNone' | 'waitValue' | 'waitMinutes', value?: number) => string,
): string {
  if (ms === null) return say('waitUnknown');
  if (ms === 0) return say('waitNone');
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? say('waitValue', seconds) : say('waitMinutes', Math.round(seconds / 60));
}

function Fact({ label, value, marker }: { label: string; value: string; marker?: string }) {
  return (
    <Stack gap="var(--spacing-3xs)" {...(marker ? { [marker]: '' } : {})}>
      <Typography variant="caption" color="muted" as="span">
        {label}
      </Typography>
      <Typography variant="body" weight="medium" as="span">
        {value}
      </Typography>
    </Stack>
  );
}
