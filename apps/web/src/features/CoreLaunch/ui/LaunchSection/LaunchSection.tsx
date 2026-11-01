import type { ReactNode } from 'react';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';

interface LaunchSectionProps {
  title: string;
  hint?: string;
  /** Метка блока для проверок и навигации: `data-launch-section`. */
  name: string;
  children: ReactNode;
}

/** Блок экрана запуска: заголовок, пояснение, содержимое — одна карточка на смысл. */
export function LaunchSection({ title, hint, name, children }: LaunchSectionProps) {
  return (
    <Card padding="md" data-launch-section={name}>
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2">
            {title}
          </Typography>
          {hint && (
            <Typography variant="caption" color="muted" as="p">
              {hint}
            </Typography>
          )}
        </Stack>
        {children}
      </Stack>
    </Card>
  );
}
