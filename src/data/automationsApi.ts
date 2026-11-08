import { invoke } from "@tauri-apps/api/core";
import type {
  AgentAutomation,
  AgentAutomationInput,
} from "../domain/automations";

export const loadAgentAutomations = () =>
  invoke<AgentAutomation[]>("agent_automations");
export const saveAgentAutomation = (automation: AgentAutomationInput) =>
  invoke<AgentAutomation>("agent_save_automation", { automation });
export const deleteAgentAutomation = (sessionId: string) =>
  invoke<void>("agent_delete_automation", { sessionId });
export const runAgentAutomation = (sessionId: string) =>
  invoke<AgentAutomation>("agent_run_automation", { sessionId });
export const refreshAgentAutomations = (projectId: string) =>
  invoke<AgentAutomation[]>("agent_refresh_automations", { projectId });
export const markAgentAutomationSeen = (sessionId: string) =>
  invoke<AgentAutomation>("agent_mark_automation_seen", { sessionId });
