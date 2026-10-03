/** One colour per nominee position, used for the share bar and the matching cards. */
const HUES = [168, 205, 38, 330, 262, 14, 120, 290, 190, 55];

export function nomineeHue(index: number): number {
  return HUES[index % HUES.length]!;
}
