export const RESEARCH_CHROMIUM_ARGS = [
  '--disable-quic',
  '--proxy-bypass-list=<-loopback>',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

// Stagehand 4.1.0 drives the browser through its bundled MV3 extension. The extension is
// loaded at launch (no CDP-side Extensions.loadUnpacked), and the debugging endpoint is
// bound to loopback so only this process can reach it.
export function stagehandChromiumArgs(
  extensionPath: string,
  extensionId: string,
) {
  return [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    // The extension opens its own CDP WebSocket; only its origin may do so.
    '--remote-allow-origins=chrome-extension://' + extensionId,
    // Required by Stagehand to attach CDP to its extension service worker.
    '--enable-unsafe-extension-debugging',
    '--load-extension=' + extensionPath,
    '--disable-extensions-except=' + extensionPath,
  ];
}
