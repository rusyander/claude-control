import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { HelpSectionProps } from './help-kit.types';

/**
 * Раздел документа справки. Все документы собраны из этих секций, поэтому
 * одинаковый вопрос лежит на одинаковом месте в любом разделе — читателю не
 * приходится заново искать, где здесь про поля, а где про грабли.
 */
export function HelpSection({ title, caption, children }: HelpSectionProps) {
  return (
    <Stack as="section" gap="var(--spacing-sm)" className={styles.section}>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="heading-sm" as="h2">
          {title}
        </Typography>
        {caption && (
          <Typography variant="body-sm" color="muted" className={styles.sectionCaption}>
            {caption}
          </Typography>
        )}
      </Stack>
      {children}
    </Stack>
  );
}
