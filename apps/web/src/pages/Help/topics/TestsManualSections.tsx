import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, StepList } from '../ui';

/**
 * Соседние разделы документа «Тесты» про то, как по кейсам идёт ЧЕЛОВЕК:
 * ручной проход с клавишами и первые шаги в проекте, где ещё ничего нет.
 * Вынесены из `TestsTopic` целиком — вместе они переваливали документ за
 * предел длины файла.
 */
export function TestsManualSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      <HelpSection title={tr('manualTitle')} caption={tr('manualCaption')}>
        <StepList
          steps={[
            { title: tr('manualStep1'), text: tr('manualStep1Text') },
            { title: tr('manualStep2'), text: tr('manualStep2Text') },
            { title: tr('manualStep3'), text: tr('manualStep3Text') },
            { title: tr('manualStep4'), text: tr('manualStep4Text') },
            { title: tr('manualStep5'), text: tr('manualStep5Text') },
          ]}
        />
        <Callout tone="info" title={tr('manualKeysTitle')}>
          {tr('manualKeysText')}
        </Callout>
        <Callout tone="info" title={tr('manualPhoneTitle')}>
          {tr('manualPhoneText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('firstStepsTitle')} caption={tr('firstStepsCaption')}>
        <StepList
          steps={[
            { title: tr('firstStepsEnv'), text: tr('firstStepsEnvText') },
            { title: tr('firstStepsGenerate'), text: tr('firstStepsGenerateText') },
            { title: tr('firstStepsRun'), text: tr('firstStepsRunText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
