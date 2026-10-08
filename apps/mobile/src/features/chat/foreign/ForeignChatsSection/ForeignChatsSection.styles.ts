import { StyleSheet } from 'react-native';
import { colors, font } from '../../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { flexWrap: 'wrap' },
  failed: { color: colors.danger },
});
