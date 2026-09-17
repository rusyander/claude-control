import { HelpSection, Callout, FieldTable } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>`. */
  tr: (key: string) => string;
}

/**
 * Вкладки раздела и доступ разделов — перед устройством карточки.
 *
 * Стоят первыми в справочной половине документа: человек, пришедший за одним
 * фактом, сначала ищет, НА КАКОЙ вкладке он живёт, и только потом читает, что
 * написано на карточке. Доступ разделов — отдельный раздел, потому что у него
 * есть цена (запись в файлы) и ловушка (неактивный контур записи пропускает).
 */
export function PlatformTabsSections({ tr }: SectionProps) {
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });

  return (
    <>
      <HelpSection title={tr('tabsTitle')} caption={tr('tabsCaption')}>
        <FieldTable
          nameHeader={tr('tabsColumn')}
          descriptionHeader={tr('tabsMeaningColumn')}
          rows={[
            row('tabContours'),
            row('tabModel'),
            row('tabRules'),
            row('tabAccess'),
            row('tabTools'),
            row('tabAgents'),
          ]}
        />
        <Callout tone="info" title={tr('tabsPickerTitle')}>
          {tr('tabsPickerText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('accessTitle')} caption={tr('accessCaption')}>
        <FieldTable
          nameHeader={tr('accessColumn')}
          descriptionHeader={tr('accessMeaningColumn')}
          rows={[row('accessConsumers'), row('accessWrites'), row('accessButtons')]}
        />
        <Callout tone="warning" title={tr('accessInactiveTitle')}>
          {tr('accessInactiveText')}
        </Callout>
      </HelpSection>
    </>
  );
}
