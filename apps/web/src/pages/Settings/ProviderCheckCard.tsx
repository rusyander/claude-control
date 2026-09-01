import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { formatDate } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '@entities/Provider';
import {
  useProviderChecks,
  useRunProviderCheck,
  findCheck,
  trustBadge,
  checkScore,
} from '@entities/ProviderCheck';
import { CheckStepRow } from './CheckStepRow';
import { SettingToggleRow } from './SettingToggleRow';
import styles from './ProviderCheckCard.module.scss';

/**
 * Проверка активного провайдера на этой машине (IDEA-2 + чек-лист IDEA-1).
 *
 * Панель заявляет о девяти провайдерах «экспериментальный», и это честно ровно
 * до первого запуска у человека: дальше слово должно смениться фактом. Кнопка
 * прогоняет короткий список шагов — CLI в PATH, файлы конфигурации, круг
 * чтения-записи по каждому поддержанному разделу и один настоящий ответ
 * ассистента — и итог остаётся бейджем в панели.
 *
 * Запись при этом идёт на ВРЕМЕННОЙ КОПИИ конфигурации: настоящие файлы
 * проверка не трогает. Об этом сказано прямо в подсказке — иначе кнопку «а
 * что она сделает с моим конфигом?» нажимать страшно.
 */
export function ProviderCheckCard() {
  const { t, i18n } = useTranslation();
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();
  const { data: checks } = useProviderChecks();
  const run = useRunProviderCheck();

  const [withAssistant, setWithAssistant] = useState(true);

  if (!settings || !providers) return null;

  const providerId = settings.provider;
  const provider = providers.providers.find((item) => item.id === providerId);
  if (!provider) return null;

  const check = findCheck(checks, providerId);
  const badge = trustBadge(provider.status, check);
  const score = check ? checkScore(check) : undefined;

  const start = (): void => {
    run.mutate(
      { provider: providerId, assistant: withAssistant },
      {
        onSuccess: (result) => {
          if (result.level === 'verified') toast.success(t('providerCheck.doneVerified'));
          else if (result.level === 'failed') toast.error(t('providerCheck.doneFailed'));
          else toast.info(t('providerCheck.donePartial'));
        },
        onError: () => toast.error(t('providerCheck.error')),
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium">
              {t('providerCheck.title', { name: provider.name })}
            </Typography>
            <Badge tone={badge.tone}>{t(badge.key)}</Badge>
          </Stack>
          <Button
            variant="secondary"
            size="sm"
            isLoading={run.isPending}
            leftIcon={<Icon name="check" size={16} />}
            onClick={start}
          >
            {t('providerCheck.run')}
          </Button>
        </Stack>

        {/* Ширина по мере читаемости: без ограничения текст растягивается на всю
            карточку и читается хуже (ловится аудитом раскладки). */}
        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('providerCheck.hint')}
        </Typography>

        <SettingToggleRow
          label={t('providerCheck.withAssistant')}
          hint={t('providerCheck.withAssistantHint')}
          checked={withAssistant}
          onChange={setWithAssistant}
        />

        {check ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="caption" color="subtle">
              {t('providerCheck.lastRun', {
                date: formatDate(check.at, i18n.language),
                passed: score?.passed ?? 0,
                total: score?.total ?? 0,
              })}
            </Typography>
            {/* Список прокручивается (max-height в стилях), а прокручиваемая
                область без фокуса недостижима с клавиатуры: мышью шаги видно
                все, а клавишами — только те, что поместились. Поэтому область
                фокусируемая и подписанная. */}
            <Stack
              gap="0"
              className={styles.list}
              tabIndex={0}
              role="group"
              aria-label={t('providerCheck.steps')}
            >
              {check.steps.map((step) => (
                <CheckStepRow key={step.id} step={step} />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Typography variant="body-sm" color="subtle">
            {t('providerCheck.never')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
