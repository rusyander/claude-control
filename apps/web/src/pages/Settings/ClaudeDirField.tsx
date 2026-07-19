import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { sourceLabel } from '@shared/lib/location-label';
import { useLocation, useSetLocation } from '@entities/AppConfig';
import styles from './SettingsPage.module.scss';

/**
 * Путь к каталогу .claude. Приложение находит его само, но если автоопределение
 * не сработало или каталог нестандартный — путь вводится руками и применяется
 * сразу, без перезапуска.
 */
export function ClaudeDirField() {
  const { t } = useTranslation();
  const { data: location } = useLocation();
  const setLocation = useSetLocation();
  const [draft, setDraft] = useState('');

  const isInvalid = location && !location.isValid;
  const value = draft || (location?.source === 'manual' ? location.paths.root : '');

  return (
    <Card padding="md" isRaised={isInvalid}>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('settings.claudeDir')}
          </Typography>
          {location && (
            <Badge tone={location.isValid ? 'success' : 'danger'} withDot>
              {sourceLabel(location, t)}
            </Badge>
          )}
        </Stack>

        {isInvalid && (
          <Typography variant="body-sm" color="danger">
            {t('errors.locationHint')}
          </Typography>
        )}

        <Typography variant="caption" color="subtle">
          {t('settings.claudeDirHint')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <input
            className={styles.pathInput}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={location?.paths.root ?? t('settings.claudeDirPlaceholder')}
            aria-label={t('settings.claudeDir')}
            spellCheck={false}
          />
          <Button
            variant="primary"
            onClick={() => setLocation.mutate(draft)}
            isLoading={setLocation.isPending}
            disabled={!draft.trim()}
          >
            {t('settings.apply')}
          </Button>
        </Stack>

        {setLocation.data && !setLocation.data.isValid && (
          <Typography variant="body-sm" color="danger">
            {setLocation.data.problem}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
