import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Настройки». */
export function SettingsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.settings.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyPath'), text: tr('whyPathText') },
            { title: tr('whySandbox'), text: tr('whySandboxText') },
            { title: tr('whyComfort'), text: tr('whyComfortText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageApp'), value: tr('storageAppValue') },
            { label: tr('storageManual'), value: tr('storageManualValue'), isMono: true },
            { label: tr('storageBackups'), value: tr('storageBackupsValue'), isMono: true },
            { label: tr('storageApply'), value: tr('storageApplyValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canPath'),
            tr('canCreds'),
            tr('canEditor'),
            tr('canTheme'),
            tr('canSpendUnit'),
            tr('canBackup'),
            tr('canEncrypt'),
            tr('canRevertHunk'),
            tr('canTransfer'),
            tr('canWatch'),
          ]}
          cant={[tr('cantLogin'), tr('cantToken'), tr('cantChange'), tr('cantSync')]}
        />
      </HelpSection>

      <HelpSection title={tr('cardsTitle')}>
        <OptionCards
          items={[
            { title: tr('cardAccount'), text: tr('cardAccountText') },
            { title: tr('cardDir'), text: tr('cardDirText') },
            { title: tr('cardCreds'), text: tr('cardCredsText') },
            { title: tr('cardEditor'), text: tr('cardEditorText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('credsTitle')} caption={tr('credsCaption')}>
        <PriorityLadder
          ariaLabel={tr('credsTitle')}
          topLabel={tr('credsTop')}
          steps={[
            { id: 'panel', label: 'panel', caption: tr('credsManual'), tone: 'accent' },
            { id: 'file', label: 'file', caption: tr('credsFile'), tone: 'info' },
            { id: 'keychain', label: 'keychain', caption: tr('credsKeychain'), tone: 'warning' },
            { id: 'apiKey', label: 'apiKey', caption: tr('credsApiKey') },
          ]}
        />
        <Callout tone="info" title={tr('credsNote')} />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: 'theme', description: tr('fieldTheme') },
            { name: 'language', description: tr('fieldLanguage') },
            { name: 'claudeDirOverride', description: tr('fieldDir') },
            { name: 'revealSecretsByDefault', description: tr('fieldReveal') },
            { name: 'backupBeforeWrite', description: tr('fieldBackup') },
            { name: 'encryptSecretBackups', description: tr('fieldEncrypt') },
            { name: 'watchFiles', description: tr('fieldWatch') },
            { name: 'largeText, reduceMotion, highContrast', description: tr('fieldA11y') },
            { name: 'editor', description: tr('fieldEditor') },
            { name: 'costUnit', description: tr('fieldCostUnit') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteManualTitle')}>
            {tr('noteManualText')}
          </Callout>
          <Callout tone="info" title={tr('noteSandboxTitle')}>
            {tr('noteSandboxText')}
          </Callout>
          <Callout tone="info" title={tr('noteMacTitle')}>
            {tr('noteMacText')}
          </Callout>
          <Callout tone="success" title={tr('noteBackupTitle')}>
            {tr('noteBackupText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
