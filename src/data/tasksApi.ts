import { invoke } from "@tauri-apps/api/core";
import {
  defaultTaskStatus,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../domain/tasks";

export async function listTasks(): Promise<Task[]> {
  return invoke<Task[]>("list_tasks");
}

export async function createTask(
  title: string,
  status: TaskStatus = defaultTaskStatus,
  id = crypto.randomUUID(),
): Promise<Task> {
  return invoke<Task>("create_task", {
    id,
    status,
    title,
  });
}

export async function updateTaskTitle(
  id: string,
  title: string,
): Promise<Task> {
  return invoke<Task>("update_task_title", { id, title });
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
): Promise<Task> {
  return invoke<Task>("update_task_status", { id, status });
}

export async function updateTaskPriority(
  id: string,
  priority: TaskPriority,
): Promise<Task> {
  return invoke<Task>("update_task_priority", { id, priority });
}

export async function updateTaskAttachedNote(
  id: string,
  noteId: string | null,
): Promise<Task> {
  return invoke<Task>("update_task_attached_note", { id, noteId });
}

export async function deleteTask(id: string): Promise<void> {
  return invoke("delete_task", { id });
}
