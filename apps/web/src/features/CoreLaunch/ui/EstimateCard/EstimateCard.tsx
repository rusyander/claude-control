import { useTranslation } from 'react-i18next';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';

interface EstimateCardProps {
  reply: EstimateReply;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="caption" color="muted" as="span">
        {label}
      </Typography>
      <Typography variant="body" weight="medium" as="span">
        {value}
      </Typography>
    </Stack>
  );
}

/**
 * Числа оценки и состояние созданной задачи. Истории нет — «неизвестно», а не ноль: ядро чисел
 * не придумывает (03 §Economy), и экран тоже.
 */
export function EstimateCard({ reply }: EstimateCardProps) {
  const { t, i18n } = useTranslation();
  const P = 'coreLaunch.estimate';
  const num = (n: number) => n.toLocaleString(i18n.language);
  const { minutes, tokens, spread, basis } = reply.estimate;
  return (
    <LaunchSection title={t(`${P}.heading`)} name="estimate">
      <Stack gap="var(--spacing-sm)" data-estimate-state={reply.state}>
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone={reply.state === 'refused' ? 'danger' : 'info'} withDot>
            {t(`${P}.state.${reply.state}`)}
          </Badge>
          <Typography variant="caption" color="muted" as="span" className={styles.mono}>
            {t(`${P}.task`, { id: reply.taskId })}
          </Typography>
          {reply.replayed && <Badge tone="neutral">{t(`${P}.replayed`)}</Badge>}
        </Stack>
        <div className={styles.facts}>
          <Fact
            label={t(`${P}.minutes`)}
            value={
              minutes === null ? t(`${P}.unknown`) : t(`${P}.minutesValue`, { value: num(minutes) })
            }
          />
          <Fact
            label={t(`${P}.tokens`)}
            value={tokens === null ? t(`${P}.unknown`) : num(tokens)}
          />
          <Fact
            label={t(`${P}.spread`)}
            value={
              spread === null
                ? t(`${P}.unknown`)
                : t(`${P}.spreadValue`, { low: num(spread[0]), high: num(spread[1]) })
            }
          />
        </div>
        <Typography variant="caption" color="muted" as="p" data-estimate-basis={basis}>
          {t(`${P}.basis.${basis}`)}
        </Typography>
        {reply.problems.length > 0 && (
          <Stack gap="var(--spacing-3xs)" data-estimate-problems>
            <Typography variant="body-sm" weight="medium" as="span">
              {t(`${P}.problems`)}
            </Typography>
            {reply.problems.map((p) => (
              <Typography key={p} variant="caption" color="danger" as="p">
                {p}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>
    </LaunchSection>
  );
}
