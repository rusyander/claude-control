import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, Callout, OptionCards, StepList } from '../ui';
import { ChatGuideSections } from './ChatGuideSections';
import { ChatParallelSections } from './ChatParallelSections';
import { ChatFieldSections } from './ChatFieldSections';
import { ChatLimitsSections } from './ChatLimitsSections';

/**
 * Документ раздела «Чат» — самый длинный в справке, и порядок в нём один:
 * зачем это нужно → чем отличается от соседнего → весь путь шагами со
 * снимками → таблицы полей и состояний → ограничения и отказы → как отменить.
 *
 * Раньше документ был перечнем возможностей: человек читал, ЧТО умеет раздел,
 * и не видел ни одного экрана, пока не открывал панель. Теперь середина —
 * настоящие кадры двух путей, снятые на отдельной панели с выдуманным
 * проектом, и каждый шаг назван значениями из своего кадра. Список
 * возможностей остался, но уехал в конец: он отвечает на вопрос «а можно ли», а
 * этот вопрос возникает после того, как человек уже видел, как оно выглядит.
 *
 * Соседние файлы — не «вынесенные куски», а разделы с собственной работой:
 * `ChatGuideSections` держит схемы и весь путь в снимках, `ChatParallelSections`
 * — копии, разделение, подбор модели и продолжение этапа, `ChatFieldSections` —
 * таблицы, `ChatLimitsSections` — границы, отказы и отмену.
 */
export function ChatTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

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
            { title: tr('whyParallel'), text: tr('whyParallelText') },
            { title: tr('whyHistory'), text: tr('whyHistoryText') },
            { title: tr('whyVisible'), text: tr('whyVisibleText') },
          ]}
        />
      </HelpSection>

      {/* Отличия — сразу после «зачем»: половина вопросов про чат на самом деле
          вопросы «а это здесь или в другом разделе». */}
      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffTerminal'), text: tr('diffTerminalText') },
            { title: tr('diffHistory'), text: tr('diffHistoryText') },
            { title: tr('diffForeign'), text: tr('diffForeignText') },
            { title: tr('diffSandbox'), text: tr('diffSandboxText') },
          ]}
        />
      </HelpSection>

      <ChatGuideSections tr={tr} />

      {/* Картинка и презентация стоят сразу после пути и ДО таблицы «где что
          лежит»: это единственные два режима, где файл делает панель, а не
          агент своими инструментами, и следующий вопрос человека — «где тогда
          лежит результат». Ответ — строкой ниже. */}
      <HelpSection title={tr('imageTitle')} caption={tr('imageCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('imageWho'), text: tr('imageWhoText') },
            { title: tr('imageAgent'), text: tr('imageAgentText') },
            { title: tr('deckWho'), text: tr('deckWhoText') },
            { title: tr('deckAsk'), text: tr('deckAskText') },
            { title: tr('deckLook'), text: tr('deckLookText') },
            { title: tr('deckPictures'), text: tr('deckPicturesText') },
            { title: tr('deckRevise'), text: tr('deckReviseText') },
            { title: tr('imageRoute'), text: tr('imageRouteText') },
            { title: tr('imageCard'), text: tr('imageCardText') },
            { title: tr('imageLocked'), text: tr('imageLockedText') },
            { title: tr('imagePrompt'), text: tr('imagePromptText') },
          ]}
        />
        <Callout tone="warning" title={tr('imageLimitTitle')}>
          {tr('imageLimitText')}
        </Callout>
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageTranscripts'), value: tr('storageTranscriptsValue'), isMono: true },
            { label: tr('storageWhatRuns'), value: tr('storageWhatRunsValue'), isMono: true },
            { label: tr('storageSandbox'), value: tr('storageSandboxValue'), isMono: true },
            { label: tr('storageImages'), value: tr('storageImagesValue'), isMono: true },
            { label: tr('storageDecks'), value: tr('storageDecksValue'), isMono: true },
            { label: tr('storageStream'), value: tr('storageStreamValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('tabsTitle')} caption={tr('tabsCaption')}>
        <OptionCards
          items={[
            { title: tr('tabHome'), text: tr('tabHomeText') },
            { title: tr('tabProject'), text: tr('tabProjectText') },
            { title: tr('tabAdd'), text: tr('tabAddText') },
            { title: tr('tabOrder'), text: tr('tabOrderText') },
          ]}
        />
        <Callout tone="info" title={tr('tabsNote')} />
      </HelpSection>

      <HelpSection title={tr('toolsTitle')} caption={tr('toolsCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('toolsRun'), text: tr('toolsRunText') },
            { title: tr('toolsPort'), text: tr('toolsPortText') },
            { title: tr('toolsAutostart'), text: tr('toolsAutostartText') },
            { title: tr('toolsGit'), text: tr('toolsGitText') },
            { title: tr('toolsBranchMark'), text: tr('toolsBranchMarkText') },
            { title: tr('toolsPull'), text: tr('toolsPullText') },
            { title: tr('toolsPush'), text: tr('toolsPushText') },
          ]}
        />
        <Callout tone="info" title={tr('toolsNote')} />
      </HelpSection>

      {/* Копии репозитория и разделение задач — соседним файлом: два раздела об
          одном и том же, а документ и без них самый длинный в справке. */}
      <ChatParallelSections />

      <HelpSection title={tr('codeTitle')} caption={tr('codeCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('codeTree'), text: tr('codeTreeText') },
            { title: tr('codeDiff'), text: tr('codeDiffText') },
            { title: tr('codePreview'), text: tr('codePreviewText') },
            { title: tr('codeEdit'), text: tr('codeEditText') },
            { title: tr('codeMemory'), text: tr('codeMemoryText') },
          ]}
        />
        <Callout tone="warning" title={tr('codeLimitsTitle')}>
          {tr('codeLimitsText')}
        </Callout>
        <Callout tone="info" title={tr('codeSaveTitle')}>
          {tr('codeSaveText')}
        </Callout>
      </HelpSection>

      {/* Тесты выросли из кнопки на вкладке проекта в собственный раздел, и
          документ у них теперь свой. Здесь остаётся указатель: искать их будут
          там, где раньше нашли, — в справке по чату. */}
      <HelpSection title={tr('testsTitle')} caption={tr('testsCaption')}>
        <Callout tone="info" title={tr('testsMovedTitle')}>
          {tr('testsMovedText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('askTitle')} caption={tr('askCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('askOrder'), text: tr('askOrderText') },
            { title: tr('askOwn'), text: tr('askOwnText') },
            { title: tr('askChange'), text: tr('askChangeText') },
            { title: tr('askBusy'), text: tr('askBusyText') },
            { title: tr('askSent'), text: tr('askSentText') },
          ]}
        />
        <Callout tone="info" title={tr('askOldTitle')}>
          {tr('askOldText')}
        </Callout>
        {/* Потерянная связь стоит здесь же: человек ищет объяснение там, где
            ждал ответа, — в разделе про вопросы и ожидание. */}
        <Callout tone="warning" title={tr('lostTitle')}>
          {tr('lostText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('panelTitle')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('panelAgents'), text: tr('panelAgentsText') },
            { title: tr('panelParallel'), text: tr('panelParallelText') },
            { title: tr('panelParallelModel'), text: tr('panelParallelModelText') },
            { title: tr('panelParallelCost'), text: tr('panelParallelCostText') },
            { title: tr('panelParallelJournal'), text: tr('panelParallelJournalText') },
            { title: tr('panelParallelTree'), text: tr('panelParallelTreeText') },
          ]}
        />
        <Callout tone="info" title={tr('panelNote')} />
      </HelpSection>

      <ChatFieldSections />

      <HelpSection title={tr('recipesTitle')}>
        <StepList
          steps={[
            { title: tr('recipe1'), text: tr('recipe1Text') },
            { title: tr('recipe2'), text: tr('recipe2Text') },
            { title: tr('recipe3'), text: tr('recipe3Text') },
            { title: tr('recipe4'), text: tr('recipe4Text') },
          ]}
        />
      </HelpSection>

      <ChatLimitsSections />
    </>
  );
}
