import { useTranslation } from 'react-i18next';
import type { BoardLimits, BoardReply } from '@agentdeck/contracts/core/board';
import { shortGroupId } from '@entities/CoreTask';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';

interface BoardToolbarProps {
  limits: BoardLimits;
  /** Жалобы настройки ядра, из-за которых пределы — умолчания (`BoardReply.configIssues`). */
  configIssues?: BoardReply['configIssues'];
  /** Сколько карточек ждут человека — флаг ядра (`waitingCount`), не пересчёт вопросов. */
  waiting: number;
  waitingOnly: boolean;
  onWaitingOnly: (on: boolean) => void;
  lanes: boolean;
  onLanes: (on: boolean) => void;
  groups: readonly string[];
  group: string | undefined;
  onGroup: (group: string | undefined) => void;
}

/** Чип отбора: кнопка-переключатель, нажатое состояние видно и диктору (`aria-pressed`). */
function Chip({
  on,
  onClick,
  children,
  data,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
  data: Record<string, string>;
}) {
  return (
    <Button
      size="sm"
      variant={on ? 'primary' : 'secondary'}
      aria-pressed={on}
      onClick={onClick}
      {...data}
    >
      {children}
    </Button>
  );
}

/**
 * Пределы выше — умолчания, а не настройка человека: раздел `board` не принят или настройка не
 * читается. Ядро называет причину; молча показать умолчания значило бы выдать их за его выбор.
 */
function ConfigIssues({ issues }: { issues: BoardToolbarProps['configIssues'] }) {
  const { t } = useTranslation();
  if (!issues || issues.length === 0) return null;
  const unreadable = issues.some((i) => i.section === '*');
  const reason = issues.map((i) => i.reason).join('; ');
  return (
    <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap role="status">
      <Badge tone="warning">{t('coreBoard.limits.defaultsBadge')}</Badge>
      <Typography variant="caption" as="span" data-board-config-issues>
        {t(unreadable ? 'coreBoard.limits.configUnreadable' : 'coreBoard.limits.configIssues', {
          reason,
        })}
      </Typography>
    </Stack>
  );
}

/**
 * Над доской: пределы (сколько в работе и стартов за сутки, пауза, остановка по умолчанию) и
 * отбор — «Ждёт вас», полосы групп и чипы групп (D13: так страница групп живёт на доске).
 */
export function BoardToolbar(props: BoardToolbarProps) {
  const { t } = useTranslation();
  const { limits } = props;
  const L = 'coreBoard.limits';
  const F = 'coreBoard.filters';
  return (
    <Stack gap="var(--spacing-xs)">
      <Stack
        direction="row"
        gap="var(--spacing-xs)"
        align="center"
        wrap
        role="group"
        aria-label={t(`${L}.label`)}
        data-board-limits
      >
        <Badge tone="neutral">
          {t(`${L}.inWork`, { used: limits.inWork.used, cap: limits.inWork.cap })}
        </Badge>
        <Badge tone="neutral">
          {limits.perDay.cap === null
            ? t(`${L}.perDayFree`, { used: limits.perDay.used })
            : t(`${L}.perDay`, { used: limits.perDay.used, cap: limits.perDay.cap })}
        </Badge>
        {limits.paused && <Badge tone="warning">{t(`${L}.paused`)}</Badge>}
        {limits.stopOnQuestion && <Badge tone="info">{t(`${L}.stopOnQuestion`)}</Badge>}
        <Typography variant="caption" color="subtle" as="span">
          {t(`${L}.defaultStop`, { stop: t(`coreBoard.stops.${limits.defaultStop}`) })}
        </Typography>
      </Stack>
      <ConfigIssues issues={props.configIssues} />
      <Stack
        direction="row"
        gap="var(--spacing-xs)"
        align="center"
        wrap
        role="group"
        aria-label={t(`${F}.label`)}
      >
        <Chip
          on={props.waitingOnly}
          onClick={() => props.onWaitingOnly(!props.waitingOnly)}
          data={{ 'data-board-filter': 'waiting', 'data-board-waiting': String(props.waiting) }}
        >
          {t(`${F}.waiting`, { count: props.waiting })}
        </Chip>
        <Chip
          on={props.lanes}
          onClick={() => props.onLanes(!props.lanes)}
          data={{ 'data-board-filter': 'lanes' }}
        >
          {t(`${F}.lanes`)}
        </Chip>
        {props.groups.map((id) => (
          <Chip
            key={id}
            on={props.group === id}
            onClick={() => props.onGroup(props.group === id ? undefined : id)}
            data={{ 'data-board-group-chip': id }}
          >
            {t(`${F}.group`, { id: shortGroupId(id) })}
          </Chip>
        ))}
      </Stack>
    </Stack>
  );
}
