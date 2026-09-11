import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Хуки»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из текста, — потом отказы по одному, и только в конце отмена. Человек
 * приходит сюда с вопросом «почему хук не сработал» и уходит с ответом «вот как
 * вернуть как было»; переставленные местами, эти блоки отвечают на второй
 * вопрос раньше первого.
 */
export function HooksLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.hooks.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canPreset'),
            tr('canScript'),
            tr('canMatcher'),
            tr('canBulkPresets'),
            tr('canAssistant'),
            tr('canProbe'),
            tr('canToggle'),
            tr('canOrder'),
            tr('canTimeout'),
          ]}
          cant={[
            tr('cantBlockAll'),
            tr('cantStable'),
            tr('cantLocal'),
            tr('cantDebug'),
            tr('cantProjectHooks'),
            tr('cantOrderEvents'),
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
            { name: tr('limitEvents'), description: tr('limitEventsValue'), isMono: false },
            { name: tr('limitTimeout'), description: tr('limitTimeoutValue'), isMono: false },
            { name: tr('limitId'), description: tr('limitIdValue'), isMono: false },
            {
              name: tr('limitLocalWrite'),
              description: tr('limitLocalWriteValue'),
              isMono: false,
            },
            { name: tr('limitProject'), description: tr('limitProjectValue'), isMono: false },
            { name: tr('limitApply'), description: tr('limitApplyValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteBrokenTitle')}>
            {tr('noteBrokenText')}
          </Callout>
          <Callout tone="warning" title={tr('noteExitTitle')}>
            {tr('noteExitText')}
          </Callout>
          <Callout tone="info" title={tr('noteIdTitle')}>
            {tr('noteIdText')}
          </Callout>
          <Callout tone="info" title={tr('noteDisabledTitle')}>
            {tr('noteDisabledText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteScriptTitle')}>
            {tr('noteScriptText')}
          </Callout>
          {/* Хуки OpenCode — принципиально другая модель; говорим об этом здесь,
              чтобы страница не выглядела описанием «хуков вообще». */}
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
            { title: tr('undoToggle'), text: tr('undoToggleText') },
            { title: tr('undoOrder'), text: tr('undoOrderText') },
            { title: tr('undoDelete'), text: tr('undoDeleteText') },
            { title: tr('undoBackup'), text: tr('undoBackupText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
