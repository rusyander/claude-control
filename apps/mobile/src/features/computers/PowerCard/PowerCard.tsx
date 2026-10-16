import { useState } from 'react';
import { Text, View } from 'react-native';
import type { PowerAction, PowerOption } from '@agentdeck/contracts';
import { Button, Card, Mono, Muted, Row, Title } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { activePanel, useConnection } from '../../../shared/api/connection';
import { panelTitle } from '../../../shared/api/panels';
import { usePower, usePowerAction } from '../../../entities/power/api';
import { styles } from './PowerCard.styles';

/**
 * Гибернация или сон выбранного компьютера. Нажатие кнопки ничего не делает
 * само: сначала раскрывается подтверждение с именем машины и предупреждением,
 * что обратно с телефона её не включить, — усыпить не тот компьютер из кармана
 * проще простого, а исправить уже нечем.
 */
export function PowerCard() {
  const t = useT();
  const connection = useConnection();
  const active = activePanel(connection);
  const power = usePower();
  const act = usePowerAction();
  const [pending, setPending] = useState<PowerAction | undefined>(undefined);
  const status = power.data;
  if (!active || !status) return null;

  const about = (option: PowerOption): string =>
    option.action === 'hibernate' ? t.computers.hibernateAbout : t.computers.sleepAbout;
  const run = (action: PowerAction): void => {
    setPending(undefined);
    act.mutate(action);
  };

  return (
    <Card>
      <Title>{t.computers.powerTitle}</Title>
      {status.options.map((option) => (
        <View key={option.action} style={styles.option}>
          <Text style={styles.name}>
            {option.action === 'hibernate' ? t.computers.hibernate : t.computers.sleep}
          </Text>
          {option.available ? (
            <Muted>{about(option)}</Muted>
          ) : (
            <Mono style={styles.warn}>
              {t.computers.unavailable(option.reason, status.platform)}
            </Mono>
          )}
          {option.available && pending !== option.action ? (
            <Button
              title={option.action === 'hibernate' ? t.computers.hibernate : t.computers.sleep}
              onPress={() => setPending(option.action)}
              disabled={act.isPending}
            />
          ) : null}
          {pending === option.action ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>
                {t.computers.confirmTitle(option.action, panelTitle(active))}
              </Text>
              <Muted>{t.computers.noWake}</Muted>
              {status.awakeHeld ? <Mono style={styles.warn}>{t.computers.awakeHeld}</Mono> : null}
              <Row gap={space.sm}>
                <Button
                  title={t.computers.confirm}
                  tone="danger"
                  onPress={() => run(option.action)}
                  style={styles.grow}
                />
                <Button
                  title={t.computers.cancel}
                  tone="ghost"
                  onPress={() => setPending(undefined)}
                  style={styles.grow}
                />
              </Row>
            </View>
          ) : null}
        </View>
      ))}
      {status.macHibernateMode !== undefined ? (
        <>
          <Muted>{t.computers.macMode(status.macHibernateMode)}</Muted>
          {status.macHibernateMode !== 25 ? <Muted>{t.computers.macModeHint}</Muted> : null}
        </>
      ) : null}
      {act.isSuccess ? <Muted>{t.computers.accepted}</Muted> : null}
      {act.error ? <Mono style={styles.danger}>{act.error.message}</Mono> : null}
      {status.lastFailure ? (
        <Mono style={styles.danger}>{t.computers.failed(status.lastFailure.message)}</Mono>
      ) : null}
    </Card>
  );
}
