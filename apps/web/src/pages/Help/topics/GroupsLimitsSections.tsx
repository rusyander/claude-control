import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Группы»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из абзацев, — потом тонкости по одной, и только в конце отмена. Человек
 * приходит сюда с вопросом «почему не сработало» и уходит с ответом «вот как
 * вернуть как было»; переставленные местами, эти блоки отвечают на второй
 * вопрос раньше первого.
 */
export function GroupsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.groups.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canCollect'),
            tr('canToggleGroup'),
            tr('canGroupEnv'),
            tr('canBindProject'),
            tr('canSteps'),
            tr('canAutomation'),
            tr('canConflict'),
            tr('canSandbox'),
            tr('canNest'),
            tr('canAssistant'),
          ]}
          cant={[
            tr('cantKnow'),
            tr('cantMagic'),
            tr('cantOverride'),
            tr('cantRevive'),
            tr('cantAutoOff'),
            tr('cantPermSandbox'),
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
            { name: tr('limitMembers'), description: tr('limitMembersValue'), isMono: false },
            { name: tr('limitEvents'), description: tr('limitEventsValue'), isMono: false },
            { name: tr('limitExit'), description: tr('limitExitValue'), isMono: false },
            { name: tr('limitAuto'), description: tr('limitAutoValue'), isMono: false },
            { name: tr('limitRebuild'), description: tr('limitRebuildValue'), isMono: false },
            { name: tr('limitSandbox'), description: tr('limitSandboxValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteAutoOnTitle')}>
            {tr('noteAutoOnText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRebuildTitle')}>
            {tr('noteRebuildText')}
          </Callout>
          <Callout tone="warning" title={tr('noteLocalHookTitle')}>
            {tr('noteLocalHookText')}
          </Callout>
          <Callout tone="warning" title={tr('noteTriggerTitle')}>
            {tr('noteTriggerText')}
          </Callout>
          <Callout tone="info" title={tr('noteInvisibleTitle')}>
            {tr('noteInvisibleText')}
          </Callout>
          <Callout tone="info" title={tr('notePermTitle')}>
            {tr('notePermText')}
          </Callout>
          <Callout tone="info" title={tr('noteConflictTitle')}>
            {tr('noteConflictText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Отмена — последним блоком и одним списком: человек ищет её после того,
          как что-то уже сделал, и листать за ней весь путь заново не станет. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoOff'), text: tr('undoOffText') },
            { title: tr('undoDelete'), text: tr('undoDeleteText') },
            { title: tr('undoAuto'), text: tr('undoAutoText') },
            { title: tr('undoHook'), text: tr('undoHookText') },
            { title: tr('undoSkill'), text: tr('undoSkillText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
