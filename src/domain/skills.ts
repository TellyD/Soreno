export type SkillScope = "global" | "project";

export type SkillSource = {
  lockName: string;
  source: string;
  sourceType: string;
  sourceUrl: string | null;
};

export type InstalledSkill = {
  name: string;
  title: string;
  description: string | null;
  source: SkillSource | null;
};

export type SkillInventory = {
  skills: InstalledSkill[];
};

export function filterSkills(
  skills: InstalledSkill[],
  query: string,
): InstalledSkill[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    [skill.title, skill.name, skill.description, skill.source?.source].some(
      (value) => value?.toLocaleLowerCase().includes(needle),
    ),
  );
}
