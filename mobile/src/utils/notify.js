import { Alert, Platform } from 'react-native';

// Alert.alert is unreliable on react-native-web.
export function notify(title, message, buttons) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
    const okButton = (buttons || []).find((b) => b.onPress);
    if (okButton) okButton.onPress();
    return;
  }
  Alert.alert(title, message, buttons);
}

export default notify;
