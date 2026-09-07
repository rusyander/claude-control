import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// Та же причина, что и в чате: родная реализация на Android под edge-to-edge
// поле ввода не поднимает.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type {
  ProjectTestAutomationStatus,
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestKind,
  ProjectTestPriority,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { toSteps } from '@agentdeck/contracts/test-format';
import { Button, Chips, Field, Muted, Row, Title } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';

/**
 * Правка кейса на телефоне.
 *
 * Шаги — список строк, а не одно многострочное поле: у шага появилось СВОЁ
 * ожидание, и склеить пару «действие + ожидание» в одну строку значит потерять
 * половину смысла ручного прогона, где галочка ставится на каждом шаге
 * отдельно. Разбор чужих файлов остаётся общим (`toSteps`): кейс, написанный
 * когда шаги были строками, открывается здесь без миграции.
 *
 * Чек-лист живёт без ожиданий и предусловий — поэтому у типа `checklist` эти
 * поля не показываются вовсе: пустая форма врёт про то, что её надо заполнить.
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
  const [kind, setKind] = useState<ProjectTestKind>('case');
  const [priority, setPriority] = useState<ProjectTestPriority>('medium');
  const [automation, setAutomation] = useState<ProjectTestAutomationStatus>('manual');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [area, setArea] = useState('');
  const [section, setSection] = useState('');
  const [precondition, setPrecondition] = useState('');
  const [steps, setSteps] = useState<ProjectTestStep[]>([]);
  const [expected, setExpected] = useState('');
  const [oracle, setOracle] = useState('');
  const [tags, setTags] = useState('');
  const [isSaving, setSaving] = useState(false);

  // Поля наполняются при открытии: пока окно закрыто, подставлять в него
  // нечего, а сброс на каждый ввод символа стирал бы набранное.
  useEffect(() => {
    if (!isOpen) return;
    setKind(testCase?.type ?? 'case');
    setPriority(testCase?.priority ?? 'medium');
    setAutomation(testCase?.automation?.status ?? 'manual');
    setTitle(testCase?.title ?? '');
    setPurpose(testCase?.purpose ?? '');
    setArea(testCase?.area ?? '');
    setSection(testCase?.section ?? '');
    setPrecondition(testCase?.precondition ?? '');
    setSteps(toSteps(testCase?.steps ?? []));
    setExpected(testCase?.expected ?? '');
    setOracle(testCase?.oracle ?? '');
    setTags((testCase?.tags ?? []).join(', '));
  }, [isOpen, testCase]);

  const patchStep = (index: number, patch: Partial<ProjectTestStep>): void =>
    setSteps((list) => list.map((step, at) => (at === index ? { ...step, ...patch } : step)));

  const submit = (): void => {
    setSaving(true);
    void onSave({
      id: testCase?.id,
      type: kind,
      title,
      purpose,
      area,
      section,
      precondition: kind === 'checklist' ? undefined : precondition,
      steps: steps.filter((step) => step.action.trim().length > 0),
      expected: kind === 'checklist' ? undefined : expected,
      oracle: kind === 'checklist' ? undefined : oracle,
      priority,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      automation: { ...testCase?.automation, status: automation },
    }).finally(() => setSaving(false));
  };

  return (
    <Modal visible={isOpen} animationType="slide" onRequestClose={onClose} transparent={false}>
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <ScrollView contentContainerStyle={styles.body}>
          <Title>{testCase ? t.tests.editCase : t.tests.addCase}</Title>

          <View style={styles.group}>
            <Muted>{t.tests.caseType}</Muted>
            <Chips
              value={kind}
              onChange={setKind}
              options={[
                { value: 'case', label: t.tests.kind.case },
                { value: 'checklist', label: t.tests.kind.checklist },
              ]}
            />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.caseTitle}</Muted>
            <Field value={title} onChangeText={setTitle} autoCapitalize="sentences" />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.casePriority}</Muted>
            <Chips
              value={priority}
              onChange={setPriority}
              options={[
                { value: 'blocker', label: t.tests.priority.blocker },
                { value: 'high', label: t.tests.priority.high },
                { value: 'medium', label: t.tests.priority.medium },
                { value: 'low', label: t.tests.priority.low },
              ]}
            />
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
            <Muted>{t.tests.caseSection}</Muted>
            <Field
              value={section}
              onChangeText={setSection}
              placeholder={t.tests.caseSectionHint}
            />
          </View>
          <View style={styles.group}>
            <Muted>{t.tests.caseTags}</Muted>
            <Field value={tags} onChangeText={setTags} />
          </View>

          {kind === 'case' ? (
            <View style={styles.group}>
              <Muted>{t.tests.casePrecondition}</Muted>
              <Field
                value={precondition}
                onChangeText={setPrecondition}
                multiline
                autoCapitalize="sentences"
              />
            </View>
          ) : null}

          <View style={styles.group}>
            <Muted>{t.tests.caseSteps}</Muted>
            {steps.map((step, index) => (
              <View key={index} style={styles.step}>
                <Row gap={space.xs}>
                  <Muted style={styles.grow}>{t.tests.stepAction(index + 1)}</Muted>
                  <Pressable
                    onPress={() => setSteps((list) => list.filter((_, at) => at !== index))}
                  >
                    <Text style={styles.removeStep}>{t.tests.stepRemove}</Text>
                  </Pressable>
                </Row>
                <Field
                  value={step.action}
                  onChangeText={(value) => patchStep(index, { action: value })}
                  multiline
                  autoCapitalize="sentences"
                />
                {kind === 'case' ? (
                  <Field
                    value={step.expected ?? ''}
                    onChangeText={(value) => patchStep(index, { expected: value })}
                    placeholder={t.tests.stepExpected}
                    autoCapitalize="sentences"
                  />
                ) : null}
              </View>
            ))}
            <Button
              title={t.tests.stepAdd}
              onPress={() => setSteps((list) => [...list, { action: '' }])}
            />
          </View>

          {kind === 'case' ? (
            <>
              <View style={styles.group}>
                <Muted>{t.tests.caseExpected}</Muted>
                <Field
                  value={expected}
                  onChangeText={setExpected}
                  multiline
                  autoCapitalize="sentences"
                />
              </View>
              <View style={styles.group}>
                <Muted>{t.tests.caseOracle}</Muted>
                <Field value={oracle} onChangeText={setOracle} autoCapitalize="sentences" />
              </View>
            </>
          ) : null}

          <View style={styles.group}>
            <Muted>{t.tests.caseAutomation}</Muted>
            <Chips
              value={automation}
              onChange={setAutomation}
              options={[
                { value: 'manual', label: t.tests.automation.manual },
                { value: 'toAutomate', label: t.tests.automation.toAutomate },
                { value: 'automated', label: t.tests.automation.automated },
              ]}
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
  step: { gap: space.xs },
  removeStep: { color: colors.danger, fontSize: font.small },
  grow: { flex: 1 },
});
