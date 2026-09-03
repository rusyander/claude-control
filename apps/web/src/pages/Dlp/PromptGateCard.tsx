import { useTranslation } from 'react-i18next';
import type { PromptGateAction } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { SelectField } from '@shared/ui/select-field';
import { toast } from '@shared/lib/toast';
import { useProviders } from '@entities/Provider';
import { usePromptGate, useApplyPromptGate } from '@entities/PromptGate';
import { dlpErrorMessage } from '@entities/Dlp';

/**
 * Гейт на промпте: хук `UserPromptSubmit`, который панель кладёт в каталог
 * хуков и прописывает в `settings.json`.
 *
 * Карточка обязана начинаться с того, чего гейт НЕ умеет. Он видит только то,
 * что человек набрал руками: ни файла, прочитанного агентом, ни вывода команды,
 * ни промпта подагента в нём нет. И он не заменяет текст — событие
 * `UserPromptSubmit` этого не позволяет, поэтому действий ровно два: отклонить
 * или предупредить. Кто хочет видеть всё тело запроса — включает прокси выше.
 *
 * Пока состояние грузится или сервер отказал, карточка стоит на месте с
 * заголовком: исчезающая карточка читалась бы как «гейта здесь нет».
 */
export function PromptGateCard() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = usePromptGate();
  const { data: providers } = useProviders();
  const apply = useApplyPromptGate();

  if (isError && !data) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('gate.title')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="danger">
              {t('gate.loadError')}
            </Typography>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </Stack>
        </Stack>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('gate.title')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('common.loading')}
          </Typography>
        </Stack>
      </Card>
    );
  }

  // Хук ставится в конфигурацию Claude Code: события «промпт отправлен» с
  // возможностью отказа у остальных CLI не задокументировано. Пока активен
  // другой провайдер, любое действие карточки молча правило бы чужой конфиг —
  // поэтому спрятаны и тумблер, и выбор действия, и переустановка.
  const isClaude = (providers?.active ?? 'claude') === 'claude';

  const { settings, installed, customized, problem, rulesCount, blockRulesCount } = data;

  const run = (enabled: boolean, action: PromptGateAction, force = false): void => {
    apply.mutate(
      { enabled, action, force },
      {
        onSuccess: (info) => toast.success(info.installed ? t('gate.applied') : t('gate.removed')),
        onError: (error) => toast.error(dlpErrorMessage(error, t('gate.applyFailed'))),
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('gate.title')}
            </Typography>
            <Badge tone={installed ? 'success' : 'neutral'} withDot>
              {installed ? t('gate.installed') : t('gate.notInstalled')}
            </Badge>
          </Stack>
          <Toggle
            checked={settings.enabled}
            onCheckedChange={(enabled) => run(enabled, settings.action)}
            disabled={apply.isPending || !isClaude || (rulesCount === 0 && !settings.enabled)}
            aria-label={t('gate.title')}
          />
        </Stack>

        <Typography variant="body-sm" color="subtle">
          {t('gate.scope')}
        </Typography>

        {!isClaude && (
          <Typography variant="body-sm" color="warning">
            {t('gate.claudeOnly')}
          </Typography>
        )}

        {isClaude && (
          <SelectField
            label={t('gate.action')}
            value={settings.action}
            onChange={(action) => run(settings.enabled, action as PromptGateAction)}
            options={[
              { value: 'block', label: t('gate.actionBlock') },
              { value: 'warn', label: t('gate.actionWarn') },
            ]}
            hint={t('gate.actionHint')}
          />
        )}

        <Typography variant="caption" color="subtle">
          {t('gate.rules', { count: rulesCount, blocking: blockRulesCount })}
        </Typography>

        {rulesCount === 0 && (
          <Typography variant="body-sm" color="warning">
            {t('gate.noRules')}
          </Typography>
        )}

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle">
            {t('gate.scriptPath')}
          </Typography>
          <Typography variant="mono">{data.scriptPath}</Typography>
        </Stack>

        {customized && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="warning">
              {t('gate.customized')}
            </Typography>
            {isClaude && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => run(true, settings.action, true)}
                isLoading={apply.isPending}
              >
                {t('gate.reinstall')}
              </Button>
            )}
          </Stack>
        )}

        {problem && (
          <Typography variant="body-sm" color="danger">
            {problem}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
