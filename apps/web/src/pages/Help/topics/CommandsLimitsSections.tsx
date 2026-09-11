import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Команды»: граница возможностей, числа, тонкости и разбор.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из текста, — потом отказы по одному, и только в конце «команды не видно».
 * Отменять в читающем разделе нечего, поэтому последний блок отвечает не «как
 * вернуть», а «где смотреть»: именно с этим вопросом сюда и приходят повторно.
 */
export function CommandsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.commands.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canList'),
            tr('canSearch'),
            tr('canFilter'),
            tr('canFamily'),
            tr('canOpen'),
            tr('canDisabled'),
            tr('canProvider'),
          ]}
          cant={[
            tr('cantEdit'),
            tr('cantRun'),
            tr('cantTranslate'),
            tr('cantFresh'),
            tr('cantProject'),
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
            { name: tr('limitWrite'), description: tr('limitWriteValue'), isMono: false },
            { name: tr('limitCollision'), description: tr('limitCollisionValue'), isMono: false },
            { name: tr('limitRegistry'), description: tr('limitRegistryValue'), isMono: false },
            { name: tr('limitFiles'), description: tr('limitFilesValue'), isMono: false },
            {
              name: tr('limitDescription'),
              description: tr('limitDescriptionValue'),
              isMono: false,
            },
            { name: tr('limitBuiltins'), description: tr('limitBuiltinsValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('noteReadOnlyTitle')}>
            {tr('noteReadOnlyText')}
          </Callout>
          <Callout tone="info" title={tr('noteAutoTitle')}>
            {tr('noteAutoText')}
          </Callout>
          <Callout tone="warning" title={tr('noteBuiltinTitle')}>
            {tr('noteBuiltinText')}
          </Callout>
          <Callout tone="info" title={tr('noteDisabledTitle')}>
            {tr('noteDisabledText')}
          </Callout>
          <Callout tone="info" title={tr('noteDescTitle')}>
            {tr('noteDescText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Раздел ничего не пишет, поэтому вместо отмены — разбор: четыре причины,
          по которым команды не видно, и место, где каждая лечится. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoSkill'), text: tr('undoSkillText') },
            { title: tr('undoRegistry'), text: tr('undoRegistryText') },
            { title: tr('undoNothing'), text: tr('undoNothingText') },
            { title: tr('undoRestart'), text: tr('undoRestartText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
