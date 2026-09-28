import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GROUP_OVERRIDE_FILE, groupKeyOf, scopeOf } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { useSetGroupOverride, useSetProjectGroupChoice } from '@entities/Group';
import type { GroupPairSwitchProps } from './GroupPairSwitch.types';
import styles from './GroupPairSwitch.module.scss';

/**
 * Какая сторона пары действует в проекте: «Глобальная · Проектная». Действует
 * ровно одна — сервер отказывает в записи, которая включила бы обе. Неактивная
 * сторона подписана словами: проектную панель не трогала, она лежит в проекте
 * как была, просто не действует.
 *
 * Переопределение — файл в проекте, который велит CLI идти глобальной группой
 * вместо проектной лестницы. Имеет смысл только при активной глобальной стороне.
 */
export function GroupPairSwitch({
  group,
  pair,
  path,
  isGlobalActive,
  isError,
}: GroupPairSwitchProps) {
  const { t } = useTranslation();
  const setChoice = useSetProjectGroupChoice();
  const setOverride = useSetGroupOverride();
  // Что сказал последний переключатель: сервер может и не сообщать состояние
  // файла в списке групп, а врать о нём тумблером нельзя.
  const [overrideLocal, setOverrideLocal] = useState<boolean | undefined>(undefined);
  const reported = group.overrides?.find((item) => item.path === path);
  // После копии переопределение включено по умолчанию (так решено в плане).
  const overrideOn = overrideLocal ?? reported?.enabled ?? true;
  const overrideFile = reported?.file ?? GROUP_OVERRIDE_FILE;
  const pairScope = scopeOf(pair);
  const isClaude = pairScope.kind !== 'project' || pairScope.provider === 'claude';

  const choose = (side: 'global' | 'project'): void => {
    const target = side === 'global' ? group : pair;
    setChoice.mutate({ path, groupKey: groupKeyOf(target) });
  };

  return (
    <Stack gap="var(--spacing-xs)" className={styles.box}>
      <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Icon name="folder" size={16} />
          <Typography variant="body-sm" as="span" id={`pair-${group.id}-label`}>
            {t('groupSources.pairLabel', { path })}
          </Typography>
        </Stack>
        <div role="group" aria-labelledby={`pair-${group.id}-label`} className={styles.segments}>
          <Button
            size="sm"
            variant={isGlobalActive ? 'primary' : 'secondary'}
            aria-pressed={isGlobalActive === true}
            disabled={setChoice.isPending || isGlobalActive === undefined}
            onClick={() => choose('global')}
          >
            {t('groupSources.pairGlobal')}
          </Button>
          <Button
            size="sm"
            variant={isGlobalActive === false ? 'primary' : 'secondary'}
            aria-pressed={isGlobalActive === false}
            disabled={setChoice.isPending || isGlobalActive === undefined}
            onClick={() => choose('project')}
          >
            {t('groupSources.pairProject')}
          </Button>
        </div>
        {isGlobalActive === true && (
          <Badge tone="neutral">{t('groupSources.inactiveProject')}</Badge>
        )}
        {isGlobalActive === false && (
          <Badge tone="neutral">{t('groupSources.inactiveGlobal')}</Badge>
        )}
      </Stack>

      {isError && (
        <Typography variant="caption" color="danger">
          {t('groupSources.choiceLoadError')}
        </Typography>
      )}

      {isGlobalActive === true && isClaude && (
        <Stack direction="row" align="start" gap="var(--spacing-sm)">
          <Toggle
            size="sm"
            checked={overrideOn}
            disabled={setOverride.isPending}
            aria-label={t('groupSources.overrideAria', { path })}
            onCheckedChange={(enabled) =>
              setOverride.mutate(
                { id: group.id, path, enabled },
                { onSuccess: (result) => setOverrideLocal(result.enabled) },
              )
            }
          />
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium" as="span">
              {t('groupSources.override')}
            </Typography>
            <Typography variant="caption" color="subtle" className={styles.hint}>
              {t('groupSources.overrideHint', { file: overrideFile })}
            </Typography>
          </Stack>
        </Stack>
      )}
      {isGlobalActive === true && !isClaude && (
        <Typography variant="caption" color="subtle">
          {t('groupSources.overrideClaudeOnly')}
        </Typography>
      )}
    </Stack>
  );
}
