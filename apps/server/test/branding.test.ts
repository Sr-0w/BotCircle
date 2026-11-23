import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #75: the product is BotCircle. The old name survives only as technical identifiers kept for compatibility
// (npm scope, OPENDOTS_* env, cookies, x-opendots-client header, Docker labels/images, Android applicationId…),
// documented in docs/renaming.md and docs/rebrand-audit-75.md. This guards the user-facing resources.
const root = resolve(import.meta.dirname, '../../..');
// Old brand used as a name: "OpenDots", "Open Dots", "open-dots", or a bare word `opendots` that is not part of an
// identifier (no @ . / - _ : prefix/suffix, not a path segment, not a camelCase/class name such as OpenDotsClient).
const OLD_BRAND = /(?<![@.\/\w-])open[ _-]?dots(?![.\/\w:-])/i;

function files(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

const surfaces: Record<string, string[]> = {
  'Android strings': files(join(root, 'apps/android/app/src/main/res'), (p) => /strings\.xml$/.test(p)),
  'Android manifest': [join(root, 'apps/android/app/src/main/AndroidManifest.xml')],
  'Web shell and PWA': [join(root, 'apps/web/index.html'), ...files(join(root, 'apps/web/public'), (p) => /\.(svg|json|webmanifest|html|js)$/.test(p))],
  'Web translations': [join(root, 'apps/web/src/lib/i18n.ts'), join(root, 'apps/web/src/lib/i18n-en.ts')],
  'Agent prompts': [join(root, 'apps/server/src/agents/prompt.ts')],
};

describe('#75 no legacy brand in user-facing resources', () => {
  for (const [name, list] of Object.entries(surfaces)) {
    it(name, () => {
      expect(list.length).toBeGreaterThan(0);
      const offenders = list.flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/).map((line, i) => ({ file, line: i + 1, text: line })).filter((l) => OLD_BRAND.test(l.text)));
      expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([]);
    });
  }
  it('the matcher flags the old name and spares identifiers and OpenCode', () => {
    for (const bad of ['Welcome to OpenDots', 'Open Dots', 'open-dots', 'opendots is great']) expect(OLD_BRAND.test(bad), bad).toBe(true);
    for (const ok of ['@opendots/shared', 'x-opendots-client', 'app.dot.opendots', 'OpenDotsClient', 'opendots.example', 'OpenCode', 'opendots-open-browser', 'OPENDOTS_DATA_DIR']) expect(OLD_BRAND.test(ok), ok).toBe(false);
  });
});
