import { invoke } from "@tauri-apps/api/core";
import type {
  ForgeChanges,
  ForgeCheckout,
  ForgeFilter,
  ForgeMergeMethod,
  ForgeRemote,
  ForgeRequestDetail,
  ForgeRequestSummary,
  ForgeUpdateAction,
} from "../domain/forge";
import type { GitComparison } from "../domain/projectGit";

export const readForgeRemote = (projectId: string) =>
  invoke<ForgeRemote>("project_forge_remote", { projectId });
export const readForgeRequests = (
  projectId: string,
  filter: ForgeFilter,
  search: string,
) =>
  invoke<ForgeRequestSummary[]>("project_forge_requests", {
    projectId,
    filter,
    search,
  });
export const readForgeRequest = (projectId: string, number: number) =>
  invoke<ForgeRequestDetail>("project_forge_request", { projectId, number });
export const readForgeChanges = (
  projectId: string,
  detail: ForgeRequestDetail,
) =>
  invoke<ForgeChanges>("project_forge_changes", {
    projectId,
    repository: detail.repository,
    number: detail.number,
    head: {
      headOid: detail.headOid,
      baseOid: detail.baseOid,
      sourceBranch: detail.sourceBranch,
      crossRepository: detail.crossRepository,
    },
  });
export const readForgeComparison = (
  projectId: string,
  base: string,
  head: string,
  path: string,
) =>
  invoke<GitComparison>("project_forge_comparison", {
    projectId,
    base,
    head,
    path,
  });
export const mergeForgeRequest = (
  projectId: string,
  repository: string,
  number: number,
  method: ForgeMergeMethod,
  headOid: string,
) =>
  invoke<null>("project_forge_merge", {
    projectId,
    repository,
    number,
    method,
    headOid,
  });
export const updateForgeRequest = (
  projectId: string,
  repository: string,
  number: number,
  action: ForgeUpdateAction,
) =>
  invoke<null>("project_forge_update", {
    projectId,
    repository,
    number,
    action,
  });
export const checkoutForgeRequest = (
  projectId: string,
  detail: ForgeRequestDetail,
  version: string,
) =>
  invoke<ForgeCheckout>("project_forge_checkout", {
    projectId,
    repository: detail.repository,
    number: detail.number,
    version,
    head: {
      headOid: detail.headOid,
      baseOid: detail.baseOid,
      sourceBranch: detail.sourceBranch,
      crossRepository: detail.crossRepository,
    },
  });
