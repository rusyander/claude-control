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
            tr('canEnvTransfer'),
            tr('canModels'),
            tr('canCheck'),
            tr('canPreview'),
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

      <HelpSection title={tr('modelsTitle')} caption={tr('modelsCaption')}>
        <OptionCards
          items={[
            { title: tr('modelsWhere'), text: tr('modelsWhereText') },
            { title: tr('modelsAuto'), text: tr('modelsAutoText') },
            { title: tr('modelsWho'), text: tr('modelsWhoText') },
            { title: tr('modelsOff'), text: tr('modelsOffText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('checkTitle')} caption={tr('checkCaption')}>
        <OptionCards
          items={[
            { title: tr('checkWhat'), text: tr('checkWhatText') },
            { title: tr('checkSafe'), text: tr('checkSafeText') },
            { title: tr('checkResult'), text: tr('checkResultText') },
            { title: tr('checkBadge'), text: tr('checkBadgeText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('formatTitle')} caption={tr('formatCaption')}>
        <OptionCards
          items={[
            { title: tr('formatWhat'), text: tr('formatWhatText') },
            { title: tr('formatWho'), text: tr('formatWhoText') },
            { title: tr('formatDrift'), text: tr('formatDriftText') },
            { title: tr('formatWhen'), text: tr('formatWhenText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('previewTitle')} caption={tr('previewCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('previewWhen'), text: tr('previewWhenText') },
              { title: tr('previewHow'), text: tr('previewHowText') },
              { title: tr('previewRead'), text: tr('previewReadText') },
              { title: tr('previewOff'), text: tr('previewOffText') },
            ]}
          />
          <Callout tone="info" title={tr('previewNoise')}>
            {tr('previewNoiseText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('transferTitle')} caption={tr('transferCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('transferExport'), text: tr('transferExportText') },
              { title: tr('transferImport'), text: tr('transferImportText') },
              { title: tr('transferContent'), text: tr('transferContentText') },
              { title: tr('transferPaths'), text: tr('transferPathsText') },
            ]}
          />
          <Callout tone="warning" title={tr('transferSecretsTitle')}>
            {tr('transferSecretsText')}
          </Callout>
        </Stack>
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
