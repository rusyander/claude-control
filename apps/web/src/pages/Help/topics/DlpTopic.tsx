import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards, StepList } from '../ui';

/**
 * Документ «Защита данных».
 *
 * Половина текста здесь — про то, чего прокси НЕ делает. Это не скромность:
 * средство защиты, о границах которого умолчали, опаснее его отсутствия, потому
 * что заменяет осторожность уверенностью. Поэтому и таблица встроенных образцов
 * называет, что каждый ловит и чего не ловит.
 */
export function DlpTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.dlp.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyBody'), text: tr('whyBodyText') },
            { title: tr('whyBack'), text: tr('whyBackText') },
            { title: tr('whyNoTls'), text: tr('whyNoTlsText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('threeTitle')} caption={tr('threeCaption')}>
        <FieldTable
          nameHeader={tr('threeHeader')}
          descriptionHeader={tr('threeWhat')}
          rows={[
            { name: tr('threeEndpoint'), description: tr('threeEndpointText'), isMono: false },
            { name: tr('threeProxy'), description: tr('threeProxyText'), isMono: false },
            { name: tr('threeGate'), description: tr('threeGateText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('stepsTitle')} caption={tr('stepsCaption')}>
        <StepList
          steps={[
            { title: tr('step1'), text: tr('step1Text') },
            { title: tr('step2'), text: tr('step2Text') },
            { title: tr('step3'), text: tr('step3Text') },
            { title: tr('step4'), text: tr('step4Text') },
            { title: tr('step5'), text: tr('step5Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('rulesTitle')} caption={tr('rulesCaption')}>
        <FieldTable
          nameHeader={tr('rulesHeader')}
          descriptionHeader={tr('rulesWhat')}
          rows={[
            { name: tr('kindBuiltin'), description: tr('kindBuiltinText'), isMono: false },
            { name: tr('kindTerms'), description: tr('kindTermsText'), isMono: false },
            { name: tr('kindRegex'), description: tr('kindRegexText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('actionsTitle')} caption={tr('actionsCaption')}>
        <FieldTable
          nameHeader={tr('actionsHeader')}
          descriptionHeader={tr('actionsWhat')}
          rows={[
            {
              name: tr('actionMask'),
              description: tr('actionMaskText'),
              isMono: false,
              badge: tr('actionMaskBadge'),
              badgeTone: 'info',
            },
            {
              name: tr('actionBlock'),
              description: tr('actionBlockText'),
              isMono: false,
              badge: '403',
              badgeTone: 'danger',
            },
            {
              name: tr('actionFlag'),
              description: tr('actionFlagText'),
              isMono: false,
              badge: tr('actionFlagBadge'),
              badgeTone: 'neutral',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('shapesTitle')} caption={tr('shapesCaption')}>
        <FieldTable
          nameHeader={tr('shapesHeader')}
          descriptionHeader={tr('shapesWhat')}
          rows={[
            {
              name: '/v1/messages',
              description: tr('shapeAnthropic'),
              badge: 'Anthropic',
              badgeTone: 'success',
            },
            {
              name: '/chat/completions',
              description: tr('shapeOpenai'),
              badge: 'OpenAI',
              badgeTone: 'success',
            },
            {
              name: tr('shapeOther'),
              description: tr('shapeOtherText'),
              isMono: false,
              badge: tr('shapeRefused'),
              badgeTone: 'warning',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')} caption={tr('filesCaption')}>
        <Stack gap="var(--spacing-xs)">
          <StorageCard
            title={tr('filesPanelTitle')}
            rows={[
              {
                label: tr('fileRules'),
                value: '~/.claude/claude-control/dlp-rules.json',
                isMono: true,
              },
              {
                label: tr('fileJournal'),
                value: '~/.claude/claude-control/dlp-journal.jsonl',
                isMono: true,
              },
              {
                label: tr('fileSettings'),
                value: '~/.claude/claude-control/state.json',
                isMono: true,
              },
            ]}
          />
          <StorageCard
            title={tr('filesMemoryTitle')}
            rows={[{ label: tr('fileVault'), value: tr('fileVaultText'), isMono: false }]}
          />
        </Stack>
      </HelpSection>

      <HelpSection title={tr('gateTitle')} caption={tr('gateCaption')}>
        <Stack gap="var(--spacing-xs)">
          <FieldTable
            nameHeader={tr('gateHeader')}
            descriptionHeader={tr('gateWhat')}
            rows={[
              { name: tr('gateSees'), description: tr('gateSeesText'), isMono: false },
              { name: tr('gateBlind'), description: tr('gateBlindText'), isMono: false },
              { name: tr('gateActions'), description: tr('gateActionsText'), isMono: false },
              { name: tr('gateWhere'), description: tr('gateWhereText'), isMono: false },
            ]}
          />
          <Callout tone="warning" title={tr('gateLimitTitle')}>
            {tr('gateLimitText')}
          </Callout>
          <Callout tone="info" title={tr('gateSharedTitle')}>
            {tr('gateSharedText')}
          </Callout>
          <Callout tone="info" title={tr('gateSafeTitle')}>
            {tr('gateSafeText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('limitsTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('limitRulesTitle')}>
            {tr('limitRulesText')}
          </Callout>
          <Callout tone="warning" title={tr('limitParaphraseTitle')}>
            {tr('limitParaphraseText')}
          </Callout>
          <Callout tone="warning" title={tr('limitShapeTitle')}>
            {tr('limitShapeText')}
          </Callout>
          <Callout tone="info" title={tr('limitLocalTitle')}>
            {tr('limitLocalText')}
          </Callout>
          <Callout tone="info" title={tr('limitJournalTitle')}>
            {tr('limitJournalText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
