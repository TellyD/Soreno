import { describe, expect, it } from "vitest";
import { filterSkills, type InstalledSkill } from "./skills";

describe("filterSkills", () => {
  const skill = (
    name: string,
    description: string | null,
    source: string | null = null,
  ): InstalledSkill => ({
    name,
    title: name,
    description,
    source: source
      ? { lockName: name, source, sourceType: "github", sourceUrl: null }
      : null,
  });
  const skills = [
    skill("pdf", "Lire des PDF"),
    skill("docx", null, "anthropics/skills"),
  ];

  it("matches names, descriptions and sources case-insensitively", () => {
    expect(filterSkills(skills, " pDf ").map(({ name }) => name)).toEqual([
      "pdf",
    ]);
    expect(filterSkills(skills, "lire").map(({ name }) => name)).toEqual([
      "pdf",
    ]);
    expect(filterSkills(skills, "ANTHROPICS").map(({ name }) => name)).toEqual([
      "docx",
    ]);
    expect(filterSkills(skills, "  ")).toBe(skills);
  });
});
