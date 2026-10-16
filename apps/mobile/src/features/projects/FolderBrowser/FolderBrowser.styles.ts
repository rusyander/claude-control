import { StyleSheet } from 'react-native';
import { colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  heading: { flex: 1, color: colors.textDim, fontSize: font.small, fontWeight: '700' },
  link: { color: colors.accent, fontSize: font.small + 1, fontWeight: '600' },
  failed: { color: colors.danger },
});
