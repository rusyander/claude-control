import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { PageHeader } from '@shared/ui/page-header';
import { HOOK_EVENT_INFO } from '@claude-control/contracts';
import styles from './HelpPage.module.scss';

/**
 * Справочник по устройству Claude Code. Отдельные пояснения есть в каждом
 * разделе, а здесь собрано то, что нужно целиком: таблица событий хуков
 * и порядок применения настроек.
 */
export function HelpPage() {
  const { t } = useTranslation();

  const concepts = [
    { key: 'rules', title: t('rules.title'), text: t('rules.explain') },
    { key: 'skills', title: t('skills.title'), text: t('skills.explain') },
    { key: 'hooks', title: t('hooks.title'), text: t('hooks.explain') },
    { key: 'mcp', title: t('mcp.title'), text: t('mcp.explain') },
    { key: 'permissions', title: t('permissions.title'), text: t('permissions.explain') },
    { key: 'groups', title: t('groups.title'), text: t('groups.explain') },
  ];

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('nav.help')} subtitle={t('common.appName')} />

      <Stack gap="var(--spacing-sm)">
        {concepts.map((concept) => (
          <Card key={concept.key} padding="md">
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body" weight="medium">
                {concept.title}
              </Typography>
              <Typography variant="body-sm" color="muted" className={styles.text}>
                {concept.text}
              </Typography>
            </Stack>
          </Card>
        ))}
      </Stack>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('hooks.event')}
          </Typography>

          <Stack gap="var(--spacing-xs)">
            {HOOK_EVENT_INFO.map((info) => (
              <Stack
                key={info.event}
                direction="row"
                align="center"
                gap="var(--spacing-sm)"
                wrap
                className={styles.eventRow}
              >
                <Typography variant="mono" weight="medium" as="span">
                  {info.event}
                </Typography>
                {info.supportsMatcher ? (
                  <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                    {info.matcherExamples.map((example) => (
                      <Badge key={example} tone="neutral">
                        {example}
                      </Badge>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('hooks.matcher')}: —
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        </Stack>
      </Card>
    </Stack>
  );
}
