import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.plugins.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Плагины»: схема установки и оба пути в снимках.
 *
 * Схема стоит ПЕРЕД шагами, потому что отвечает сразу на три вопроса, которых
 * нет ни в одном состоянии экрана: почему нужен установленный CLI, почему
 * плагин не работает до перезапуска и откуда берётся плагин без каталога на
 * диске.
 *
 * Сценариев съёмки два. `install` — плагин ставят готовым; `own` — плагин пишут
 * свой. Второй путь начинается с кадра, где CLI не ответил вовсе: это
 * единственный раздел панели, который без `claude` не делает ничего, и честнее
 * показать это состояние, чем прятать.
 *
 * Единственная подмена во всей пачке справки по настройке — здесь, и о ней
 * сказано в тексте: подменён ОТВЕТ CLI, разметка и диалоги настоящие.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function PluginsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="plugins" name="plugin-install" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('installTitle')} caption={g('installCaption')}>
        <GuideSteps>
          <GuideStep title={g('iInstalled')} text={g('iInstalledText')}>
            <HelpShot topic="plugins" scenario="install" frame="01-installed" side="panel" />
          </GuideStep>
          <GuideStep title={g('iCatalog')} text={g('iCatalogText')}>
            <HelpShot topic="plugins" scenario="install" frame="02-catalog" side="panel" />
          </GuideStep>
          <GuideStep title={g('iInstall')} text={g('iInstallText')}>
            <HelpShot topic="plugins" scenario="install" frame="03-install" side="panel" />
          </GuideStep>
          <GuideStep title={g('iMarketplace')} text={g('iMarketplaceText')}>
            <HelpShot topic="plugins" scenario="install" frame="04-marketplace" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('ownTitle')} caption={g('ownCaption')}>
        <GuideSteps>
          <GuideStep title={g('oNoCli')} text={g('oNoCliText')}>
            <HelpShot topic="plugins" scenario="own" frame="01-no-cli" side="panel" />
          </GuideStep>
          <GuideStep title={g('oScaffold')} text={g('oScaffoldText')}>
            <HelpShot topic="plugins" scenario="own" frame="02-scaffold" side="panel" />
          </GuideStep>
          <GuideStep title={g('oCreated')} text={g('oCreatedText')}>
            <HelpShot topic="plugins" scenario="own" frame="03-created" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="warning" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
