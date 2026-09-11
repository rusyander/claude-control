import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Скрипты»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из текста, — потом отказы по одному, и только в конце отмена. Человек
 * приходит сюда с вопросом «почему скрипт не сработал» и уходит с ответом «вот
 * как вернуть как было»; переставленные местами, эти блоки отвечают на второй
 * вопрос раньше первого.
 */
export function ScriptsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.scripts.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canWrite'),
            tr('canTemplate'),
            tr('canBulkTemplates'),
            tr('canProbe'),
            tr('canSee'),
            tr('canExpand'),
            tr('canRename'),
            tr('canLang'),
            tr('canAssistant'),
          ]}
          cant={[
            tr('cantAuto'),
            tr('cantSchedule'),
            tr('cantInstall'),
            tr('cantDebug'),
            tr('cantOutside'),
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
            { name: tr('limitFolder'), description: tr('limitFolderValue'), isMono: false },
            { name: tr('limitExt'), description: tr('limitExtValue'), isMono: false },
            { name: tr('limitTests'), description: tr('limitTestsValue'), isMono: false },
            { name: tr('limitUsage'), description: tr('limitUsageValue'), isMono: false },
            { name: tr('limitRun'), description: tr('limitRunValue'), isMono: false },
            { name: tr('limitApply'), description: tr('limitApplyValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteDeleteTitle')}>
            {tr('noteDeleteText')}
          </Callout>
          <Callout tone="warning" title={tr('noteUnusedTitle')}>
            {tr('noteUnusedText')}
          </Callout>
          <Callout tone="info" title={tr('noteInterpreterTitle')}>
            {tr('noteInterpreterText')}
          </Callout>
          <Callout tone="info" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
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
            { title: tr('undoUnbind'), text: tr('undoUnbindText') },
            { title: tr('undoEdit'), text: tr('undoEditText') },
            { title: tr('undoBackup'), text: tr('undoBackupText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
