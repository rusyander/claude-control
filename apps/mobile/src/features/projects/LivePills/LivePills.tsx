import { Text, View } from 'react-native';
import { colors } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import type { ProjectLive } from '../projectLive';
import { styles } from './LivePills.styles';

/** «работает: 1», «ждёт: 2» — пилюлями, только то, что не ноль. */
export function LivePills({ live }: { live?: ProjectLive }) {
  const t = useT();
  if (!live) return null;
  return (
    <>
      {live.running > 0 ? (
        <View style={[styles.pill, styles.running]}>
          <View style={[styles.dot, { backgroundColor: colors.running }]} />
          <Text style={[styles.text, { color: colors.running }]}>
            {t.projects.running(live.running)}
          </Text>
        </View>
      ) : null}
      {live.waiting > 0 ? (
        <View style={[styles.pill, styles.waiting]}>
          <View style={[styles.dot, { backgroundColor: colors.waiting }]} />
          <Text style={[styles.text, { color: colors.waiting }]}>
            {t.projects.waiting(live.waiting)}
          </Text>
        </View>
      ) : null}
    </>
  );
}
