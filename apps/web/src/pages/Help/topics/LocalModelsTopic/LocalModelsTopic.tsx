import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { LOCAL_MODELS_TABS } from '@pages/LocalModels/model/tabs';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  Callout,
  OptionCards,
  GuideSteps,
  GuideStep,
  HelpShot,
  HelpDiagram,
  PageTabsSection,
} from '../../ui';

/**
 * Документ «Локальные модели».
 *
 * Читатель приходит с одним вопросом — «пойдёт ли это на моей карте и что
 * нажать», — поэтому схема и два пути по кадрам стоят раньше таблиц. Отдельный
 * раздел о границах обязателен: локальная модель слабее облачной, и умолчать об
 * этом значит научить человека винить агента в том, что сделала модель.
 */
export function LocalModelsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.localModels.${key}`);
  const g = (key: string): string => tr(`guide.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <PageTabsSection page="localModels" tabs={LOCAL_MODELS_TABS} />

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyFit'), text: tr('whyFitText') },
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyBack'), text: tr('whyBackText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="localModels" name="from-button-to-gpu" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('firstMachine')} text={g('firstMachineText')}>
            <HelpShot topic="localModels" scenario="first" frame="01-machine" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstCatalog')} text={g('firstCatalogText')}>
            <HelpShot topic="localModels" scenario="first" frame="02-catalog" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstPulling')} text={g('firstPullingText')}>
            <HelpShot topic="localModels" scenario="first" frame="03-pulling" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstReady')} text={g('firstReadyText')}>
            <HelpShot topic="localModels" scenario="first" frame="04-ready" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstAgents')} text={g('firstAgentsText')}>
            <HelpShot topic="localModels" scenario="first" frame="05-agents" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('choiceTitle')} caption={g('choiceCaption')}>
        <GuideSteps>
          <GuideStep title={g('choiceSelects')} text={g('choiceSelectsText')}>
            <HelpShot topic="localModels" scenario="choice" frame="01-selects" side="panel" />
          </GuideStep>
          <GuideStep title={g('choiceOther')} text={g('choiceOtherText')}>
            <HelpShot topic="localModels" scenario="choice" frame="02-other-quant" side="panel" />
          </GuideStep>
          <GuideStep title={g('choiceRestart')} text={g('choiceRestartText')}>
            <HelpShot topic="localModels" scenario="choice" frame="03-restart" side="panel" />
          </GuideStep>
          <GuideStep title={g('customForm')} text={g('customFormText')}>
            <HelpShot topic="localModels" scenario="choice" frame="04-custom-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('customRow')} text={g('customRowText')}>
            <HelpShot topic="localModels" scenario="choice" frame="05-custom-row" side="panel" />
          </GuideStep>
          <GuideStep title={g('filesRow')} text={g('filesRowText')}>
            <HelpShot topic="localModels" scenario="choice" frame="06-files" side="panel" />
          </GuideStep>
          <GuideStep title={g('filesConfirm')} text={g('filesConfirmText')}>
            <HelpShot topic="localModels" scenario="choice" frame="07-confirm" side="panel" />
          </GuideStep>
        </GuideSteps>
        <Callout tone="warning" title={g('choicePartialTitle')}>
          {g('choicePartialText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('fitTitle')} caption={tr('fitCaption')}>
        <FieldTable
          nameHeader={tr('fitHeader')}
          descriptionHeader={tr('fitWhat')}
          rows={[
            {
              name: tr('fitGpu'),
              description: tr('fitGpuText'),
              isMono: false,
            },
            {
              name: tr('fitPartial'),
              description: tr('fitPartialText'),
              isMono: false,
            },
            {
              name: tr('fitNone'),
              description: tr('fitNoneText'),
              isMono: false,
            },
            { name: tr('fitNoTools'), description: tr('fitNoToolsText'), isMono: false },
            { name: tr('fitSmall'), description: tr('fitSmallText'), isMono: false },
            { name: tr('fitCpu'), description: tr('fitCpuText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('deviceTitle')} caption={tr('deviceCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('deviceGpu'), text: tr('deviceGpuText') },
              { title: tr('deviceCpu'), text: tr('deviceCpuText') },
            ]}
          />
          <Callout tone="info" title={tr('deviceRestart')}>
            {tr('deviceRestartText')}
          </Callout>
          <Callout tone="warning" title={tr('deviceMac')}>
            {tr('deviceMacText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('memoryTitle')} caption={tr('memoryCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('memoryIdle'), text: tr('memoryIdleText') },
              { title: tr('memoryCache'), text: tr('memoryCacheText') },
            ]}
          />
          <Callout tone="info" title={tr('memoryChats')}>
            {tr('memoryChatsText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('longTitle')} caption={tr('longCaption')}>
        <OptionCards
          items={[
            { title: tr('longSupervisor'), text: tr('longSupervisorText') },
            { title: tr('longAwake'), text: tr('longAwakeText') },
            { title: tr('longDefer'), text: tr('longDeferText') },
            { title: tr('longContinue'), text: tr('longContinueText') },
            { title: tr('longMemory'), text: tr('longMemoryText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mcpTitle')} caption={tr('mcpCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('mcpWhy'), text: tr('mcpWhyText') },
              { title: tr('mcpHow'), text: tr('mcpHowText') },
            ]}
          />
          <Callout tone="info" title={tr('mcpHonest')}>
            {tr('mcpHonestText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('claudeTitle')} caption={tr('claudeCaption')}>
        <Stack gap="var(--spacing-xs)">
          <OptionCards
            items={[
              { title: tr('claudeOn'), text: tr('claudeOnText') },
              { title: tr('claudeOff'), text: tr('claudeOffText') },
            ]}
          />
          <Callout tone="warning" title={tr('claudeWhile')}>
            {tr('claudeWhileText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('kitTitle')} caption={tr('kitCaption')}>
        <FieldTable
          nameHeader={tr('kitHeader')}
          descriptionHeader={tr('kitWhat')}
          rows={[
            { name: tr('kitGlobal'), description: tr('kitGlobalText'), isMono: false },
            { name: tr('kitOurs'), description: tr('kitOursText'), isMono: false },
            {
              name: tr('kitHybrid'),
              description: tr('kitHybridText'),
              isMono: false,
              badge: 'Claude Code',
              badgeTone: 'info',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('runtimeTitle')}>
        <Callout tone="info" title={tr('runtimeTitle')}>
          {tr('runtimeText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('importTitle')} caption={tr('importLead')}>
        <OptionCards
          items={[
            { title: tr('importOk'), text: tr('importOkText') },
            { title: tr('importFail'), text: tr('importFailText') },
            { title: tr('importOwn'), text: tr('importOwnText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('filesTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title={tr('filesPanelTitle')}
            rows={[
              { label: tr('fileRuntime'), value: '.local-models/runtime/', isMono: true },
              { label: tr('fileModels'), value: '.local-models/models/', isMono: true },
              { label: tr('fileDownloads'), value: '.local-models/downloads/', isMono: true },
              { label: tr('fileTools'), value: '.local-models/tools/', isMono: true },
              { label: tr('fileLogs'), value: '.local-models/logs/llama.log', isMono: true },
              { label: tr('fileRecord'), value: '.local-models/run/llama.json', isMono: true },
              { label: tr('fileState'), value: '.local-models/state.json', isMono: true },
            ]}
          />
          <Callout tone="info" title={tr('fileModels')}>
            {tr('fileImport')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('limitsTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('limitWeakerTitle')}>
            {tr('limitWeakerText')}
          </Callout>
          <Callout tone="warning" title={tr('limitContextTitle')}>
            {tr('limitContextText')}
          </Callout>
          <Callout tone="info" title={tr('limitEstimateTitle')}>
            {tr('limitEstimateText')}
          </Callout>
          <Callout tone="info" title={tr('limitMemoryTitle')}>
            {tr('limitMemoryText')}
          </Callout>
          <Callout tone="info" title={tr('limitLocalTitle')}>
            {tr('limitLocalText')}
          </Callout>
        </Stack>
      </HelpSection>

      <Callout tone="info" title={tr('datasetsTitle')}>
        {tr('datasetsText')}
      </Callout>
    </>
  );
}
