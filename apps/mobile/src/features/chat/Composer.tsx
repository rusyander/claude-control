import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogResponse } from '@claude-control/contracts';
import { isSupportedUpload } from '@claude-control/contracts/uploads';
import { api } from '../../shared/api/client';
import type { Upload } from '../../shared/lib/runs';
import { useVoice } from '../../shared/lib/voice';
import { useT } from '../../shared/config/i18n';
import { Field, Mono, Row } from '../../shared/ui';
import { colors, font, radius, space } from '../../shared/config/theme';

/**
 * Поле ввода со всем, что влияет на запуск: права на правки, автоподтверждение,
 * модель и глубина продумывания.
 *
 * Кнопка отправки не блокируется на время работы агента намеренно — как и в
 * панели: задача идёт часами, и «сказать ещё одно» всё это время было бы
 * нельзя. Дописанное уходит в очередь и отправляется, когда ход закончится.
 *
 * Отправка и микрофон — крупные круглые кнопки: телефон держат одной рукой на
 * ходу, и промах по мелкой цели здесь стоит дороже, чем лишние пиксели.
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ComposerValue {
  text: string;
  allowEdits: boolean;
  autoApprove: boolean;
  model: string;
  effort: string;
  files: Upload[];
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
  busy,
}: {
  value: ComposerValue;
  onChange: (next: ComposerValue) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
  busy?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState('');
  const catalog = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<ModelCatalogResponse>('/models'),
    staleTime: 10 * 60_000,
    enabled: open,
  });

  const models = (catalog.data?.models ?? []).slice(0, 8);

  // Что было набрано руками до нажатия на микрофон: распознанное дописывается к
  // этому, иначе каждый промежуточный результат стирал бы предыдущий текст.
  const typed = useRef('');
  const voice = useVoice((heard) =>
    onChange({ ...value, text: typed.current ? `${typed.current} ${heard}` : heard }),
  );
  const toggleVoice = (): void => {
    if (!voice.listening) typed.current = value.text.trim();
    voice.toggle();
  };

  /**
   * Вложение с телефона — это снимок экрана или фотография; ничего другого
   * отсюда не прикладывают. Base64 просим у самого выбора файлов: читать его
   * потом было бы нечем — файловой системы у приложения нет.
   */
  const attach = async (): Promise<void> => {
    setRefused('');
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
    });
    if (picked.canceled) return;

    const files: Upload[] = [];
    const rejected: string[] = [];
    for (const asset of picked.assets) {
      const name = asset.fileName || t.composer.shot(picked.assets.indexOf(asset) + 1);
      // Панель принимает не всякое расширение (на iOS выбор отдаёт ещё и heic),
      // а отказ сервера приходит уже после очистки поля ввода.
      if (!asset.base64 || !isSupportedUpload(name)) rejected.push(name);
      else files.push({ name, base64: asset.base64 });
    }

    if (rejected.length > 0) setRefused(t.composer.unsupported(rejected.join(', ')));
    if (files.length > 0) onChange({ ...value, files: [...value.files, ...files] });
  };

  const drop = (name: string): void =>
    onChange({ ...value, files: value.files.filter((file) => file.name !== name) });

  const note = voice.listening ? t.composer.voiceListening : voice.problem || refused;

  return (
    <View style={styles.root}>
      {open ? (
        <View style={styles.options}>
          <Row gap={space.sm} style={styles.wrap}>
            <Toggle
              label={t.composer.allowEdits}
              on={value.allowEdits}
              onPress={() => onChange({ ...value, allowEdits: !value.allowEdits })}
            />
            <Toggle
              label={t.composer.autoApprove}
              on={value.autoApprove}
              onPress={() => onChange({ ...value, autoApprove: !value.autoApprove })}
            />
          </Row>

          <Mono>{t.composer.model}</Mono>
          <Row gap={space.xs} style={styles.wrap}>
            <Chip
              label={t.composer.modelDefault}
              on={!value.model}
              onPress={() => onChange({ ...value, model: '' })}
            />
            {models.map((model) => (
              <Chip
                key={model.id}
                label={model.name}
                on={value.model === model.id}
                onPress={() => onChange({ ...value, model: model.id })}
              />
            ))}
          </Row>

          <Mono>{t.composer.effort}</Mono>
          <Row gap={space.xs} style={styles.wrap}>
            {EFFORTS.map((effort) => (
              <Chip
                key={effort}
                label={effort}
                on={value.effort === effort}
                onPress={() => onChange({ ...value, effort })}
              />
            ))}
          </Row>
        </View>
      ) : null}

      {value.files.length > 0 || note ? (
        <Row gap={space.xs} style={styles.wrap}>
          {value.files.map((file) => (
            <Pressable key={file.name} onPress={() => drop(file.name)} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {file.name} ✕
              </Text>
            </Pressable>
          ))}
          {note ? (
            <Mono style={voice.listening ? styles.listening : styles.refused}>{note}</Mono>
          ) : null}
        </Row>
      ) : null}

      <Row gap={space.sm} style={styles.bar}>
        <Pressable onPress={() => setOpen((state) => !state)} style={styles.gear}>
          <Text style={styles.gearText}>{open ? '×' : '⚙'}</Text>
        </Pressable>
        <Pressable
          onPress={() => void attach()}
          style={styles.gear}
          accessibilityLabel={t.composer.attach}
        >
          <Text style={styles.gearText}>📎</Text>
        </Pressable>
        <Field
          value={value.text}
          onChangeText={(text) => {
            typed.current = text.trim();
            onChange({ ...value, text });
          }}
          placeholder={isRunning ? t.composer.queue : t.composer.ask}
          multiline
          autoCapitalize="sentences"
          style={styles.input}
        />
        {isRunning ? (
          <Pressable
            onPress={onStop}
            accessibilityRole="button"
            accessibilityLabel={t.composer.stop}
            style={({ pressed }) => [styles.round, styles.stop, pressed && styles.pressed]}
          >
            <View style={styles.stopMark} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={toggleVoice}
          accessibilityRole="button"
          accessibilityLabel={t.composer.voice}
          style={({ pressed }) => [
            styles.round,
            styles.mic,
            voice.listening && styles.micOn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.micText}>🎙</Text>
        </Pressable>
        <Pressable
          onPress={onSend}
          disabled={!value.text.trim() || busy}
          accessibilityRole="button"
          accessibilityLabel={t.composer.send}
          style={({ pressed }) => [
            styles.round,
            styles.send,
            (!value.text.trim() || busy) && styles.sendOff,
            pressed && styles.pressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Text style={styles.sendText}>↑</Text>
          )}
        </Pressable>
      </Row>
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]}>
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.sm,
    gap: space.sm,
  },
  options: { gap: space.sm, paddingHorizontal: space.xs },
  wrap: { flexWrap: 'wrap' },
  bar: { alignItems: 'flex-end' },
  input: { flex: 1, minHeight: 52 },
  gear: {
    width: 32,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearText: { color: colors.textDim, fontSize: 18 },
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  send: { backgroundColor: colors.accent },
  sendOff: { opacity: 0.4 },
  sendText: { color: colors.text, fontSize: 26, fontWeight: '700', lineHeight: 30 },
  mic: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  micOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  micText: { fontSize: 22, lineHeight: 26 },
  stop: { backgroundColor: colors.danger },
  stopMark: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.text },
  toggle: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  toggleText: { color: colors.textDim, fontSize: font.small },
  toggleTextOn: { color: colors.text },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 160,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipText: { color: colors.textFaint, fontSize: font.small },
  chipTextOn: { color: colors.text },
  refused: { color: colors.danger },
  listening: { color: colors.accent },
});
