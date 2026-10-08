import { StyleSheet } from 'react-native';
import { colors, space } from '../../config/theme';

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: { padding: space.lg, gap: space.md },
  screen: { flex: 1, backgroundColor: colors.bg },
});
