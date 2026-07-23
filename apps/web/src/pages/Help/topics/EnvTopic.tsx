import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  StepList,
  Callout,
  CapabilityGrid,
  OptionCards,
} from '../ui';

/** Документ раздела «Переменные». */
export function EnvTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.env.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whySeparate'), text: tr('whySeparateText') },
            { title: tr('whyMasked'), text: tr('whyMaskedText') },
            { title: tr('whyBulk'), text: tr('whyBulkText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSettings'), value: tr('storageSettingsValue'), isMono: true },
            { label: tr('storageLocal'), value: tr('storageLocalValue'), isMono: true },
            { label: tr('storageSecrets'), value: tr('storageSecretsValue'), isMono: true },
            { label: tr('storageWhoReads'), value: tr('storageWhoReadsValue') },
            { label: tr('storageDetect'), value: tr('storageDetectValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'name',
              label: tr('flowName'),
              caption: tr('flowNameCaption'),
              tone: 'accent',
              icon: 'env',
            },
            {
              id: 'detect',
              label: tr('flowDetect'),
              caption: tr('flowDetectCaption'),
              tone: 'warning',
              icon: 'search',
            },
            {
              id: 'secrets',
              label: tr('flowSecrets'),
              caption: tr('flowSecretsCaption'),
              tone: 'danger',
              isMono: true,
              icon: 'eyeOff',
            },
            {
              id: 'settings',
              label: tr('flowSettings'),
              caption: tr('flowSettingsCaption'),
              tone: 'info',
              isMono: true,
              icon: 'file',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canTwo'),
            tr('canAuto'),
            tr('canReveal'),
            tr('canBulkAdd'),
            tr('canComment'),
            tr('canAssistant'),
            tr('canMove'),
          ]}
          cant={[tr('cantEdit'), tr('cantEncrypt'), tr('cantScope'), tr('cantSee')]}
        />
      </HelpSection>

      <HelpSection title={tr('placesTitle')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('placeSettings'), text: tr('placeSettingsText') },
            { title: tr('placeSecrets'), text: tr('placeSecretsText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'key',
              description: tr('fieldKey'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'value',
              description: tr('fieldValue'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'source', description: tr('fieldSource') },
            { name: 'isSecret', description: tr('fieldIsSecret') },
            { name: 'comment', description: tr('fieldComment') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('recipesTitle')}>
        <StepList
          steps={[
            { title: tr('recipe1'), text: tr('recipe1Text') },
            { title: tr('recipe2'), text: tr('recipe2Text') },
            { title: tr('recipe3'), text: tr('recipe3Text') },
            { title: tr('recipe4'), text: tr('recipe4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRewriteTitle')}>
            {tr('noteRewriteText')}
          </Callout>
          <Callout tone="warning" title={tr('noteDetectTitle')}>
            {tr('noteDetectText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteRevealTitle')}>
            {tr('noteRevealText')}
          </Callout>
          <Callout tone="success" title={tr('noteCommentsTitle')}>
            {tr('noteCommentsText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
