import { StyleSheet } from 'react-native';
import { colors, font, radius, space } from '../../config/theme';

export const styles = StyleSheet.create({
  buttonAccent: { backgroundColor: colors.accent },
  // Опасное действие — тоном, а не заливкой: рядом с основной кнопкой красная
  // плашка перетягивала взгляд, хотя «Отключить» и «Отклонить» нажимают реже.
  buttonDanger: {
    backgroundColor: colors.dangerDim,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDefault: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: {
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: font.body, fontWeight: '600', textAlign: 'center' },
  buttonTextAccent: { color: '#ffffff' },
  buttonTextDanger: { color: colors.danger },
  buttonTextGhost: { color: colors.accent },
});
