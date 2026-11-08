import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileKind,
  ProjectFileListing,
  ProjectFileSearchResult,
  ProjectFileWriteResult,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from "../domain/projectFiles";

export const listProjectFiles = (projectId: string, directory: string) =>
  invoke<ProjectFileListing>("project_files_list", { projectId, directory });

export const searchProjectFiles = (
  projectId: string,
  query: string,
  refresh = false,
  recent: string[] = [],
) =>
  invoke<ProjectFileSearchResult>("project_files_search", {
    projectId,
    query,
    refresh,
    recent,
  });

export const searchProjectText = (
  projectId: string,
  query: string,
  options: ProjectTextSearchOptions,
  refresh = false,
) =>
  invoke<ProjectTextSearchResult>("project_files_search_text", {
    projectId,
    query,
    options,
    refresh,
  });

export const readProjectFile = (projectId: string, path: string) =>
  invoke<ProjectFileContent>("project_files_read", { projectId, path });

export const writeProjectFile = (
  projectId: string,
  path: string,
  content: string,
  expectedVersion: string,
) =>
  invoke<ProjectFileWriteResult>("project_files_write", {
    projectId,
    path,
    content,
    expectedVersion,
  });

export const createProjectFile = (
  projectId: string,
  path: string,
  kind: ProjectFileKind,
) =>
  invoke<ProjectFileEntry>("project_files_create", { projectId, path, kind });

export const renameProjectFile = (
  projectId: string,
  from: string,
  to: string,
) => invoke<ProjectFileEntry>("project_files_rename", { projectId, from, to });

export const deleteProjectFile = (projectId: string, path: string) =>
  invoke<void>("project_files_delete", { projectId, path });

export const duplicateProjectFile = (projectId: string, path: string) =>
  invoke<ProjectFileEntry>("project_files_duplicate", { projectId, path });

/** Copies the files of the system clipboard into `directory`. */
export const pasteProjectFiles = (projectId: string, directory: string) =>
  invoke<ProjectFileEntry[]>("project_files_paste", { projectId, directory });

/** Copies a file to a location picked in the save dialog; resolves `false` when cancelled. */
export const downloadProjectFile = (projectId: string, path: string) =>
  invoke<boolean>("project_files_download", { projectId, path });
