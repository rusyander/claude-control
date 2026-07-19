import { useTranslation } from 'react-i18next';
import { HOOK_TEMPLATES } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Card } from '@shared/ui/card';
import type { TemplateFieldsProps } from './TemplateFields.types';

/**
 * Что именно должен делать хук. Вместо пустого файла — набор готовых
 * сценариев: показать подсказку, заблокировать опасное, выполнить команду.
 * Поля меняются под выбранный сценарий, лишнего на экране нет.
 */
export function TemplateFields({
  template,
  onTemplateChange,
  message,
  onMessageChange,
  guardPatterns,
  onGuardPatternsChange,
  command,
  onCommandChange,
}: TemplateFieldsProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body-sm" weight="medium">
          {t('hooks.whatItDoes')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-2xs)" wrap>
          {HOOK_TEMPLATES.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={template === item ? 'primary' : 'secondary'}
              onClick={() => onTemplateChange(item)}
            >
              {t(`hooks.template_${item}`)}
            </Button>
          ))}
        </Stack>

        <Typography variant="caption" color="subtle">
          {t(`hooks.templateHint_${template}`)}
        </Typography>

        {template === 'message' && (
          <TextField
            label={t('hooks.messageText')}
            value={message}
            onChange={onMessageChange}
            multiline
            rows={3}
            placeholder={t('hooks.messagePlaceholder')}
          />
        )}

        {template === 'guard' && (
          <>
            <TextField
              label={t('hooks.guardPatterns')}
              value={guardPatterns}
              onChange={onGuardPatternsChange}
              placeholder="rm -rf, DROP TABLE, git push --force"
              hint={t('hooks.guardPatternsHint')}
              isMono
            />
            <TextField
              label={t('hooks.guardMessage')}
              value={message}
              onChange={onMessageChange}
              placeholder={t('hooks.guardMessagePlaceholder')}
            />
          </>
        )}

        {template === 'shell' && (
          <TextField
            label={t('hooks.shellCommand')}
            value={command}
            onChange={onCommandChange}
            placeholder="pnpm lint"
            hint={t('hooks.shellCommandHint')}
            isMono
          />
        )}

        {template === 'blank' && (
          <Typography variant="caption" color="muted">
            {t('hooks.blankHint')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
