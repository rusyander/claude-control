import { useTranslation } from 'react-i18next';
import type { PromptGateAction } from '@agentdeck/contracts';
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
 * Провайдер карточку больше не ограничивает (П6.2): у чужого CLI такого события
 * нет, и хук отыгрывает надзиратель панели — тот же скрипт, те же правила, тот же
 * журнал. Меняется одна строка: где именно гейт действует.
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

  // Гейт больше не Claude-only (П6.2): у чужого CLI события «промпт отправлен»
  // нет, и панель отыгрывает его сама в своём запуске — тем же скриптом, по тем
  // же правилам, в тот же журнал. Карточка поэтому работает при любом активном
  // провайдере; меняется не управление, а строка о том, ГДЕ гейт действует.
  //
  // Чужой конфиг при этом не правится ничем: скрипт и его регистрация живут в
  // собственных файлах панели, а не в файлах активного CLI.
  const active = providers?.active ?? 'claude';
  const activeName = providers?.providers.find((item) => item.id === active)?.name ?? active;
  const isClaude = active === 'claude';

  const { settings, installed, customized, outdated, problem, rulesCount, blockRulesCount } = data;

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
            disabled={apply.isPending || (rulesCount === 0 && !settings.enabled)}
            aria-label={t('gate.title')}
          />
        </Stack>

        <Typography variant="body-sm" color="subtle">
          {t('gate.scope')}
        </Typography>

        {/*
         * Где гейт действует у чужого CLI — предупреждением, а не отказом: он
         * работает, но только в запуске через панель, и умолчать об этом значило
         * бы обещать защиту терминалу, до которого панель не дотягивается.
         */}
        {!isClaude && (
          <Typography variant="body-sm" color="warning">
            {t('gate.foreignScope', { provider: activeName })}
          </Typography>
        )}

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

        {/*
         * Скрипт прошлой версии панели — не правка руками: пересборка кладёт
         * новый без force, и новые образцы начинают проверяться и в промпте.
         */}
        {outdated && !customized && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="warning">
              {t('gate.outdated')}
            </Typography>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run(true, settings.action)}
              isLoading={apply.isPending}
            >
              {t('gate.rebuild')}
            </Button>
          </Stack>
        )}

        {customized && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="warning">
              {t('gate.customized')}
            </Typography>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run(true, settings.action, true)}
              isLoading={apply.isPending}
            >
              {t('gate.reinstall')}
            </Button>
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
