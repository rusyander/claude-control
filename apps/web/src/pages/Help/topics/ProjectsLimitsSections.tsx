import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Проекты»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает —
 * половина вопросов о проектном уровне звучит как «где тумблеры», и ответ на
 * них именно тут. Потом таблица границ: числа и условия, которые иначе пришлось
 * бы вылавливать из абзацев. Потом тонкости по одной, и только в конце отмена:
 * человек приходит сюда с вопросом «почему не сработало» и уходит с ответом
 * «вот как вернуть как было».
 */
export function ProjectsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.projects.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canRegister'),
            tr('canRules'),
            tr('canMcp'),
            tr('canPerms'),
            tr('canLocal'),
            tr('canForeign'),
            tr('canAdditive'),
            tr('canForget'),
          ]}
          cant={[
            tr('cantGroups'),
            tr('cantSandbox'),
            tr('cantLocalEdit'),
            tr('cantHealth'),
            tr('cantGit'),
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
            { name: tr('limitTabs'), description: tr('limitTabsValue'), isMono: false },
            { name: tr('limitReadOnly'), description: tr('limitReadOnlyValue'), isMono: false },
            { name: tr('limitCreate'), description: tr('limitCreateValue'), isMono: false },
            { name: tr('limitBackup'), description: tr('limitBackupValue'), isMono: false },
            { name: tr('limitApply'), description: tr('limitApplyValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteWriteTitle')}>
            {tr('noteWriteText')}
          </Callout>
          <Callout tone="warning" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteRawTitle')}>
            {tr('noteRawText')}
          </Callout>
          <Callout tone="info" title={tr('noteUserTitle')}>
            {tr('noteUserText')}
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
            { title: tr('undoEdit'), text: tr('undoEditText') },
            { title: tr('undoRemove'), text: tr('undoRemoveText') },
            { title: tr('undoLocal'), text: tr('undoLocalText') },
            { title: tr('undoProvider'), text: tr('undoProviderText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
