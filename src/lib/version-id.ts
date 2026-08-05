/**
 * Version identifiers: `"lodash@4.17.15"`, `"@types/node@22.10.2"`.
 *
 * A single string as the unique key keeps `MERGE (v:Version {id: ...})` cheap and
 * makes a chain of versions serialisable as a plain array of strings. The cost is
 * that splitting it is not `split("@")` — scoped package names contain an `@` of
 * their own — so the parsing lives here rather than being reinvented per caller.
 */

export type VersionRef = {
  /** Package name, including any scope: `"@types/node"`. */
  name: string;
  /** Version, or an empty string if the id carried none. */
  version: string;
};

export function parseVersionId(versionId: string): VersionRef {
  const separator = versionId.lastIndexOf("@");
  // Index 0 means the whole string is a scope with no version attached.
  if (separator <= 0) return { name: versionId, version: "" };
  return {
    name: versionId.slice(0, separator),
    version: versionId.slice(separator + 1),
  };
}

export function packageNameOf(versionId: string): string {
  return parseVersionId(versionId).name;
}

export function formatVersionId(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Compare two version strings by numeric segment.
 *
 * Deliberately not the `semver` package: that is a crawler dependency, and
 * pulling a parser into the application bundle to order two strings the registry
 * has already validated is not worth the bytes. Non-numeric segments such as a
 * `-rc.1` suffix sort as zero, which is enough for choosing the highest of a set
 * of published fix versions.
 */
export function compareVersions(a: string, b: string): number {
  const segments = (value: string) => value.split(/[.+-]/).map((part) => Number(part) || 0);
  const left = segments(a);
  const right = segments(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The highest of the given versions, ignoring nulls. */
export function highestVersion(versions: readonly (string | null)[]): string | null {
  return versions.reduce<string | null>((highest, version) => {
    if (!version) return highest;
    if (!highest) return version;
    return compareVersions(version, highest) > 0 ? version : highest;
  }, null);
}
