import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { renderDocumentMarkdown } from '../../../shared/lib/markdown/renderDocumentMarkdown';
import { SEVERITY_TONE, VERDICT_TONE } from '../model/filters';
import type { WatcherReportSectionProps } from './WatcherReportSection.types';
import styles from './WatcherReportSection.module.scss';

/**
 * Один раздел отчёта: номер и заголовок, метки, место в коде, сколько раз и
 * когда повторялось. Тело — тот же Markdown, что в файле, — свёрнуто: в отчёте
 * десятки разделов, и раскрытые все сразу превращали страницу в простыню.
 */
export function WatcherReportSection({ section }: WatcherReportSectionProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const html = useMemo(
    () => (open ? renderDocumentMarkdown(section.body) : ''),
    [open, section.body],
  );

  return (
    <Card padding="md" data-watch-section={section.ref} data-watch-verdict={section.verdict}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="caption" weight="medium" color="subtle" as="span">
            {section.ref}
          </Typography>
          <Typography variant="body" weight="medium" as="h2" className={styles.title}>
            {section.title}
          </Typography>
        </Stack>
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Badge tone={VERDICT_TONE[section.verdict]}>
            {t(`watcher.page.verdict.${section.verdict}`)}
          </Badge>
          <Badge tone={SEVERITY_TONE[section.severity]}>
            {t(`watcher.page.severity.${section.severity}`)}
          </Badge>
          <Badge>{t(`watcher.page.entryClass.${section.entryClass}`)}</Badge>
          <Typography variant="caption" color="subtle" as="span">
            {t('watcher.page.count', { count: section.count })}
          </Typography>
        </Stack>
        {section.location && (
          <Typography variant="caption" color="muted" as="span" className={styles.location}>
            {t('watcher.page.location')}: <code className={styles.code}>{section.location}</code>
          </Typography>
        )}
        <Typography variant="caption" color="subtle" as="span">
          {t('watcher.page.seen', {
            first: formatDateTime(section.first, i18n.language),
            last: formatDateTime(section.last, i18n.language),
          })}
        </Typography>
        {section.body.trim() && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              data-watch-expand
            >
              {open ? t('watcher.page.collapse') : t('watcher.page.expand')}
            </Button>
          </div>
        )}
        {open && (
          <div className={styles.body} data-watch-body dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </Stack>
    </Card>
  );
}
