import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.commands.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Команды»: как собирается список и оба пути в снимках.
 *
 * Сценариев съёмки два, и делятся они по вопросу, с которым человек приходит.
 * `find` — «есть команда, не помню имя»: общий список, поиск, фильтры по
 * источнику. `sources` — «команда была и пропала»: выключенный скилл, путь
 * файла команды и реестр плагинов чужой версии. Это разные задачи, и держать их
 * одной простынёй значило бы заставлять читателя листать чужое.
 *
 * Схема стоит ПЕРЕД шагами: снимки отвечают на вопрос «куда нажимать», но не на
 * вопрос «откуда берётся строка», а второй возникает первым — и ответа на него
 * нет ни в одном состоянии экрана.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function CommandsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="commands" name="four-sources" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('findTitle')} caption={g('findCaption')}>
        <GuideSteps>
          <GuideStep title={g('fList')} text={g('fListText')}>
            <HelpShot topic="commands" scenario="find" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('fSearch')} text={g('fSearchText')}>
            <HelpShot topic="commands" scenario="find" frame="02-search" side="panel" />
          </GuideStep>
          <GuideStep title={g('fBuiltin')} text={g('fBuiltinText')}>
            <HelpShot topic="commands" scenario="find" frame="03-builtin" side="panel" />
          </GuideStep>
          <GuideStep title={g('fPlugin')} text={g('fPluginText')}>
            <HelpShot topic="commands" scenario="find" frame="04-plugin" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('sourcesTitle')} caption={g('sourcesCaption')}>
        <GuideSteps>
          <GuideStep title={g('sSkill')} text={g('sSkillText')}>
            <HelpShot topic="commands" scenario="sources" frame="01-skill" side="panel" />
          </GuideStep>
          <GuideStep title={g('sFiles')} text={g('sFilesText')}>
            <HelpShot topic="commands" scenario="sources" frame="02-files" side="panel" />
          </GuideStep>
          <GuideStep title={g('sRegistry')} text={g('sRegistryText')}>
            <HelpShot topic="commands" scenario="sources" frame="03-registry" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
