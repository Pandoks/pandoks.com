import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { NavigationBar } from 'expo-navigation-bar';
import { useEffect } from 'react';
import { Platform, StatusBar, useColorScheme } from 'react-native';
import {
  registerDevice,
  useDevicePushToken,
  useNotificationRouting
} from '@pandoks.com/react-native-notifications';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { token } = useDevicePushToken();
  useNotificationRouting();

  useEffect(() => {
    if (token && BACKEND_URL) {
      void registerDevice({ backendUrl: BACKEND_URL, token });
    }
  }, [token]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* NOTE: iOS's default status bar follows the theme; Android's system bar icons don't */}
      {Platform.OS === 'android' && (
        <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
      )}
      <NavigationBar style="auto" />
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="device">
          <NativeTabs.Trigger.Label>Device</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="iphone" md="smartphone" />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
