import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.hooks.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Хуки»: две схемы и оба пути в снимках.
 *
 * Схем именно две, и обе отвечают на вопросы, которых нет ни в одном состоянии
 * экрана. Первая — что происходит в момент события: без неё «код возврата 2»
 * читается как общее правило, хотя останавливают им только два события из
 * девяти. Вторая — где живёт хук: у него две части в разных файлах, и пока это
 * не нарисовано, выключение выглядит потерей, а удаление — уборкой скрипта.
 *
 * Сценариев съёмки два, и делятся они по входу. `first` — путь от пустой секции
 * hooks до рабочего стража: его проходят один раз. `living` — собранный набор:
 * порядок внутри события, записи локального файла, выключение и правка.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function HooksGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="hooks" name="hook-flow" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('storageMapTitle')} caption={g('storageMapCaption')}>
        <HelpDiagram topic="hooks" name="hook-storage" />
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('fEmpty')} text={g('fEmptyText')}>
            <HelpShot topic="hooks" scenario="first" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('fForm')} text={g('fFormText')}>
            <HelpShot topic="hooks" scenario="first" frame="02-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('fPreset')} text={g('fPresetText')}>
            <HelpShot topic="hooks" scenario="first" frame="03-preset" side="panel" />
          </GuideStep>
          <GuideStep title={g('fCard')} text={g('fCardText')}>
            <HelpShot topic="hooks" scenario="first" frame="04-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('fBulk')} text={g('fBulkText')}>
            <HelpShot topic="hooks" scenario="first" frame="05-bulk" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('livingTitle')} caption={g('livingCaption')}>
        <GuideSteps>
          <GuideStep title={g('lList')} text={g('lListText')}>
            <HelpShot topic="hooks" scenario="living" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('lLocal')} text={g('lLocalText')}>
            <HelpShot topic="hooks" scenario="living" frame="02-local" side="panel" />
          </GuideStep>
          <GuideStep title={g('lOrder')} text={g('lOrderText')}>
            <HelpShot topic="hooks" scenario="living" frame="03-order" side="panel" />
          </GuideStep>
          <GuideStep title={g('lOff')} text={g('lOffText')}>
            <HelpShot topic="hooks" scenario="living" frame="04-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('lEdit')} text={g('lEditText')}>
            <HelpShot topic="hooks" scenario="living" frame="05-edit" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
