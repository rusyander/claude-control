import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, CapabilityGrid, OptionCards, StepList } from '../ui';

/** Документ раздела «Сравнение конфигураций» — что где настроено и перенос между CLI. */
export function CompareTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.compare.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyMemory'), text: tr('whyMemoryText') },
            { title: tr('whyMeaning'), text: tr('whyMeaningText') },
            { title: tr('whyMove'), text: tr('whyMoveText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('readTitle')} caption={tr('readCaption')}>
        <OptionCards
          items={[
            { title: tr('readSame'), text: tr('readSameText') },
            { title: tr('readDiffers'), text: tr('readDiffersText') },
            { title: tr('readOnly'), text: tr('readOnlyText') },
            { title: tr('readSecret'), text: tr('readSecretText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('moveTitle')} caption={tr('moveCaption')}>
        <StepList
          steps={[
            { title: tr('moveStep1'), text: tr('moveStep1Text') },
            { title: tr('moveStep2'), text: tr('moveStep2Text') },
            { title: tr('moveStep3'), text: tr('moveStep3Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[tr('canCompare'), tr('canMcp'), tr('canInstructions'), tr('canPreview')]}
          cant={[tr('cantEnv'), tr('cantPermissions'), tr('cantDisabled')]}
        />
      </HelpSection>

      <Callout tone="warning" title={tr('noteTitle')}>
        {tr('noteText')}
      </Callout>
    </>
  );
}
