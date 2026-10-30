# React Native Notifications

Notification baseline for Expo Router apps on
[expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications), with raw APNs and FCM
tokens for [our push service](/apps/push) instead of Expo's.

Importing it shows notifications in the foreground and creates the Android `default` channel.

| Export                                                | Description                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `useNotificationPermission()`                         | `[permission, requestPermission]`                                      |
| `useNotificationRouting()`                            | Opens a tapped notification's `url`; call in the root layout           |
| `useDevicePushToken()`                                | `{ token, error }`, updated when the token changes                     |
| `registerDevice({ backendUrl, token, headers })`      | `PUT /devices/{token}`, with the APNs environment of the running build |
| `unregisterDevice({ backendUrl, token, headers })`    | `DELETE /devices/{token}`                                              |
| `scheduleNotification({ title, body, url, trigger })` | `trigger` is `{ date }`, `{ seconds }`, or daily `{ hour, minute }`    |

`backendUrl` is the app's authenticated backend, not the push service; it adds the signed-in user's
`user_id` and forwards the request. Register again whenever the token changes:

```tsx
const { token } = useDevicePushToken();
useEffect(() => {
  if (token) void registerDevice({ backendUrl, token, headers: { authorization } });
}, [token, authorization]);
```

Put the route in the APNs payload's `body` and in FCM's `data.body` as a JSON string, and send
Android notifications on the `default` channel:

```json
{ "aps": { "alert": { "title": "Hi" } }, "body": { "url": "/device" } }
```

```json
{
  "notification": { "title": "Hi" },
  "android": { "notification": { "channel_id": "default" } },
  "data": { "body": "{\"url\":\"/device\"}" }
}
```

## Setup

Add `"expo-notifications"` to the app's `plugins`, which sets the iOS `aps-environment` entitlement.
Android needs Firebase for a token: add `"googleServicesFile": "./google-services.json"` under
`android` in `app.json`. Without the exact alarm permission, which Android 14+ denies by default and
this package doesn't request, Android delivers scheduled notifications at an approximate time.
