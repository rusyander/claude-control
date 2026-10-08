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
 * Документ «Набор панели».
 *
 * Первый вопрос читателя — «не сломает ли это мою папку `~/.claude`», поэтому
 * схема пути до прогона стоит раньше кадров. Таблица CLI обязательна: режим
 * виден у всех, а работает не у всех, и без неё человек решит, что набор у
 * Codex просто «не сработал».
 */
export function KitTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.kit.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);
  const row = (key: string) => ({
    name: tr(key),
    description: tr(`${key}Text`),
    isMono: false,
  });

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyClean'), text: tr('whyCleanText') },
            { title: tr('whyYours'), text: tr('whyYoursText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="kit" name="kit-to-run" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('modesTitle')} caption={tr('modesCaption')}>
        <GuideSteps>
          <GuideStep title={tr('modesTitle')} text={tr('modesCaption')}>
            <HelpShot topic="kit" scenario="page" frame="01-modes" side="panel" />
          </GuideStep>
        </GuideSteps>
        <FieldTable
          nameHeader={tr('modeHeader')}
          descriptionHeader={tr('modeWhat')}
          rows={[row('modeGlobal'), row('modeHybrid'), row('modeOurs')]}
        />
      </HelpSection>

      <HelpSection title={tr('cliTitle')} caption={tr('cliCaption')}>
        <FieldTable
          nameHeader={tr('cliHeader')}
          descriptionHeader={tr('cliWhat')}
          rows={[row('cliClaude'), row('cliQwen'), row('cliCodex'), row('cliOther')]}
        />
      </HelpSection>

      <HelpSection title={tr('globalTitle')} caption={tr('globalCaption')}>
        <GuideSteps>
          <GuideStep title={tr('globalDiffers')} text={tr('globalCaption')}>
            <HelpShot topic="kit" scenario="page" frame="02-items" side="panel" />
          </GuideStep>
          <GuideStep title={tr('globalDiffers')} text={tr('globalDiffersText')}>
            <HelpShot topic="kit" scenario="page" frame="03-diff" side="panel" />
          </GuideStep>
          <GuideStep title={tr('globalTake')} text={tr('globalTakeText')}>
            <HelpShot topic="kit" scenario="page" frame="04-global-only" side="panel" />
          </GuideStep>
        </GuideSteps>
        <FieldTable
          nameHeader={tr('globalHeader')}
          descriptionHeader={tr('globalWhat')}
          rows={[
            row('globalSame'),
            row('globalDiffers'),
            row('globalAbsent'),
            row('globalTo'),
            row('globalFrom'),
            row('globalTake'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('filesTitle')} caption={tr('filesCaption')}>
        <StorageCard
          title={tr('filesPanelTitle')}
          rows={[
            {
              label: tr('fileBuiltin'),
              value: 'apps/server/assets/kit/agentdeck-kit/',
              isMono: true,
            },
            { label: tr('fileMine'), value: 'agentdeck/kit/mine/', isMono: true },
            { label: tr('fileArchive'), value: 'agentdeck/kit/archive/', isMono: true },
            { label: tr('fileState'), value: 'agentdeck/kit/state.json', isMono: true },
            { label: tr('fileEffective'), value: 'agentdeck/kit/effective/', isMono: true },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('limitRulesTitle')}>
            {tr('limitRulesText')}
          </Callout>
          <Callout tone="warning" title={tr('limitHooksTitle')}>
            {tr('limitHooksText')}
          </Callout>
          <Callout tone="info" title={tr('limitKeysTitle')}>
            {tr('limitKeysText')}
          </Callout>
          <Callout tone="info" title={tr('limitEnglishTitle')}>
            {tr('limitEnglishText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
