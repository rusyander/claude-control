import { HelpSection, GuideSteps, GuideStep, HelpShot, FieldTable, Callout } from '../../ui';
import type { SectionProps } from '../PhoneGuideSections/PhoneGuideSections.types';

/**
 * Раздел «Подпись решений ключом телефона» документа «Телефон».
 *
 * Шаги идут в том порядке, в каком их проходит человек: привязать на телефоне,
 * сверить отпечаток в окне панели, включить на телефоне, при нужде отозвать в
 * окне. Кадры — только стороны панели: экран телефона снимается с эмулятора и
 * установленного APK (`tools/help-shots/phone-device.mjs`), а кадры панели —
 * одноразовым стендом (`tools/help-shots/phone-signing-panel.mjs`).
 */
export function PhoneSigningSection({ tr }: SectionProps) {
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });
  return (
    <HelpSection title={tr('signingTitle')} caption={tr('signingCaption')}>
      <GuideSteps>
        <GuideStep title={tr('signingBind')} text={tr('signingBindText')} />
        <GuideStep title={tr('signingCheck')} text={tr('signingCheckText')}>
          <HelpShot topic="phone" scenario="signing" frame="01-panel-card" side="panel" />
        </GuideStep>
        <GuideStep title={tr('signingEnable')} text={tr('signingEnableText')} />
        <GuideStep title={tr('signingRevoke')} text={tr('signingRevokeText')}>
          <HelpShot topic="phone" scenario="signing" frame="02-panel-revoke-last" side="panel" />
        </GuideStep>
      </GuideSteps>
      <FieldTable
        nameHeader={tr('signingColumn')}
        descriptionHeader={tr('signingMeaningColumn')}
        rows={[
          row('signingAllow'),
          row('signingDeny'),
          row('signingWindow'),
          row('signingTelegram'),
          row('signingLevers'),
          row('signingRefusal'),
        ]}
      />
      <Callout tone="warning" title={tr('signingLostTitle')}>
        {tr('signingLostText')}
      </Callout>
    </HelpSection>
  );
}
