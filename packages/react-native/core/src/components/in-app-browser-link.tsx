import { Href, Link } from 'expo-router';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { type ComponentProps } from 'react';

type Props = Omit<ComponentProps<typeof Link>, 'href'> & { href: Href & string };

export function InAppBrowserLink({ href, ...rest }: Props) {
  return (
    <Link
      {...rest}
      href={href}
      onPress={async (event) => {
        // Prevent the default behavior for external links on native.
        event.preventDefault();
        await openBrowserAsync(href, {
          presentationStyle: WebBrowserPresentationStyle.AUTOMATIC
        });
      }}
    />
  );
}
