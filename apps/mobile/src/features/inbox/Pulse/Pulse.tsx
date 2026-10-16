import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../shared/config/i18n';
import { styles } from './Pulse.styles';

/**
 * Сводка над списком: сколько ходов идёт, сколько ждут человека, в скольких
 * проектах. Ответ на вопрос, ради которого берут телефон, — одним взглядом,
 * до прокрутки. Считается из уже пришедших данных, отдельного запроса нет.
 *
 * Плитка «ждут вас» нажимается и ведёт во вкладку «Вопросы»; пока ждать
 * нечего, она гаснет, а не исчезает — ряд не прыгает от обновления к обновлению.
 */
export function Pulse({
  running,
  waiting,
  projects,
  onWaiting,
}: {
  running: number;
  waiting: number;
  projects: number;
  onWaiting: () => void;
}) {
  const t = useT();
  return (
    <View style={styles.row}>
      <View style={[styles.tile, running > 0 && styles.tileRunning]}>
        <Text style={[styles.value, running > 0 && styles.valueRunning]}>{running}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {t.home.pulseRunning(running)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.home.tabQuestionsA11y(waiting)}
        disabled={waiting === 0}
        onPress={onWaiting}
        style={({ pressed }) => [
          styles.tile,
          waiting > 0 && styles.tileWaiting,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.value, waiting > 0 && styles.valueWaiting]}>{waiting}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {t.home.pulseWaiting(waiting)}
        </Text>
      </Pressable>
      <View style={styles.tile}>
        <Text style={styles.value}>{projects}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {t.home.pulseProjects(projects)}
        </Text>
      </View>
    </View>
  );
}
