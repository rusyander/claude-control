import { useTranslation } from 'react-i18next';
import { platformRulesApplies, type Platform } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useIsPlatformSaving, useSavePlatform } from '@entities/Platform';
import { rulesAppliesOf, withApplies } from './lib/contourConfigView';

interface RulesChoiceProps {
  platform: Platform;
  /** Заголовок над выбором: на карточке он нужен, на вкладке правил его несёт карточка. */
  withTitle?: boolean;
}

/**
 * Чьи правила действуют на прогон через ЭТОТ контур (баг 11б): оба набора,
 * только контура или только наши. Сохраняется сразу — это выбор, а не черновик.
 *
 * Стоит и на карточке контура, и над колонками правил: владелец раздела искал
 * его на карточке и не находил. Один компонент на оба места — две разные
 * подписи одного выбора разошлись бы.
 *
 * Отказ сервера называется словами: вернуть «оба набора» при записанных
 * инструментах контура и включённой прослойке — то самое взаимное исключение,
 * и сохранение получит отказ с его причиной.
 */
export function RulesChoice({ platform, withTitle = false }: RulesChoiceProps) {
  const { t } = useTranslation();
  const save = useSavePlatform({ silentError: true });
  // Ждём ЛЮБУЮ запись контура (раздел на карточке, поле правил): выбор
  // собирает контур целиком, и собранный посреди чужой записи откатил бы её.
  const saving = useIsPlatformSaving();
  const current = rulesAppliesOf(platform);

  return (
    <Stack gap="var(--spacing-2xs)" data-rules-applies={current}>
      {withTitle && (
        <Typography variant="body-sm" weight="medium" as="h3">
          {t('contourConfig.rules.title')}
        </Typography>
      )}
      <Stack
        direction="row"
        gap="var(--spacing-3xs)"
        // Кнопки-переключатели в группе, а не радиогруппа: радио обещает стрелки и
        // один шаг табом на группу, а здесь каждая кнопка — свой шаг (ревью 28.09, F-244).
        role="group"
        aria-label={t('contourConfig.rules.choiceLabel')}
        wrap
      >
        {platformRulesApplies.map((applies) => (
          <Button
            key={applies}
            size="sm"
            variant={current === applies ? 'primary' : 'ghost'}
            aria-pressed={current === applies}
            disabled={saving}
            data-applies={applies}
            onClick={() => {
              if (current === applies) return;
              save.mutate(
                { platform: withApplies(platform, applies) },
                {
                  onSuccess: () => toast.success(t('contourConfig.rules.saved')),
                  onError: (error) => toast.error(toErrorMessage(error)),
                },
              );
            }}
          >
            {t(`contourConfig.rules.applies.${applies}`)}
          </Button>
        ))}
      </Stack>
      <Typography variant="caption" color="muted" className="prose">
        {t(`contourConfig.rules.appliesText.${current}`)}
      </Typography>
      <Typography variant="caption" color="muted" className="prose">
        {t('contourConfig.rules.keeps')}
      </Typography>
    </Stack>
  );
}
