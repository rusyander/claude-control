import { Stack } from '@shared/ui/stack';
import { useTranslation } from 'react-i18next';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { PromptsGuideSections } from './PromptsGuideSections';
import { PromptsLimitsSections } from './PromptsLimitsSections';

/**
 * Документ «Промпты приложения» — вкладка настроек, а не свой раздел.
 *
 * Таблица «кто читает текст» набрана руками и повторяет поле `usedBy` каталога
 * (`domains/prompts/catalog.ts`). Дублирование намеренное: в коде лежит список
 * идентификаторов, здесь — ответ на единственный вопрос человека перед правкой,
 * «что изменится, если я это перепишу». Меняется каталог — правится эта таблица.
 *
 * Перенос описан словами, без кадров: план разворота показывает промпты строками
 * «новая / такая же / другая», и снять это можно только на второй машине с
 * готовым архивом — кадр, собранный подделкой, доказывал бы не то.
 */
export function PromptsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.prompts.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whySee'), text: tr('whySeeText') },
            { title: tr('whyKeep'), text: tr('whyKeepText') },
            { title: tr('whyBack'), text: tr('whyBackText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('layersTitle')} caption={tr('layersCaption')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('layerBuiltinTitle')}>
            {tr('layerBuiltinText')}
          </Callout>
          <Callout tone="info" title={tr('layerOverrideTitle')}>
            {tr('layerOverrideText')}
          </Callout>
        </Stack>
      </HelpSection>

      <PromptsGuideSections tr={tr} />

      <HelpSection title={tr('catalogTitle')} caption={tr('catalogCaption')}>
        <FieldTable
          nameHeader={tr('catalogColumn')}
          descriptionHeader={tr('catalogWhoColumn')}
          rows={[
            { name: tr('promptToolProtocol'), description: tr('promptToolProtocolText') },
            { name: tr('promptContourAgent'), description: tr('promptContourAgentText') },
            { name: tr('promptContourPreamble'), description: tr('promptContourPreambleText') },
            { name: tr('promptImage'), description: tr('promptImageText') },
            { name: tr('promptImageSvg'), description: tr('promptImageSvgText') },
            { name: tr('promptPresentation'), description: tr('promptPresentationText') },
          ].map((row) => ({ ...row, isMono: false }))}
        />
      </HelpSection>

      <PromptsLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('transferTitle')} caption={tr('transferCaption')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('transferOnlyTitle')}>
            {tr('transferOnlyText')}
          </Callout>
          <Callout tone="info" title={tr('transferPlanTitle')}>
            {tr('transferPlanText')}
          </Callout>
          <Callout tone="warning" title={tr('transferUnknownTitle')}>
            {tr('transferUnknownText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteChangedTitle')}>
            {tr('noteChangedText')}
          </Callout>
          <Callout tone="info" title={tr('noteSameTitle')}>
            {tr('noteSameText')}
          </Callout>
          <Callout tone="info" title={tr('noteBytesTitle')}>
            {tr('noteBytesText')}
          </Callout>
          <Callout tone="danger" title={tr('noteBreakTitle')}>
            {tr('noteBreakText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
