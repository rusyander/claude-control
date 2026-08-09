import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
// Та же причина, что и в чате: родная реализация на Android под edge-to-edge
// поле ввода не поднимает.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { ProjectTestCase, ProjectTestCaseInput } from '@claude-control/contracts';
import { Button, Field, Muted, Row, Title } from '../../shared/ui';
import { colors, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';

/**
 * Правка кейса на телефоне.
 *
 * Шаги — одно многострочное поле, а не список с кнопкой «добавить»: на
 * сенсорном экране каждая лишняя кнопка между строками стоит дороже, чем
 * привычка писать подряд. Разбор по переводам строк делает сервер — тот же
 * код, что разбирает файл, написанный агентом.
 *
 * Окно системное (`Modal`), а не отдельный маршрут: правка живёт поверх списка,
 * и возвращаться в него «назад» после сохранения человеку не нужно.
 */
export function TestCaseEditor({
  isOpen,
  testCase,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  testCase?: ProjectTestCase;
  onClose: () => void;
  onSave: (input: ProjectTestCaseInput) => Promise<void>;
}) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [area, setArea] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [isSaving, setSaving] = useState(false);

  // Поля наполняются при открытии: пока окно закрыто, подставлять в него
  // нечего, а сброс на каждый ввод символа стирал бы набранное.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(testCase?.title ?? '');
    setPurpose(testCase?.purpose ?? '');
    setArea(testCase?.area ?? '');
    setSteps((testCase?.steps ?? []).join('\n'));
    setExpected(testCase?.expected ?? '');
  }, [isOpen, testCase]);

  const submit = (): void => {
    setSaving(true);
    void onSave({
      id: testCase?.id,
      title,
      purpose,
      area,
      steps: steps.split('\n'),
      expected,
    }).finally(() => setSaving(false));
  };

  return (
    <Modal visible={isOpen} animationType="slide" onRequestClose={onClose} transparent={false}>
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <ScrollView contentContainerStyle={styles.body}>
          <Title>{testCase ? t.tests.editCase : t.tests.addCase}</Title>

          <View style={styles.group}>
            <Muted>{t.tests.caseTitle}</Muted>
            <Field value={title} onChangeText={setTitle} autoCapitalize="sentences" />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.casePurpose}</Muted>
            <Field value={purpose} onChangeText={setPurpose} autoCapitalize="sentences" />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.caseArea}</Muted>
            <Field value={area} onChangeText={setArea} />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.caseSteps}</Muted>
            <Field value={steps} onChangeText={setSteps} multiline autoCapitalize="sentences" />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.caseExpected}</Muted>
            <Field
              value={expected}
              onChangeText={setExpected}
              multiline
              autoCapitalize="sentences"
            />
          </View>

          <Row gap={space.xs}>
            <Button title={t.common.close} onPress={onClose} style={styles.grow} />
            <Button
              title={t.tests.save}
              tone="accent"
              onPress={submit}
              busy={isSaving}
              disabled={title.trim().length === 0}
              style={styles.grow}
            />
          </Row>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, gap: space.md },
  group: { gap: space.xs },
  grow: { flex: 1 },
});
