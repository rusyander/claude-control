import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.md },
  notice: { color: colors.textDim, fontSize: font.small, fontStyle: 'italic', lineHeight: 18 },
  meta: { color: colors.textFaint, fontSize: font.small },
  failed: { gap: space.xs },
  failedTitle: { color: colors.danger, fontSize: font.small, fontWeight: '600' },
  failedText: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
});
