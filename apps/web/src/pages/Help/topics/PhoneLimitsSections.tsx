import { HelpSection, StorageCard, FieldTable, Callout } from '../ui';
import { Stack } from '@shared/ui/stack';

interface SectionProps {
  /** Перевод ключа `help.topics.phone.<key>`. */
  tr: (key: string) => string;
}

/**
 * Обязательные блоки документа «Телефон»: чем приложение НЕ является, что где
 * лежит, пределы и отказы дословно — плюс предупреждение о токене.
 *
 * Предупреждение стоит в конце, под отказами, а не в начале: к нему приходят с
 * вопросом «а что, если потерял телефон?», и ответ «Сменить токен» должен
 * стоять рядом с «Токен не принят», который человек увидит сразу после.
 */
export function PhoneLimitsSections({ tr }: SectionProps) {
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });

  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[row('notSecondPanel'), row('notOwnServer'), row('notCloud'), row('notKeys')]}
        />
      </HelpSection>

      <HelpSection title={tr('storageTitle')} caption={tr('storageCaption')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storagePanelToken'), value: tr('storagePanelTokenValue'), isMono: true },
            { label: tr('storageSettings'), value: tr('storageSettingsValue'), isMono: true },
            { label: tr('storageDevices'), value: tr('storageDevicesValue'), isMono: true },
            { label: tr('storagePhone'), value: tr('storagePhoneValue') },
            { label: tr('storageNever'), value: tr('storageNeverValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            row('limitAndroid'),
            row('limitTailscale'),
            row('limitOneToken'),
            row('limitPushLang'),
            row('limitPushExpo'),
            row('limitCards'),
            row('limitTheme'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <Stack gap="var(--spacing-xs)">
          <FieldTable
            nameHeader={tr('refusalsColumn')}
            descriptionHeader={tr('refusalsMeaningColumn')}
            rows={[
              row('refusalToken'),
              row('refusalSilent'),
              row('refusalNotCode'),
              row('refusalAddress'),
              row('refusalNoTailscale'),
              row('refusalPush'),
            ]}
          />
          <Callout tone="warning" title={tr('warnTitle')}>
            {tr('warnText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
