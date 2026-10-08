import type { ProjectTestDraftItem } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { stepText } from '@agentdeck/contracts/test-format';
import { Stack } from '@shared/ui/stack';
import styles from './DraftRow.module.scss';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';

/** Одно предложение: что за кейс, зачем он и на что похож. */
export function DraftRow({
  item,
  isPicked,
  onToggle,
}: {
  item: ProjectTestDraftItem;
  isPicked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const steps = item.testCase.steps.map((step) => stepText(step)).join(' → ');

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.historyRow}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Toggle
          size="sm"
          checked={isPicked}
          onCheckedChange={onToggle}
          aria-label={t('tests.drafts.pick', { title: item.testCase.title })}
        />
        <Typography variant="body" weight="medium" as="span">
          {item.testCase.title}
        </Typography>
        <Badge tone={item.op === 'add' ? 'success' : 'info'}>
          {t(item.op === 'add' ? 'tests.drafts.opAdd' : 'tests.drafts.opUpdate')}
        </Badge>
        <Typography variant="mono" color="subtle" as="span">
          {item.groupId} / {item.caseId}
        </Typography>
      </Stack>

      {item.reason && (
        <Typography variant="caption" color="subtle">
          {item.reason}
        </Typography>
      )}

      {/* Автоприёмка оставила правку человеку: без причины на экране галочка
          выглядит неработающей. */}
      {item.hold && (
        <Typography variant="caption" color="warning">
          {t('tests.drafts.hold', { reason: item.hold })}
        </Typography>
      )}

      {steps && (
        <Typography variant="caption" color="muted">
          {steps}
        </Typography>
      )}

      {/* Похожий кейс — главное, ради чего это окно и открывают: без него
          третья генерация подряд кладёт в набор третий «Вход с пустым паролем». */}
      {item.similarTo?.map((similar) => (
        <Typography key={similar.caseId} variant="caption" color="warning">
          {t('tests.drafts.similar', {
            caseId: similar.caseId,
            title: similar.title,
            percent: Math.round(similar.score * 100),
          })}
        </Typography>
      ))}
    </Stack>
  );
}
