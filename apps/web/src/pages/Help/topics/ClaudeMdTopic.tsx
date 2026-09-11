import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';
import { ClaudeMdGuideSections } from './ClaudeMdGuideSections';
import { ClaudeMdLayersSections } from './ClaudeMdLayersSections';

/**
 * Документ раздела «CLAUDE.md».
 *
 * Порядок тот же, что у остальных путеводителей: зачем это нужно → чем это НЕ
 * является → как устроено и путь в снимках → где ещё лежат инструкции и чьё
 * правило главнее → что уходит на диск → границы, тонкости и отмена.
 *
 * Соседний документ «Правила» описывает ТОТ ЖЕ файл, разобранный на карточки,
 * поэтому «чем это не является» здесь стоит вторым блоком: без него читатель
 * видит два способа править одно и то же и не знает, какой брать.
 *
 * Уровни инструкций — половина документа не случайно. Самый частый вопрос про
 * правила («написал, а агент не выполняет») почти никогда не про этот файл, и
 * ответ на него — соседний уровень, а не отказ правила.
 */
export function ClaudeMdTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.claudeMd.${key}`);

  return (
    <>
      {/* Страница длинная, и первое, что ей нужно сказать, — из чего она
          состоит: иначе человек, которому нужен один факт, листает наугад. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyWhole'), text: tr('whyWholeText') },
            { title: tr('whyRaw'), text: tr('whyRawText') },
            { title: tr('whyFast'), text: tr('whyFastText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffRules'), text: tr('diffRulesText') },
            { title: tr('diffProject'), text: tr('diffProjectText') },
            { title: tr('diffPreview'), text: tr('diffPreviewText') },
            { title: tr('diffHistory'), text: tr('diffHistoryText') },
          ]}
        />
      </HelpSection>

      <ClaudeMdGuideSections tr={tr} />

      <ClaudeMdLayersSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="CLAUDE.md"
          rows={[
            { label: tr('storageFile'), value: '~/.claude/CLAUDE.md', isMono: true },
            { label: tr('storageFormat'), value: tr('storageFormatValue') },
            { label: tr('storageReader'), value: tr('storageReaderValue') },
            { label: tr('storageWatch'), value: tr('storageWatchValue') },
            { label: tr('storageWrite'), value: tr('storageWriteValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/agentdeck/backups/',
              isMono: true,
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canSeeAll'),
            tr('canEditAnything'),
            tr('canOrder'),
            tr('canRevert'),
            tr('canFixParse'),
            tr('canFollow'),
          ]}
          cant={[
            tr('cantProject'),
            tr('cantPreview'),
            tr('cantToggle'),
            tr('cantHistory'),
            tr('cantMerge'),
          ]}
        />
      </HelpSection>

      {/* Числа таблицей, а не россыпью по абзацам: за ними приходят повторно и
          ищут глазами, а не чтением. */}
      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('limitLevel'), description: tr('limitLevelValue'), isMono: false },
            { name: tr('limitSave'), description: tr('limitSaveValue'), isMono: false },
            { name: tr('limitConflict'), description: tr('limitConflictValue'), isMono: false },
            { name: tr('limitBackups'), description: tr('limitBackupsValue'), isMono: false },
            { name: tr('limitReach'), description: tr('limitReachValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="danger" title={tr('noteDisabledTitle')}>
            {tr('noteDisabledText')}
          </Callout>
          <Callout tone="warning" title={tr('noteConflictTitle')}>
            {tr('noteConflictText')}
          </Callout>
          <Callout tone="info" title={tr('noteBackupTitle')}>
            {tr('noteBackupText')}
          </Callout>
          <Callout tone="success" title={tr('noteHeadingTitle')}>
            {tr('noteHeadingText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Отмена — последним блоком и одним списком: человек ищет её после того,
          как что-то уже сделал, и листать за ней весь путь заново не станет. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoRevert'), text: tr('undoRevertText') },
            { title: tr('undoConflict'), text: tr('undoConflictText') },
            { title: tr('undoBackup'), text: tr('undoBackupText') },
            { title: tr('undoDisabled'), text: tr('undoDisabledText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
