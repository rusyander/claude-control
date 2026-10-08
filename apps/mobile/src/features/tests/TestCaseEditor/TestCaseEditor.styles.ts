import { StyleSheet } from 'react-native';
import { colors, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, gap: space.md },
  group: { gap: space.xs },
  step: { gap: space.xs },
  removeStep: { color: colors.danger, fontSize: font.small },
  grow: { flex: 1 },
});
