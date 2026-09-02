import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PERMISSION_PRESETS, type PermissionRule } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { RISK_TONE, DECISION_TONE, effectiveRuleFor } from '@entities/Permission';
import type { SystemPermissionsProps } from './SystemPermissions.types';
import styles from './PermissionsPage.module.scss';

interface SystemInfo {
  platform: string;
  osName: string;
  homeDir: string;
  shell: string;
}

/**
 * Что Claude Code делает с этим компьютером. В отличие от общего списка,
 * здесь показаны не сырые строки правил, а понятные действия — и видно,
 * какие из них уже разрешены, а какие спросят или запрещены.
 */
export function SystemPermissions({ rules, onEdit, onCreate }: SystemPermissionsProps) {
  const { t } = useTranslation();

  const { data: system } = useQuery({
    queryKey: ['system'],
    queryFn: async () => {
      const { data } = await apiClient.get<SystemInfo>('/system');
      return data;
    },
  });

  /**
   * Точное правило заготовки — его и предлагаем править. Но плашка показывает
   * то, что действует: deny того же шаблона или всего инструмента побеждает
   * allow, и «Разрешено» на карточке было бы неправдой.
   */
  const findRule = (pattern: string): PermissionRule | undefined =>
    rules.find((rule) => rule.pattern === pattern);

  const categories = [...new Set(PERMISSION_PRESETS.map((preset) => preset.category))];

  return (
    <Stack gap="var(--spacing-lg)">
      {system && (
        <Card padding="md">
          <Stack direction="row" align="center" gap="var(--spacing-md)" wrap>
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="settings" size={24} />
              <Typography variant="body" weight="medium" as="span">
                {system.osName}
              </Typography>
            </Stack>
            <Badge tone="neutral">{system.shell}</Badge>
            <Typography variant="mono" color="subtle" as="span">
              {system.homeDir}
            </Typography>
          </Stack>
        </Card>
      )}

      {categories.map((category) => (
        <Stack key={category} gap="var(--spacing-sm)">
          <Typography variant="heading-sm">{t(`permissions.category_${category}`)}</Typography>

          <Stack gap="var(--spacing-xs)">
            {PERMISSION_PRESETS.filter((preset) => preset.category === category).map((preset) => {
              const effective = effectiveRuleFor(preset.pattern, rules);
              const rule = findRule(preset.pattern) ?? effective;

              return (
                <Card key={preset.id} padding="md">
                  <Stack
                    direction="row"
                    align="center"
                    justify="between"
                    gap="var(--spacing-md)"
                    wrap
                  >
                    <Stack gap="var(--spacing-2xs)" className={styles.systemInfo}>
                      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                        <Typography variant="body" weight="medium" as="span">
                          {preset.title}
                        </Typography>
                        <Badge tone={RISK_TONE[preset.risk]}>
                          {t(`permissions.risk_${preset.risk}`)}
                        </Badge>
                      </Stack>
                      <Typography variant="body-sm" color="muted">
                        {preset.description}
                      </Typography>
                      <Typography variant="mono" color="subtle" as="span">
                        {preset.pattern}
                      </Typography>
                    </Stack>

                    <Stack direction="row" align="center" gap="var(--spacing-xs)">
                      {rule && effective ? (
                        <>
                          <Badge tone={DECISION_TONE[effective.decision]} withDot>
                            {t(`permissions.${effective.decision}`)}
                          </Badge>
                          {effective.id !== rule.id && (
                            <Badge tone="neutral">
                              {t('permissions.shadowed', {
                                decision: t(`permissions.${effective.decision}`),
                              })}
                            </Badge>
                          )}
                          <Button size="sm" onClick={() => onEdit(rule)}>
                            {t('common.edit')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {/*
                            Не значок, а спокойный текст: залитая плашка рядом
                            с кнопкой сама читалась кнопкой — казалось, что
                            «Не задано» можно нажать.
                          */}
                          <Typography variant="body-sm" color="subtle" as="span">
                            {t('permissions.notConfigured')}
                          </Typography>
                          <Button
                            size="sm"
                            variant="secondary"
                            leftIcon={<Icon name="plus" size={24} />}
                            onClick={() => onCreate(preset.pattern)}
                          >
                            {t('permissions.configure')}
                          </Button>
                        </>
                      )}
                    </Stack>
                  </Stack>
                </Card>
              );
            })}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
