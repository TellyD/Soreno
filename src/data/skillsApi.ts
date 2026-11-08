import { invoke } from "@tauri-apps/api/core";
import type { SkillInventory, SkillScope } from "../domain/skills";

export const listSkills = ({
  scope,
  projectId,
}: {
  scope: SkillScope;
  projectId: string | null;
}) => invoke<SkillInventory>("skills_list", { scope, projectId });
