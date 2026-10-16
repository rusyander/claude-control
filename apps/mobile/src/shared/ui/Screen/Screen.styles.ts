import { StyleSheet } from 'react-native';
import { colors, space } from '../../config/theme';

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: { padding: space.lg, paddingBottom: space.xl * 2, gap: space.md },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
    gap: space.sm,
  },
  screen: { flex: 1, backgroundColor: colors.bg },
});
