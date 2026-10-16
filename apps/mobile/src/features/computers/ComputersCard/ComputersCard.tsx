import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Icon, ListRow, Muted, Title } from '../../../shared/ui';
import { colors } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { useConnection } from '../../../shared/api/connection';
import { panelTitle, type PanelEntry } from '../../../shared/api/panels';
import { activatePanel } from '../../../shared/lib/panel-switch';
import { styles } from './ComputersCard.styles';

/** Подпись строки: система и адрес без схемы — по ним два «Дома» и различают. */
function subtitle(entry: PanelEntry, os: string): string {
  const host = entry.url.replace(/^https?:\/\//i, '');
  return os ? `${os} · ${host}` : host;
}

/**
 * Все спаренные компьютеры. Нажатие выбирает: проекты, чаты, вопросы и
 * уведомления дальше — того компьютера. Новый добавляется его кодом.
 */
export function ComputersCard() {
  const t = useT();
  const router = useRouter();
  const { panels, activeId } = useConnection();
  if (panels.length === 0) return null;
  return (
    <Card>
      <Title>{t.computers.title}</Title>
      <Muted>{t.computers.about}</Muted>
      {panels.map((entry, index) => {
        const selected = entry.id === activeId;
        return (
          <ListRow
            key={entry.id}
            title={panelTitle(entry)}
            subtitle={subtitle(entry, t.computers.os(entry.platform))}
            divided={index > 0}
            leading={
              <Icon
                ios="desktopcomputer"
                android="computer"
                size={20}
                color={selected ? colors.accent : colors.textDim}
              />
            }
            trailing={
              selected ? <Text style={styles.current}>{t.computers.current}</Text> : undefined
            }
            onPress={selected ? undefined : () => void activatePanel(entry.id)}
          />
        );
      })}
      <Button title={t.computers.add} onPress={() => router.push('/pair')} />
    </Card>
  );
}
