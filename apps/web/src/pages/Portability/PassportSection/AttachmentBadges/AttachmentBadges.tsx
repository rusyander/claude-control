import type { SkillItem } from '@agentdeck/contracts/portable-env';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';

export function AttachmentBadges({
  attachments,
  skipped,
}: {
  attachments: number;
  skipped: SkillItem['attachmentsSkipped'];
}) {
  const { t } = useTranslation();

  return (
    <>
      {attachments > 0 && (
        <Badge tone="neutral">{t('portability.attachments', { count: attachments })}</Badge>
      )}
      {skipped.map((skip) => (
        <Badge key={skip.path} tone="warning">
          {`${skip.path} — ${t(`portability.attachmentSkip.${skip.reason}`, skip.reason)}`}
        </Badge>
      ))}
    </>
  );
}
