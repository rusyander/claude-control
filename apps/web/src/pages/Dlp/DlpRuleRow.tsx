import { useTranslation } from 'react-i18next';
import type { DlpAction, DlpBuiltinPattern, DlpRule } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { DLP_BUILTINS, isRuleComplete } from '@entities/Dlp';

interface Props {
  rule: DlpRule;
  onChange: (next: DlpRule) => void;
  onRemove: (id: string) => void;
}

const ACTIONS: DlpAction[] = ['mask', 'block', 'flag'];

/**
 * Одно правило: что искать, что с найденным делать, какой меткой заменять.
 *
 * Словарь вводится строками — по одному значению в строке. Разделитель запятой
 * не годится: в названиях компаний и адресах запятая встречается сама по себе,
 * и правило молча разъехалось бы на куски.
 */
export function DlpRuleRow({ rule, onChange, onRemove }: Props) {
  const { t } = useTranslation();
  const complete = isRuleComplete(rule);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" minWidth={0}>
            <Toggle
              checked={rule.enabled}
              onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
              aria-label={t('dlp.ruleEnabled', { name: rule.name })}
              size="sm"
            />
            <Typography variant="body" weight="medium" truncate>
              {rule.name}
            </Typography>
            <Badge tone={rule.action === 'block' ? 'danger' : 'neutral'}>
              {t(`dlp.action.${rule.action}`)}
            </Badge>
            {!complete && <Badge tone="warning">{t('dlp.ruleIncomplete')}</Badge>}
          </Stack>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="trash" size={16} />}
            aria-label={t('dlp.removeRule')}
            onClick={() => onRemove(rule.id)}
          />
        </Stack>

        <TextField
          label={t('dlp.ruleName')}
          value={rule.name}
          onChange={(name) => onChange({ ...rule, name })}
        />

        {rule.kind === 'builtin' && (
          <SelectField
            label={t('dlp.builtin')}
            value={rule.builtin ?? ''}
            onChange={(value) => onChange({ ...rule, builtin: value as DlpBuiltinPattern })}
            options={DLP_BUILTINS.map((builtin) => ({
              value: builtin,
              label: t(`dlp.builtinName.${builtin}`),
            }))}
            hint={rule.builtin ? t(`dlp.builtinHint.${rule.builtin}`) : undefined}
          />
        )}

        {rule.kind === 'terms' && (
          <TextField
            label={t('dlp.terms')}
            value={rule.terms.join('\n')}
            onChange={(value) => onChange({ ...rule, terms: value.split('\n') })}
            hint={t('dlp.termsHint')}
            multiline
            rows={5}
          />
        )}

        {rule.kind === 'regex' && (
          <TextField
            label={t('dlp.pattern')}
            value={rule.pattern}
            onChange={(pattern) => onChange({ ...rule, pattern })}
            hint={t('dlp.patternHint')}
            isMono
          />
        )}

        <Stack direction="row" gap="var(--spacing-sm)" wrap>
          <Stack flex={1} minWidth={180}>
            <SelectField
              label={t('dlp.actionLabel')}
              value={rule.action}
              onChange={(value) => onChange({ ...rule, action: value as DlpAction })}
              options={ACTIONS.map((action) => ({
                value: action,
                label: t(`dlp.action.${action}`),
              }))}
              hint={t(`dlp.actionHint.${rule.action}`)}
            />
          </Stack>
          {rule.action === 'mask' && (
            <Stack flex={1} minWidth={180}>
              <TextField
                label={t('dlp.label')}
                value={rule.label}
                onChange={(label) => onChange({ ...rule, label })}
                hint={t('dlp.labelHint', { label: rule.label || 'ДАННЫЕ' })}
                isMono
              />
            </Stack>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
