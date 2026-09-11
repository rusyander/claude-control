import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.skills.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Скиллы»: как это устроено и оба пути в снимках.
 *
 * Сценариев съёмки два, и делятся они по входу, а не по объёму. `first` — путь
 * от пустого раздела до папки с модулями: его проходят один раз и потом не
 * вспоминают. `living` — готовый набор: поиск, дерево файлов, выключение и
 * правка. Человеку с набором первый путь уже не нужен, и держать оба одной
 * простынёй значило бы заставлять его листать чужое.
 *
 * Схемы стоят ПЕРЕД шагами: снимки отвечают на вопрос «куда нажимать», но не на
 * вопрос «что именно Claude читает у скилла и когда», а второй возникает первым
 * — и ответа на него нет ни в одном состоянии экрана.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function SkillsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="skills" name="skill-pickup" />
        <HelpDiagram topic="skills" name="skill-on-disk" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('fEmpty')} text={g('fEmptyText')}>
            <HelpShot topic="skills" scenario="first" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('fForm')} text={g('fFormText')}>
            <HelpShot topic="skills" scenario="first" frame="02-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('fTemplate')} text={g('fTemplateText')}>
            <HelpShot topic="skills" scenario="first" frame="03-template" side="panel" />
          </GuideStep>
          <GuideStep title={g('fStructure')} text={g('fStructureText')}>
            <HelpShot topic="skills" scenario="first" frame="04-structure" side="panel" />
          </GuideStep>
          <GuideStep title={g('fCard')} text={g('fCardText')}>
            <HelpShot topic="skills" scenario="first" frame="05-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('fBuilder')} text={g('fBuilderText')}>
            <HelpShot topic="skills" scenario="first" frame="06-builder" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('livingTitle')} caption={g('livingCaption')}>
        <GuideSteps>
          <GuideStep title={g('lList')} text={g('lListText')}>
            <HelpShot topic="skills" scenario="living" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('lSearch')} text={g('lSearchText')}>
            <HelpShot topic="skills" scenario="living" frame="02-search" side="panel" />
          </GuideStep>
          <GuideStep title={g('lFiles')} text={g('lFilesText')}>
            <HelpShot topic="skills" scenario="living" frame="03-files" side="panel" />
          </GuideStep>
          <GuideStep title={g('lOff')} text={g('lOffText')}>
            <HelpShot topic="skills" scenario="living" frame="04-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('lEdit')} text={g('lEditText')}>
            <HelpShot topic="skills" scenario="living" frame="05-edit" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
