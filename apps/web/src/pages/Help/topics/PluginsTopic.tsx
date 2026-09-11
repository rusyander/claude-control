import { useTranslation } from 'react-i18next';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, StepList, Callout, OptionCards } from '../ui';
import { PluginsGuideSections } from './PluginsGuideSections';
import { PluginsLimitsSections } from './PluginsLimitsSections';

/**
 * Документ раздела «Плагины».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * идёт установка и оба пути в снимках → что уходит на диск → поля и каркас →
 * границы, тонкости и отмена.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно и говорит одно: это
 * единственный раздел панели, который не пишет в файлы, а вызывает чужую
 * команду. Почти все его странности — отсюда, и ни из одного снимка этого не
 * видно.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `PluginsGuideSections` держит схему и оба пути в снимках,
 * `PluginsLimitsSections` — границы, числа, отказы и отмену.
 */
export function PluginsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.plugins.${key}`);

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
            { title: tr('whyReady'), text: tr('whyReadyText') },
            { title: tr('whyUpdate'), text: tr('whyUpdateText') },
            { title: tr('whyOfficial'), text: tr('whyOfficialText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffCli'), text: tr('diffCliText') },
            { title: tr('diffOutput'), text: tr('diffOutputText') },
            { title: tr('diffOwn'), text: tr('diffOwnText') },
          ]}
        />
      </HelpSection>

      <PluginsGuideSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageWhere'), value: tr('storageWhereValue') },
            { label: tr('storageId'), value: tr('storageIdValue') },
            { label: tr('storageSource'), value: tr('storageSourceValue') },
            { label: tr('storageResult'), value: tr('storageResultValue') },
          ]}
        />
      </HelpSection>

      {/* Та же цепочка шагами: схема выше показывает её целиком, а эта полоса
          нужна как быстрый ответ на «что вообще происходит по кнопке». */}
      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'click',
              label: tr('flowClick'),
              caption: tr('flowClickCaption'),
              tone: 'accent',
              icon: 'plugins',
            },
            {
              id: 'cli',
              label: tr('flowCli'),
              caption: tr('flowCliCaption'),
              tone: 'info',
              isMono: true,
              icon: 'scripts',
            },
            {
              id: 'fetch',
              label: tr('flowFetch'),
              caption: tr('flowFetchCaption'),
              icon: 'link',
            },
            {
              id: 'ready',
              label: tr('flowReady'),
              caption: tr('flowReadyCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: 'id', description: tr('fieldId'), isMono: true },
            { name: 'marketplace', description: tr('fieldMarketplace') },
            { name: 'version', description: tr('fieldVersion') },
            { name: 'scope', description: tr('fieldScope') },
            { name: 'installedAt', description: tr('fieldInstalled') },
            { name: 'installCount', description: tr('fieldCount') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('scaffoldTitle')} caption={tr('scaffoldCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('scaffoldManifest'), text: tr('scaffoldManifestText') },
            { title: tr('scaffoldParts'), text: tr('scaffoldPartsText') },
            { title: tr('scaffoldNext'), text: tr('scaffoldNextText') },
          ]}
        />
      </HelpSection>

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

      <PluginsLimitsSections />
    </>
  );
}
