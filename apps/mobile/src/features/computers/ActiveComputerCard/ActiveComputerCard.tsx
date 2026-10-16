import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Field, Icon, Mono, Muted, Row, Title } from '../../../shared/ui';
import { colors, space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { activePanel, renamePanel, useConnection } from '../../../shared/api/connection';
import { panelTitle } from '../../../shared/api/panels';
import { forgetPanel } from '../../../shared/lib/panel-switch';
import { styles } from './ActiveComputerCard.styles';

/**
 * Выбранный компьютер: на связи ли, как называется, адрес. Имя здесь своё, на
 * этом телефоне: у машины может быть «DESKTOP-7QF2K1», а в списке удобнее «Дом».
 */
export function ActiveComputerCard({ online }: { online: boolean }) {
  const t = useT();
  const router = useRouter();
  const connection = useConnection();
  const active = activePanel(connection);
  const [draft, setDraft] = useState<string | undefined>(undefined);

  if (!active) {
    return (
      <Card>
        <Row gap={space.md}>
          <View style={[styles.badge, styles.badgeOff]}>
            <Icon ios="wifi.slash" android="cloud_off" size={22} color={colors.danger} />
          </View>
          <View style={styles.grow}>
            <Title>{t.settings.panel}</Title>
            <Text style={styles.offline}>{t.settings.notPaired}</Text>
          </View>
        </Row>
        <Button title={t.settings.pair} tone="accent" onPress={() => router.push('/pair')} />
      </Card>
    );
  }

  const save = async (): Promise<void> => {
    await renamePanel(active.id, draft ?? '');
    setDraft(undefined);
  };

  return (
    <Card>
      <Row gap={space.md}>
        <View style={[styles.badge, online ? styles.badgeOn : styles.badgeOff]}>
          <Icon
            ios={online ? 'wifi' : 'wifi.slash'}
            android={online ? 'wifi' : 'cloud_off'}
            size={22}
            color={online ? colors.success : colors.danger}
          />
        </View>
        <View style={styles.grow}>
          <Title>{panelTitle(active)}</Title>
          <Text style={online ? styles.online : styles.offline}>
            {online ? t.settings.online : t.settings.offline}
          </Text>
        </View>
      </Row>
      <Mono numberOfLines={2}>{active.url}</Mono>
      {active.name && active.machineName ? (
        <Muted>{t.computers.machineNamed(active.machineName)}</Muted>
      ) : null}

      {draft === undefined ? (
        <Row gap={space.sm}>
          <Button
            title={t.computers.rename}
            onPress={() => setDraft(active.name || active.machineName)}
            style={styles.grow}
          />
          <Button
            title={t.settings.repair}
            onPress={() => router.push('/pair')}
            style={styles.grow}
          />
        </Row>
      ) : (
        <>
          <Field
            value={draft}
            onChangeText={setDraft}
            placeholder={t.computers.renamePlaceholder}
            autoCapitalize="sentences"
          />
          <Row gap={space.sm}>
            <Button
              title={t.computers.save}
              tone="accent"
              onPress={() => void save()}
              style={styles.grow}
            />
            <Button
              title={t.computers.cancel}
              tone="ghost"
              onPress={() => setDraft(undefined)}
              style={styles.grow}
            />
          </Row>
        </>
      )}
      <Button
        title={t.computers.forget}
        tone="danger"
        onPress={() => void forgetPanel(active.id)}
      />
    </Card>
  );
}
