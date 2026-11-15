import { SETI_FILES, SETI_PATHS } from '@/lib/file-icons.generated';
import { t } from '@/lib/i18n';

export type PreviewKind = 'code' | 'text' | 'markdown' | 'image' | 'pdf' | null;

const extension = (name: string) => /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** Shiki language for a file name, by extension. */
const LANGS: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', tsx: 'tsx', json: 'json', jsonc: 'jsonc',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish', ps1: 'powershell',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  dart: 'dart', lua: 'lua', r: 'r', sql: 'sql', yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'dotenv',
  vue: 'vue', svelte: 'svelte', graphql: 'graphql', gql: 'graphql', gradle: 'groovy', tf: 'hcl', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  scala: 'scala', clj: 'clojure', zig: 'zig', nim: 'nim', tex: 'latex', diff: 'diff', patch: 'diff', dockerfile: 'docker', makefile: 'makefile', csv: 'csv', tsv: 'tsv', log: 'log',
};
const TEXT = new Set(['txt', 'log', 'csv', 'tsv', 'text', 'lock']);
const NAMES: Record<string, string> = { dockerfile: 'docker', makefile: 'makefile' };

export function codeLanguage(name: string): string | null {
  return NAMES[name.toLowerCase()] ?? LANGS[extension(name)] ?? null;
}

export function previewKind(name: string, mediaType: string): PreviewKind {
  const ext = extension(name);
  if (/^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)$/.test(mediaType) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  if (mediaType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['md', 'markdown', 'mdx'].includes(ext) || mediaType === 'text/markdown') return 'markdown';
  if (TEXT.has(ext)) return 'text';
  if (codeLanguage(name)) return 'code';
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return 'text';
  return null;
}

const KINDS: [RegExp, string][] = [
  [/pdf/, 'PDF'], [/zip|tar|gzip|compressed|x-7z|rar/, 'Archive'], [/spreadsheet|excel/, 'Tableur'], [/wordprocessing|msword/, 'Document'],
  [/presentation|powerpoint/, 'Présentation'], [/^audio\//, 'Audio'], [/^video\//, 'Vidéo'], [/^image\//, 'Image'],
];
const NICE: Record<string, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript', json: 'JSON', shellscript: 'Shell', go: 'Go', rust: 'Rust', java: 'Java',
  kotlin: 'Kotlin', c: 'C', cpp: 'C++', csharp: 'C#', ruby: 'Ruby', php: 'PHP', swift: 'Swift', html: 'HTML', css: 'CSS', yaml: 'YAML', sql: 'SQL', xml: 'XML', toml: 'TOML',
};

/** "Python", "PDF", "Archive"… : what the file is, in a word. */
export function fileKindLabel(name: string, mediaType: string): string {
  const kind = previewKind(name, mediaType);
  if (kind === 'markdown') return 'Markdown';
  const lang = codeLanguage(name);
  if (lang && NICE[lang]) return NICE[lang];
  if (kind === 'text') return extension(name) === 'csv' ? 'CSV' : t('Texte');
  const known = KINDS.find(([pattern]) => pattern.test(mediaType));
  if (known) return t(known[1]);
  const ext = extension(name);
  return ext ? ext.toUpperCase() : t('Fichier');
}

/** Seti UI icon for a file: by exact name, extension, then type; the generic file icon otherwise. */
export function setiIcon(name: string, mediaType: string): { path: string; color: string } {
  const base = name.split('/').pop() ?? name;
  const hit = SETI_FILES[base] ?? SETI_FILES[extension(base)]
    ?? (mediaType.startsWith('image/') ? SETI_FILES.png : mediaType === 'application/pdf' ? SETI_FILES.pdf : mediaType.startsWith('video/') ? SETI_FILES.mp4 : mediaType.startsWith('audio/') ? SETI_FILES.mp3 : /zip|tar|gzip|compressed/.test(mediaType) ? SETI_FILES.zip : undefined);
  const [icon, color] = hit ?? ['default', ''];
  return { path: SETI_PATHS[icon] ?? SETI_PATHS.default, color };
}
