import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { PermissionsGuideSections } from './PermissionsGuideSections';
import { PermissionsLimitsSections } from './PermissionsLimitsSections';

/**
 * Документ раздела «Права» — один на весь раздел и намеренно длинный.
 *
 * Порядок задан вопросами, в которых человек приходит: зачем это вообще → чем
 * раздел НЕ является (половина вопросов — «это здесь или там») → как устроено
 * (две схемы) → весь путь в снимках, двумя сценариями по входу → что правит на
 * диске → пределы и отказы → справочные таблицы → тонкости.
 *
 * Лестница приоритета осталась рядом со схемами, а не вместо них: схема
 * отвечает «кто и в каком порядке решает», лестница — «что сильнее чего», и это
 * то самое место, куда человек тычет пальцем, объясняя коллеге.
 */
export function PermissionsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.permissions.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная, и первое, что ей нужно сказать, — из чего она
          состоит: иначе человек, которому нужен один факт, листает наугад. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyHard'), text: tr('whyHardText') },
            { title: tr('whyQuiet'), text: tr('whyQuietText') },
            { title: tr('whySystem'), text: tr('whySystemText') },
          ]}
        />
      </HelpSection>

      <PermissionsGuideSections tr={tr} />

      <HelpSection title={tr('priorityTitle')} caption={tr('priorityCaption')}>
        <PriorityLadder
          ariaLabel={tr('priorityTitle')}
          topLabel={tr('priorityTop')}
          bottomLabel={tr('priorityBottom')}
          steps={[
            { id: 'deny', label: 'deny', caption: tr('priorityDeny'), tone: 'danger' },
            { id: 'ask', label: 'ask', caption: tr('priorityAsk'), tone: 'warning' },
            { id: 'allow', label: 'allow', caption: tr('priorityAllow'), tone: 'success' },
          ]}
        />
        <Callout tone="info" title={tr('priorityNote')} />
      </HelpSection>

      <PermissionsLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('patternTitle')} caption={tr('patternCaption')}>
        <OptionCards
          items={[
            { title: tr('patternTool'), text: tr('patternToolText') },
            { title: tr('patternNarrow'), text: tr('patternNarrowText') },
            { title: tr('patternMcp'), text: tr('patternMcpText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('tabsTitle')}>
        <OptionCards
          items={[
            { title: tr('tabSystem'), text: tr('tabSystemText') },
            { title: tr('tabMcp'), text: tr('tabMcpText') },
            { title: tr('tabAll'), text: tr('tabAllText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('risksTitle')}>
        <FieldTable
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            {
              name: tr('riskLow'),
              description: tr('riskLowText'),
              isMono: false,
              badge: 'low',
              badgeTone: 'success',
            },
            {
              name: tr('riskMedium'),
              description: tr('riskMediumText'),
              isMono: false,
              badge: 'medium',
              badgeTone: 'warning',
            },
            {
              name: tr('riskHigh'),
              description: tr('riskHighText'),
              isMono: false,
              badge: 'high',
              badgeTone: 'danger',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            {
              name: 'pattern',
              description: tr('fieldPattern'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            {
              name: 'decision',
              description: tr('fieldDecision'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            { name: 'groupIds', description: tr('fieldGroups') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteDenyTitle')}>
            {tr('noteDenyText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteChatTitle')}>
            {tr('noteChatText')}
          </Callout>
          <Callout tone="info" title={tr('noteExactTitle')}>
            {tr('noteExactText')}
          </Callout>
          <Callout tone="info" title={tr('noteIdTitle')}>
            {tr('noteIdText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
