export type SkillGroup = "skills.sh" | "user" | "enabled";

/**
 * Accordion selection: only one group is open at a time. Clicking the open
 * group collapses it; clicking another switches to it.
 */
export function nextOpenGroup(current: SkillGroup | null, clicked: SkillGroup): SkillGroup | null {
  return current === clicked ? null : clicked;
}

/**
 * The skills.sh group hides entries already staged (user) or enabled, matched
 * by skill name, so an installed skill only appears in one place.
 */
export function hideInstalledFromLibrary<T extends { name: string }>(
  library: T[],
  installedNames: Set<string>,
): T[] {
  return library.filter((item) => !installedNames.has(item.name));
}
