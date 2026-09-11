import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Чат»: что раздел умеет и чего не делает, тонкости, о которые
 * спотыкаются, и как отменить каждое из перечисленного.
 *
 * Порядок здесь и есть смысл файла. Сначала граница возможностей, потом
 * отказы — по одному, с причиной, — и только в конце отмена. Человек приходит
 * сюда с готовым вопросом «почему не сработало» и уходит с ответом «вот как
 * вернуть как было»; переставленные местами, эти три блока отвечают на второй
 * вопрос раньше первого.
 */
export function ChatLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canParallel'),
            tr('canQueue'),
            tr('canProgress'),
            tr('canChatDots'),
            tr('canVolume'),
            tr('canContinue'),
            tr('canFork'),
            tr('canAnswerButtons'),
            tr('canModel'),
            tr('canApprove'),
            tr('canSearchMessages'),
            tr('canLoadMore'),
            tr('canExport'),
            tr('canRun'),
            tr('canFreePort'),
            tr('canAutostart'),
            tr('canGit'),
            tr('canWorktrees'),
            tr('canOpenFolder'),
            tr('canAttach'),
            tr('canVoice'),
            tr('canStop'),
            tr('canRetry'),
            tr('canSpend'),
            tr('canEditor'),
            tr('canCode'),
            tr('canTests'),
          ]}
          cant={[tr('cantApprove'), tr('cantDelete'), tr('cantEditPlan'), tr('cantInterrupt')]}
        />
      </HelpSection>

      <HelpSection title={tr('retryTitle')} caption={tr('retryCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('retryRepeat'), text: tr('retryRepeatText') },
            { title: tr('retryFull'), text: tr('retryFullText') },
          ]}
        />
        <Callout tone="danger" title={tr('retryNoteTitle')}>
          {tr('retryNoteText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteTabTitle')}>
            {tr('noteTabText')}
          </Callout>
          <Callout tone="info" title={tr('noteQuestionTitle')}>
            {tr('noteQuestionText')}
          </Callout>
          <Callout tone="info" title={tr('noteOutsideTitle')}>
            {tr('noteOutsideText')}
          </Callout>
          <Callout tone="info" title={tr('noteArtifactsTitle')}>
            {tr('noteArtifactsText')}
          </Callout>
          <Callout tone="info" title={tr('noteLimitTitle')}>
            {tr('noteLimitText')}
          </Callout>
          <Callout tone="info" title={tr('noteMemoryTitle')}>
            {tr('noteMemoryText')}
          </Callout>
          <Callout tone="info" title={tr('noteHistoryTitle')}>
            {tr('noteHistoryText')}
          </Callout>
          <Callout tone="info" title={tr('noteLiveTitle')}>
            {tr('noteLiveText')}
          </Callout>
          <Callout tone="info" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Отмена — последним блоком документа и одним списком: человек ищет её
          после того, как что-то уже сделал, и листать за ней весь путь по
          снимкам заново он не станет. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoStop'), text: tr('undoStopText') },
            { title: tr('undoDecline'), text: tr('undoDeclineText') },
            { title: tr('undoWorktree'), text: tr('undoWorktreeText') },
            { title: tr('undoHandoff'), text: tr('undoHandoffText') },
            { title: tr('undoCascade'), text: tr('undoCascadeText') },
            { title: tr('undoChat'), text: tr('undoChatText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
