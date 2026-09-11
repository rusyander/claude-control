import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { SettingsGuideSections } from './SettingsGuideSections';
import { SettingsLimitsSections } from './SettingsLimitsSections';

/**
 * Документ раздела «Настройки».
 *
 * Порядок общий для пачки «Доступы»: зачем это вообще → что происходит перед
 * записью (схема) → два пути в снимках → чем раздел НЕ является → что пишет на
 * диске → пределы и отказы → справочные таблицы → тонкости.
 *
 * Рукописного списка шагов мастера здесь больше нет: те же четыре шага теперь
 * показаны кадрами настоящего мастера. Описание шага словами и снимок того же
 * шага расходятся при первой же правке интерфейса, и расходятся молча.
 */
export function SettingsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.settings.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная: первое, что ей нужно сказать, — из чего она состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyPath'), text: tr('whyPathText') },
            { title: tr('whySandbox'), text: tr('whySandboxText') },
            { title: tr('whyComfort'), text: tr('whyComfortText') },
          ]}
        />
      </HelpSection>

      <SettingsGuideSections tr={tr} />

      <SettingsLimitsSections
        tr={tr}
        common={common}
        platform={{
          title: t('help.topics.platform.title'),
          summary: t('help.topics.platform.summary'),
        }}
      />

      <HelpSection title={tr('tabsTitle')} caption={tr('tabsCaption')}>
        <OptionCards
          items={[
            { title: tr('tabGeneral'), text: tr('tabGeneralText') },
            { title: tr('tabAccess'), text: tr('tabAccessText') },
            { title: tr('tabProviders'), text: tr('tabProvidersText') },
            { title: tr('tabModels'), text: tr('tabModelsText') },
            { title: tr('tabSpend'), text: tr('tabSpendText') },
            { title: tr('tabSafety'), text: tr('tabSafetyText') },
            { title: tr('tabTransfer'), text: tr('tabTransferText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('cardsTitle')} caption={tr('cardsCaption')}>
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

      <HelpSection title={tr('remoteTitle')} caption={tr('remoteCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('remoteAddress'), text: tr('remoteAddressText') },
              { title: tr('remoteToken'), text: tr('remoteTokenText') },
              { title: tr('remotePair'), text: tr('remotePairText') },
              { title: tr('remoteNotify'), text: tr('remoteNotifyText') },
            ]}
          />
          <Callout tone="warning" title={tr('remoteWarnTitle')}>
            {tr('remoteWarnText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('modelsTitle')} caption={tr('modelsCaption')}>
        <OptionCards
          items={[
            { title: tr('modelsWhere'), text: tr('modelsWhereText') },
            { title: tr('modelsPlatform'), text: tr('modelsPlatformText') },
            { title: tr('modelsRetired'), text: tr('modelsRetiredText') },
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
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
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
