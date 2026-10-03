/**
 * Compares two message trees and lists every key that exists in one but
 * not the other, plus keys whose {placeholders} differ.
 */
type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

function placeholders(message: string): string {
  return [...message.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]).sort().join(",");
}

export function compareMessages(a: Tree, b: Tree, names: [string, string] = ["en", "bn"]): string[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const problems: string[] = [];
  for (const key of fa.keys()) if (!fb.has(key)) problems.push(`${key} is missing from ${names[1]}`);
  for (const key of fb.keys()) if (!fa.has(key)) problems.push(`${key} is missing from ${names[0]}`);
  for (const [key, value] of fa) {
    const other = fb.get(key);
    if (other !== undefined && placeholders(value) !== placeholders(other)) {
      problems.push(`${key} has different placeholders in ${names[0]} and ${names[1]}`);
    }
    if (value.trim() === "" || (other !== undefined && other.trim() === "")) {
      problems.push(`${key} is empty`);
    }
  }
  return problems;
}
