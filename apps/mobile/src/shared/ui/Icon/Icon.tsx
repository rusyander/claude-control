import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { colors } from '../../config/theme';

/**
 * Значок системного набора: SF Symbols на iOS, Material Symbols на Android.
 * Не эмодзи — 🎙 и 📁 рисуются шрифтом телефона, у каждого производителя
 * по-своему и в цвете, который не подчиняется теме.
 */
export function Icon({
  ios,
  android,
  size = 20,
  color = colors.textDim,
}: {
  ios: SFSymbol;
  android: AndroidSymbol;
  size?: number;
  color?: ColorValue;
}) {
  return <SymbolView name={{ ios, android, web: android }} tintColor={color} size={size} />;
}
