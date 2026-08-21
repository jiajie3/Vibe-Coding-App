import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/**
 * A "Done" bar above the keyboard, for inputs that have no return key.
 *
 * The iOS number pad has no return key at all, so without this an inspector
 * typing a silt depth cannot put the keyboard away.
 *
 * **Numeric fields only.** `InputAccessoryView` does not support multiline
 * TextInput on iOS — a documented React Native limitation (facebook/react-native
 * #18997), and the reason an earlier attempt at this appeared to work on the
 * number pad while doing nothing on the remarks box. Multiline fields use
 * `multilineDoneProps` below instead.
 *
 * Android has the back gesture, and this component is iOS-only, so it renders
 * nothing there.
 */

const KEYBOARD_ACCESSORY_ID = 'cfpi-keyboard-done';

/** For numeric / single-line inputs: adds a Done bar above the keyboard. */
export const keyboardDoneProps =
  Platform.OS === 'ios' ? { inputAccessoryViewID: KEYBOARD_ACCESSORY_ID } : {};

/**
 * For multiline inputs: makes Return close the keyboard.
 *
 * The trade-off is that you can no longer type a line break, which for an
 * inspection remark is a fair swap — being unable to dismiss the keyboard at all
 * blocks the rest of the form.
 */
export const multilineDoneProps = {
  returnKeyType: 'done' as const,
  submitBehavior: 'blurAndSubmit' as const,
};

export default function KeyboardDone() {
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={KEYBOARD_ACCESSORY_ID}>
      <View style={styles.bar}>
        <Pressable style={styles.btn} onPress={() => Keyboard.dismiss()} hitSlop={12}>
          <Text style={styles.text}>Done</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#F1F5F9',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#CBD5E1',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  btn: { paddingHorizontal: 14, paddingVertical: 7 },
  text: { color: '#2563EB', fontSize: 16, fontWeight: '700' },
});
