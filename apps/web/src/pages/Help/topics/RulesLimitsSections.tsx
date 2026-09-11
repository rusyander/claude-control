import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Правила»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из текста, — потом отказы по одному, и только в конце отмена. Человек
 * приходит сюда с вопросом «почему не сработало» и уходит с ответом «вот как
 * вернуть как было»; переставленные местами, эти блоки отвечают на второй
 * вопрос раньше первого.
 */
export function RulesLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.rules.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canWrite'),
            tr('canToggle'),
            tr('canSearch'),
            tr('canSandbox'),
            tr('canGroup'),
            tr('canAssistant'),
            tr('canEditByHand'),
            tr('canBackup'),
          ]}
          cant={[
            tr('cantProject'),
            tr('cantPriority'),
            tr('cantHistory'),
            tr('cantForce'),
            tr('cantLive'),
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
            { name: tr('limitReach'), description: tr('limitReachValue'), isMono: false },
            { name: tr('limitHeading'), description: tr('limitHeadingValue'), isMono: false },
            { name: tr('limitDuplicate'), description: tr('limitDuplicateValue'), isMono: false },
            { name: tr('limitBackups'), description: tr('limitBackupsValue'), isMono: false },
            { name: tr('limitSandbox'), description: tr('limitSandboxValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRenameTitle')}>
            {tr('noteRenameText')}
          </Callout>
          <Callout tone="danger" title={tr('noteSectionTitle')}>
            {tr('noteSectionText')}
          </Callout>
          <Callout tone="danger" title={tr('noteDeleteTitle')}>
            {tr('noteDeleteText')}
          </Callout>
          <Callout tone="info" title={tr('noteWordingTitle')}>
            {tr('noteWordingText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Отмена — последним блоком и одним списком: человек ищет её после того,
          как что-то уже сделал, и листать за ней весь путь заново не станет. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoToggle'), text: tr('undoToggleText') },
            { title: tr('undoEdit'), text: tr('undoEditText') },
            { title: tr('undoFile'), text: tr('undoFileText') },
            { title: tr('undoDelete'), text: tr('undoDeleteText') },
            { title: tr('undoGroup'), text: tr('undoGroupText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
