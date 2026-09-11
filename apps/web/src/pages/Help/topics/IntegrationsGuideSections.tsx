import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.integrations.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Интеграции»: схема направлений и два пути по входу.
 *
 * Делятся именно по входу, а не по карточкам. В первый приходят за внешним
 * КОНТЕКСТОМ (требования, задачи, дефекты) и спрашивают «чем панель
 * представится»; во второй — за УВЕДОМЛЕНИЕМ, и там вопрос обратный: «что
 * именно уйдёт наружу». Одна страница ответов на оба вопроса читалась бы как
 * список полей.
 */
export function IntegrationsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('wireMapTitle')} caption={tr('wireMapCaption')}>
        <HelpDiagram topic="integrations" name="who-calls-whom" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('contextTitle')} caption={g('contextCaption')}>
        <GuideSteps>
          <GuideStep title={g('contextCards')} text={g('contextCardsText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="01-cards" side="panel" />
          </GuideStep>
          <GuideStep title={g('contextFilled')} text={g('contextFilledText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="02-filled" side="panel" />
          </GuideStep>
          <GuideStep title={g('contextChecked')} text={g('contextCheckedText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="03-checked" side="panel" />
          </GuideStep>
          <GuideStep title={g('contextMcp')} text={g('contextMcpText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="04-mcp" side="panel" />
          </GuideStep>
          <GuideStep title={g('contextForge')} text={g('contextForgeText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="05-forge" side="panel" />
          </GuideStep>
          <GuideStep title={g('contextForgotten')} text={g('contextForgottenText')}>
            <HelpShot topic="integrations" scenario="atlassian" frame="06-forgotten" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('notifyTitle')} caption={g('notifyCaption')}>
        <GuideSteps>
          <GuideStep title={g('notifyWebhook')} text={g('notifyWebhookText')}>
            <HelpShot topic="integrations" scenario="notify" frame="01-webhook" side="panel" />
          </GuideStep>
          <GuideStep title={g('notifyChecked')} text={g('notifyCheckedText')}>
            <HelpShot
              topic="integrations"
              scenario="notify"
              frame="02-webhook-checked"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('notifyEvents')} text={g('notifyEventsText')}>
            <HelpShot topic="integrations" scenario="notify" frame="03-events" side="panel" />
          </GuideStep>
          <GuideStep title={g('notifyTelegram')} text={g('notifyTelegramText')}>
            <HelpShot topic="integrations" scenario="notify" frame="04-telegram" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
