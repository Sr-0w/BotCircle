import type { AgentAvatar } from '@opendots/shared';

/**
 * #50: silhouettes. Presets are outlines in a 100×100 box; a custom shape is a short list of points, validated and
 * normalised here (count, bounds, area, no self-crossing, room for the eyes). Never free SVG.
 */
const ring = (count: number, radius: (i: number) => number, start = -90): [number, number][] =>
  Array.from({ length: count }, (_, i) => { const a = ((start + (360 / count) * i) * Math.PI) / 180; const r = radius(i); return [round(50 + r * Math.cos(a)), round(52 + r * Math.sin(a))]; });
const round = (v: number) => Math.round(v * 10) / 10;

export const AVATAR_PRESETS: Record<string, { label: string; points: [number, number][]; roundness: number }> = {
  circle: { label: 'Cercle', points: ring(12, () => 46), roundness: 1 },
  drop: { label: 'Goutte', points: [[50, 4], [70, 30], [86, 56], [78, 84], [50, 96], [22, 84], [14, 56], [30, 30]], roundness: 0.85 },
  house: { label: 'Maison', points: [[50, 6], [94, 42], [86, 42], [86, 94], [14, 94], [14, 42], [6, 42]], roundness: 0.35 },
  squircle: { label: 'Squircle', points: [[20, 8], [80, 8], [94, 22], [94, 82], [80, 96], [20, 96], [6, 82], [6, 22]], roundness: 0.45 },
  blob: { label: 'Blob', points: [[46, 6], [76, 14], [94, 40], [88, 72], [64, 94], [30, 90], [8, 66], [12, 30]], roundness: 1 },
  cat: { label: 'Chat', points: [[14, 34], [20, 4], [40, 22], [60, 22], [80, 4], [86, 34], [94, 62], [80, 90], [50, 96], [20, 90], [6, 62]], roundness: 0.5 },
  bulb: { label: 'Ampoule', points: [[50, 4], [82, 18], [92, 46], [74, 70], [66, 96], [34, 96], [26, 70], [8, 46], [18, 18]], roundness: 0.8 },
  star: { label: 'Étoile', points: ring(10, (i) => (i % 2 ? 30 : 48)), roundness: 0.35 },
  shield: { label: 'Bouclier', points: [[50, 4], [92, 16], [88, 56], [50, 96], [12, 56], [8, 16]], roundness: 0.5 },
};

export class AvatarError extends Error {}

/** The eyes sit around (42..58, 46..58): those points must be inside the outline. */
const EYE_ZONE: [number, number][] = [[41, 46], [59, 46], [41, 58], [59, 58], [50, 52]];

function inside(points: [number, number][], [x, y]: [number, number]) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const area = (points: [number, number][]) => Math.abs(points.reduce((sum, [x, y], i) => { const [nx, ny] = points[(i + 1) % points.length]; return sum + x * ny - nx * y; }, 0)) / 2;
function crosses(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** A preset name or a custom outline → the stored, normalised avatar. Throws a clear reason when not acceptable. */
export function resolveAvatar(input: { preset?: string | null; points?: unknown; roundness?: unknown }): AgentAvatar {
  if (input.preset) {
    const preset = AVATAR_PRESETS[input.preset];
    if (!preset) throw new AvatarError(`Forme inconnue : ${input.preset}. Formes disponibles : ${Object.keys(AVATAR_PRESETS).join(', ')}.`);
    return { preset: input.preset, points: preset.points, roundness: preset.roundness };
  }
  if (!Array.isArray(input.points)) throw new AvatarError('Donne un preset ou une liste de points.');
  if (input.points.length < 3 || input.points.length > 24) throw new AvatarError('Entre 3 et 24 points.');
  const points = input.points.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new AvatarError('Chaque point est [x, y] (nombres).');
    if (p[0] < 0 || p[0] > 100 || p[1] < 0 || p[1] > 100) throw new AvatarError('Les points restent dans la boîte 0–100.');
    return [round(p[0]), round(p[1])] as [number, number];
  });
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue;
    if (crosses(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) throw new AvatarError('Le contour se croise lui-même : donne les points dans l’ordre du tour.');
  }
  if (area(points) < 1500) throw new AvatarError('Forme trop petite : elle doit occuper une bonne partie de la boîte.');
  if (!EYE_ZONE.every((e) => inside(points, e))) throw new AvatarError('Les yeux (au centre, vers 42–58 × 46–58) doivent tenir dans la forme.');
  const roundness = typeof input.roundness === 'number' && Number.isFinite(input.roundness) ? Math.max(0, Math.min(1, input.roundness)) : 0.7;
  return { preset: null, points, roundness: round(roundness) };
}
