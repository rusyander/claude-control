import { View } from 'react-native';
import { Card, Mono, Muted, SwitchRow, Title } from '../../../shared/ui';
import { useT } from '../../../shared/config/i18n';
import { useOutsideRelay, useOutsideRelayToggle } from '../../../entities/inbox/outsideRelay';
import { Notice } from './Notice/Notice';
import { styles } from './OutsideRelayCard.styles';

/**
 * «Агент на компьютере»: вопросы, запросы прав и сообщения сессий в терминале
 * и VS Code — с телефона. Переключатель сам по себе ничего не ставит: за такую
 * сессию отвечают только хуки панели в настройках Claude Code, а вписать их
 * туда — решение человека на компьютере. Пока хуков нет, карточка показывает
 * готовую команду и где её добавить, а не делает вид, что включено.
 */
export function OutsideRelayCard() {
  const t = useT();
  const relay = useOutsideRelay();
  const toggle = useOutsideRelayToggle();
  const state = relay.data;
  if (!state) return null;

  return (
    <Card>
      <Title>{t.settings.relay}</Title>
      <Muted>{t.settings.relayAbout}</Muted>
      <SwitchRow
        label={t.settings.relayOn}
        value={state.enabled}
        onChange={(enabled) => toggle.mutate(enabled)}
        disabled={toggle.isPending}
      />
      {state.shortTimeout ? <Notice tone="warning" text={t.settings.relayShortTimeout} /> : null}
      {state.installed && !state.shortTimeout ? (
        <Notice tone="ok" text={t.settings.relayInstalled} />
      ) : null}
      {!state.enabled || state.installed ? null : (
        <>
          <Notice tone="warning" text={t.settings.relayMissing} />
          <View style={styles.command}>
            <Mono>{state.command}</Mono>
          </View>
        </>
      )}
      {toggle.error ? <Mono style={styles.failed}>{toggle.error.message}</Mono> : null}
    </Card>
  );
}
