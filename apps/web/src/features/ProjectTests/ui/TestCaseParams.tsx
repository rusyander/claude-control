import { useTranslation } from 'react-i18next';
import { combineParams } from '@agentdeck/contracts/test-format';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import type { TestCaseParamsProps } from './TestCaseParams.types';
import styles from './ProjectTests.module.scss';

/**
 * Параметры кейса и предпросмотр числа проходов.
 *
 * Параметр — это `%login` в тексте шага; значения задают, сколько РАЗ кейс
 * пройдут. Число проходов показано сразу и считается тем же `combineParams`,
 * что и на сервере: три параметра по три значения — это двадцать семь проходов,
 * и узнавать об этом из очереди прогона поздно.
 */
export function TestCaseParams({ parameters, onChange }: TestCaseParamsProps) {
  const { t } = useTranslation();

  const usable = parameters.filter((item) => item.name.trim() && item.values.length > 0);
  const full = combineParams(usable, 'full').length;
  const pairwise = combineParams(usable, 'pairwise').length;

  const update = (index: number, part: Partial<{ name: string; values: string[] }>): void => {
    onChange(
      parameters.map((item, position) => (position === index ? { ...item, ...part } : item)),
    );
  };

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium">
        {t('tests.editor.parameters')}
      </Typography>
      <Typography variant="caption" color="subtle">
        {t('tests.editor.parametersHint')}
      </Typography>

      {parameters.map((item, index) => (
        <div key={index} className={styles.paramRow}>
          <div className={styles.paramName}>
            <TextField
              label={t('tests.editor.parameterName')}
              value={item.name}
              onChange={(value) => update(index, { name: value })}
              isMono
            />
          </div>
          <div className={styles.paramValues}>
            <TextField
              label={t('tests.editor.parameterValues')}
              hint={t('tests.editor.parameterValuesHint')}
              value={item.values.join(', ')}
              onChange={(value) =>
                update(index, {
                  values: value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="trash" size={16} />}
            aria-label={t('tests.editor.parameterRemove')}
            onClick={() => onChange(parameters.filter((_, position) => position !== index))}
          />
        </div>
      ))}

      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          onClick={() => onChange([...parameters, { name: '', values: [] }])}
        >
          {t('tests.editor.parameterAdd')}
        </Button>
        {usable.length > 0 && (
          <>
            <Badge tone="info">{t('tests.editor.pointsFull', { count: full })}</Badge>
            <Badge tone="neutral">{t('tests.editor.pointsPairwise', { count: pairwise })}</Badge>
          </>
        )}
      </Stack>
    </Stack>
  );
}
