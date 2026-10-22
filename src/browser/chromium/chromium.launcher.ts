import {
  ChromiumConnection,
  type ChromiumLaunchOptions,
} from './chromium.connection';
export function launchChromium(options: ChromiumLaunchOptions) {
  return ChromiumConnection.launch(options);
}
