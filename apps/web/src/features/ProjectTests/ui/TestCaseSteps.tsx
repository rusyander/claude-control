import { useTranslation } from 'react-i18next';
import type { ProjectTestStep } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import type { TestCaseStepsProps } from './TestCaseSteps.types';
import styles from './ProjectTests.module.scss';

/**
 * Шаги кейса строками: действие, ожидание, данные.
 *
 * Раньше шаги набирались одним многострочным полем, и это было быстрее, но
 * убивало половину смысла: у шага есть СВОЁ ожидание и свои данные, и ручной
 * проход отмечает результат по каждому шагу отдельно. Строкой на шаг это
 * выражается, простынёй текста — нет.
 *
 * Ссылка на общий шаг заменяет собой набор действий: в файле остаётся `ref`, а
 * раскрывает его прогон. Поэтому у строки со ссылкой поля действия не
 * редактируются — иначе копия текста разъехалась бы с оригиналом.
 */
export function TestCaseSteps({ steps, onChange, sharedSteps, withExpected }: TestCaseStepsProps) {
  const { t } = useTranslation();

  const update = (index: number, part: Partial<ProjectTestStep>): void => {
    onChange(steps.map((step, position) => (position === index ? { ...step, ...part } : step)));
  };

  const remove = (index: number): void => {
    const next = steps.filter((_, position) => position !== index);
    onChange(next.length > 0 ? next : [{ action: '' }]);
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const moved = next[index];
    const other = next[target];
    if (!moved || !other) return;
    next[index] = other;
    next[target] = moved;
    onChange(next);
  };

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium">
        {t('tests.editor.steps')}
      </Typography>

      {steps.map((step, index) => (
        <div key={index} className={styles.stepRow}>
          <span className={styles.stepIndex}>{index + 1}</span>

          <Stack gap="var(--spacing-2xs)" className={styles.stepFields}>
            {step.ref ? (
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Badge tone="info">{t('tests.editor.sharedRef')}</Badge>
                <Typography variant="body-sm" as="span">
                  {sharedSteps.find((item) => item.id === step.ref)?.title ?? step.ref}
                </Typography>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update(index, { ref: undefined, action: step.action })}
                >
                  {t('tests.editor.sharedDetach')}
                </Button>
              </Stack>
            ) : (
              <TextField
                label={t('tests.editor.stepAction', { index: index + 1 })}
                value={step.action}
                onChange={(value) => update(index, { action: value })}
              />
            )}

            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {withExpected && (
                <div className={styles.stepHalf}>
                  <TextField
                    label={t('tests.editor.stepExpected')}
                    value={step.expected ?? ''}
                    onChange={(value) => update(index, { expected: value })}
                  />
                </div>
              )}
              <div className={styles.stepHalf}>
                <TextField
                  label={t('tests.editor.stepData')}
                  value={step.data ?? ''}
                  onChange={(value) => update(index, { data: value })}
                />
              </div>
            </Stack>

            {sharedSteps.length > 0 && !step.ref && (
              <SelectField
                label={t('tests.editor.sharedPick')}
                value=""
                onChange={(value) => {
                  const shared = sharedSteps.find((item) => item.id === value);
                  if (shared) update(index, { ref: shared.id, action: shared.title });
                }}
                options={[
                  { value: '', label: t('tests.editor.sharedNone') },
                  ...sharedSteps.map((item) => ({ value: item.id, label: item.title })),
                ]}
              />
            )}
          </Stack>

          <Stack gap="var(--spacing-3xs)">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="chevronUp" size={16} />}
              aria-label={t('tests.editor.stepUp', { index: index + 1 })}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="chevronDown" size={16} />}
              aria-label={t('tests.editor.stepDown', { index: index + 1 })}
              disabled={index === steps.length - 1}
              onClick={() => move(index, 1)}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="trash" size={16} />}
              aria-label={t('tests.editor.stepRemove', { index: index + 1 })}
              onClick={() => remove(index)}
            />
          </Stack>
        </div>
      ))}

      <Stack direction="row" gap="var(--spacing-2xs)">
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          onClick={() => onChange([...steps, { action: '' }])}
        >
          {t('tests.editor.stepAdd')}
        </Button>
      </Stack>
    </Stack>
  );
}
