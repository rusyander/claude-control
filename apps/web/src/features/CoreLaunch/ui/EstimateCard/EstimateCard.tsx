import { useTranslation } from 'react-i18next';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';
import { EstimateLead } from './EstimateLead';

interface EstimateCardProps {
  reply: EstimateReply;
  /** Ключ репозитория задачи из ленты (для «Настроить для этого проекта»); нет — `null`. */
  repoKey?: string | null;
  onLeadScope?: (repoKey: string) => void;
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
 * Группа оценки (W3-18): ядро создало задачу на пункт с общим `groupId`. Ответ — первой задачи
 * группы, поэтому экран называет все задачи группы со ссылкой на ленту каждой: остальные человек
 * ведёт оттуда. Блок есть при любом сценарии, не только у ведущего.
 */
function EstimateGroup({ group }: { group: NonNullable<EstimateReply['group']> }) {
  const { t } = useTranslation();
  const P = 'coreLaunch.estimate';
  return (
    <Stack gap="var(--spacing-3xs)" data-estimate-group={group.groupId}>
      <Typography variant="body-sm" weight="medium" as="span">
        {t(`${P}.group`, { id: group.groupId, count: group.taskIds.length })}
      </Typography>
      <Typography variant="caption" color="muted" as="p">
        {t(`${P}.groupHint`)}
      </Typography>
      <ol className={styles.plainList}>
        {group.taskIds.map((id, i) => (
          <li key={id} data-estimate-group-task={id}>
            <a
              href={`${CORE_TASKS_ROUTE}?id=${encodeURIComponent(id)}`}
              className={styles.feedLink}
            >
              {/* Цвет акцента темы, как у ссылок группы на карточке запуска: синий браузера в
                  тёмной теме не читается. */}
              <Typography variant="caption" as="span" color="accent" className={styles.mono}>
                {t(`${P}.groupTask`, { n: i + 1, id })}
              </Typography>
            </a>
          </li>
        ))}
      </ol>
    </Stack>
  );
}

/**
 * Числа оценки и состояние созданной задачи. Истории нет — «неизвестно», а не ноль: ядро чисел
 * не придумывает (03 §Economy), и экран тоже.
 */
export function EstimateCard({ reply, repoKey = null, onLeadScope }: EstimateCardProps) {
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
        {reply.lead && <EstimateLead lead={reply.lead} repoKey={repoKey} onScope={onLeadScope} />}
        {reply.group && <EstimateGroup group={reply.group} />}
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
