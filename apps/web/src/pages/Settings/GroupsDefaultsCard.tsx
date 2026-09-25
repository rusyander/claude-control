import { useTranslation } from 'react-i18next';
import {
  GROUP_QUESTIONS_MODES,
  SPLIT_HEAVY_RULE_MAX,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import { SPLIT_MAX_GROUPS } from '@agentdeck/contracts/task-split';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useSaveSplitDefaults, useSplitDefaults } from '@entities/ProjectGit';
import { NumberSettingRow } from './NumberSettingRow';
import { GroupPermissionRows } from './GroupPermissionRows';
import { defaultRows, toggleDefaultRow } from './model/groupRows';
import styles from './SettingsPage.module.scss';

/**
 * Общие правила групп: строки разрешений, потолки лёгкого и тяжёлого проекта и
 * правило тяжести. Каждая правка сохраняется сразу, как и прочие тумблеры
 * настроек: человек настраивает это один раз и уходит.
 */
export function GroupsDefaultsCard() {
  const { t } = useTranslation();
  const query = useSplitDefaults();
  const save = useSaveSplitDefaults();
  const defaults = query.data?.defaults;
  const builtIn = query.data?.builtIn;

  if (!defaults || !builtIn) {
    return (
      <Card padding="md">
        <Typography variant="body-sm" color="subtle">
          {query.isError ? toErrorMessage(query.error) : t('settings.groups.loading')}
        </Typography>
      </Card>
    );
  }

  const put = (next: SplitDefaults): void => {
    save.mutate(next, {
      onSuccess: () => toast.success(t('settings.groups.saved')),
      onError: (error) => toast.error(toErrorMessage(error)),
    });
  };

  const byDefault = (value: number): string => t('settings.groups.byDefault', { value });

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('settings.groups.defaultsTitle')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.groups.defaultsHint')}
          </Typography>
        </Stack>

        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" weight="medium">
            {t('settings.groups.permissionsTitle')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.groups.permissionsHint')}
          </Typography>
        </Stack>
        <GroupPermissionRows
          rows={defaultRows(defaults)}
          disabled={save.isPending}
          onChange={(id, level) => put(toggleDefaultRow(defaults, id, level))}
        />

        <Stack gap="var(--spacing-xs)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('settings.groups.questionsTitle')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('settings.groups.questionsHint')}
            </Typography>
          </Stack>
          <Stack
            direction="row"
            gap="var(--spacing-3xs)"
            role="radiogroup"
            aria-label={t('settings.groups.questionsTitle')}
            wrap
          >
            {GROUP_QUESTIONS_MODES.map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={defaults.groupQuestions === mode ? 'primary' : 'ghost'}
                role="radio"
                aria-checked={defaults.groupQuestions === mode}
                disabled={save.isPending}
                onClick={() =>
                  defaults.groupQuestions !== mode && put({ ...defaults, groupQuestions: mode })
                }
              >
                {t(`settings.groups.questions.${mode}`)}
              </Button>
            ))}
          </Stack>
        </Stack>

        <Typography variant="body-sm" weight="medium">
          {t('settings.groups.parallelTitle')}
        </Typography>
        <NumberSettingRow
          label={t('settings.groups.parallelLight')}
          hint={byDefault(builtIn.parallelLight)}
          value={defaults.parallelLight}
          min={1}
          max={SPLIT_MAX_GROUPS}
          inputClassName={styles.numberInput}
          onChange={(parallelLight) => put({ ...defaults, parallelLight })}
        />
        <NumberSettingRow
          label={t('settings.groups.parallelHeavy')}
          hint={byDefault(builtIn.parallelHeavy)}
          value={defaults.parallelHeavy}
          min={1}
          max={SPLIT_MAX_GROUPS}
          inputClassName={styles.numberInput}
          onChange={(parallelHeavy) => put({ ...defaults, parallelHeavy })}
        />

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium">
            {t('settings.groups.heavyTitle')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.groups.heavyRule', {
              chains: defaults.heavy.chains,
              steps: defaults.heavy.steps,
            })}
          </Typography>
        </Stack>
        <NumberSettingRow
          label={t('settings.groups.heavyChains')}
          hint={byDefault(builtIn.heavy.chains)}
          value={defaults.heavy.chains}
          min={1}
          max={SPLIT_HEAVY_RULE_MAX}
          inputClassName={styles.numberInput}
          onChange={(chains) => put({ ...defaults, heavy: { ...defaults.heavy, chains } })}
        />
        <NumberSettingRow
          label={t('settings.groups.heavySteps')}
          hint={byDefault(builtIn.heavy.steps)}
          value={defaults.heavy.steps}
          min={1}
          max={SPLIT_HEAVY_RULE_MAX}
          inputClassName={styles.numberInput}
          onChange={(steps) => put({ ...defaults, heavy: { ...defaults.heavy, steps } })}
        />
      </Stack>
    </Card>
  );
}
