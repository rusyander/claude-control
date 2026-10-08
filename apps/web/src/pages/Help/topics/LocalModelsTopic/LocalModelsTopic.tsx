import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
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

      <HelpSection title={tr('filesTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title={tr('filesPanelTitle')}
            rows={[
              { label: tr('fileRuntime'), value: '.local-models/runtime/', isMono: true },
              { label: tr('fileModels'), value: '.local-models/models/', isMono: true },
              { label: tr('fileDownloads'), value: '.local-models/downloads/', isMono: true },
              { label: tr('fileTools'), value: '.local-models/tools/', isMono: true },
              { label: tr('fileLogs'), value: '.local-models/logs/ollama.log', isMono: true },
              { label: tr('fileRecord'), value: '.local-models/run/ollama.json', isMono: true },
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
