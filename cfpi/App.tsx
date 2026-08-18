import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CameraScreen from './src/screens/CameraScreen.tsx';
import ChecklistScreen from './src/screens/ChecklistScreen.tsx';
import InspectionScreen from './src/screens/InspectionScreen.tsx';
import JobListScreen from './src/screens/JobListScreen.tsx';
import OverrideScreen from './src/screens/OverrideScreen.tsx';
import SettingsScreen from './src/screens/SettingsScreen.tsx';
import SignInScreen from './src/screens/SignInScreen.tsx';
import SubmittedScreen from './src/screens/SubmittedScreen.tsx';
import { isSignedIn, loadSession, onAuthChange } from './src/services/auth.ts';
import { startAutoDrain } from './src/services/outbox.ts';

const Stack = createNativeStackNavigator();

export default function App() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  // Restore the session before deciding which screen to show, or a signed-in
  // inspector sees the login form flash on every cold start.
  useEffect(() => {
    void loadSession().then((ok) => {
      setSignedIn(ok);
      setReady(true);
    });
    return onAuthChange(() => setSignedIn(isSignedIn()));
  }, []);

  // Keep retrying the queue in the background, so work completed offline syncs
  // as soon as the inspector is back in range without anyone tapping anything.
  useEffect(() => startAutoDrain(), []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0F172A', justifyContent: 'center' }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={signedIn ? 'dark' : 'light'} />
      {!signedIn ? (
        <SignInScreen onSignedIn={() => setSignedIn(true)} />
      ) : (
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Jobs" component={JobListScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Inspection" component={InspectionScreen} />
            <Stack.Screen name="Checklist" component={ChecklistScreen} />
            <Stack.Screen name="Override" component={OverrideScreen} />
            <Stack.Screen
              name="Camera"
              component={CameraScreen}
              options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="Submitted"
              component={SubmittedScreen}
              options={{ gestureEnabled: false }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}
