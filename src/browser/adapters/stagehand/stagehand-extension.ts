import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserError } from '../../../common/errors/browser.errors';

// Chromium's id for an unpacked extension: SHA-256 of its absolute path (UTF-8 on POSIX,
// UTF-16LE with an upper-case drive letter on Windows), first 32 hex digits mapped to a-p.
// Known before launch so --remote-allow-origins can name exactly this extension.
export function unpackedExtensionId(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
) {
  return extensionIdForPath(realpathSync(extensionPath), platform);
}
export function extensionIdForPath(path: string, platform: NodeJS.Platform) {
  const bytes =
    platform === 'win32'
      ? Buffer.from(
          path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
          'utf16le',
        )
      : Buffer.from(path, 'utf8');
  return createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + parseInt(digit, 16)),
    );
}

// The package only exports an ESM entry point, so the bundled extension is located by
// walking the module search path instead of require.resolve.
export function stagehandExtensionPath(
  searchPaths = require.resolve.paths('@browserbasehq/stagehand') || [],
) {
  for (const base of searchPaths) {
    const directory = join(
      base,
      '@browserbasehq',
      'stagehand',
      'dist',
      'extension',
    );
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, 'manifest.json'), 'utf8'),
      ) as { name?: string; manifest_version?: number };
      // Resolved so Chromium loads the same path the extension id is derived from.
      if (
        manifest.name === 'Stagehand Runtime' &&
        manifest.manifest_version === 3
      )
        return realpathSync(directory);
    } catch {
      continue;
    }
  }
  throw new BrowserError(
    'STAGEHAND_EXTENSION_MISSING',
    'Stagehand extension bundle not found; install @browserbasehq/stagehand with its dist/extension directory',
    500,
  );
}
