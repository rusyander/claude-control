import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, OptionCards } from '../ui';

/**
 * Раздел документа «Тесты» про окно настроек набора.
 *
 * Стоит сразу за библиотекой: окружения, общие шаги и свои поля описаны там как
 * часть формата, а здесь — где их завести руками с экрана. Вынесен отдельным
 * файлом по той же причине, что и `TestsManualSections`: документ упирается в
 * предел длины.
 */
export function TestsSetupSection() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <HelpSection title={tr('setupTitle')} caption={tr('setupCaption')}>
      <OptionCards
        minWidth={280}
        items={[
          { title: tr('setupEnv'), text: tr('setupEnvText') },
          { title: tr('setupSteps'), text: tr('setupStepsText') },
          { title: tr('setupFields'), text: tr('setupFieldsText') },
          { title: tr('setupSecrets'), text: tr('setupSecretsText') },
        ]}
      />
      <Callout tone="warning" title={tr('setupRemoveTitle')}>
        {tr('setupRemoveText')}
      </Callout>
      <Callout tone="warning" title={tr('setupBrokenTitle')}>
        {tr('setupBrokenText')}
      </Callout>
    </HelpSection>
  );
}
