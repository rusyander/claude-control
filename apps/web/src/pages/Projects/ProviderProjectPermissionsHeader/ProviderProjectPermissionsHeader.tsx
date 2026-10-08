import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ProviderProjectPermissionsHeaderProps } from './ProviderProjectPermissionsHeader.types';

/**
 * Шапка таба прав проекта: подсказка, путь файла и кнопка сохранения. Одна на все
 * модели прав — формы Qwen/Cursor/OpenCode получают её через `header`, а ветка
 * Gemini рисует её сама, потому что её форма живёт прямо в табе.
 */
export function ProviderProjectPermissionsHeader({
  filePath,
  readOnly,
  dirty,
  isPending,
  onSubmit,
}: ProviderProjectPermissionsHeaderProps) {
  const { t } = useTranslation();

  return (
    <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
      <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
        <Typography variant="caption" color="subtle">
          {t('providerProject.permissionsHint')}
        </Typography>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {filePath}
        </Typography>
      </Stack>
      {!readOnly && (
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="check" size={20} />}
          onClick={onSubmit}
          disabled={!dirty}
          isLoading={isPending}
        >
          {t('common.save')}
        </Button>
      )}
    </Stack>
  );
}
