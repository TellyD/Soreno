import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  availableOmpUpdate,
  updateOmp as installOmpUpdate,
} from "../data/agentConversationApi";
import { errorMessage } from "../domain/errors";
import { notifyError } from "../notifications";

export function useOmpUpdate(
  projectId: string,
  empty: boolean,
  onRestart: () => void,
  updateError: (message: string) => string,
) {
  const [ompUpdate, setOmpUpdate] = useState<string | null>(null);
  const [ompUpdated, setOmpUpdated] = useState<string | null>(null);
  const [updatingOmp, setUpdatingOmp] = useState(false);
  const emptyNow = useRef(empty);
  useEffect(() => {
    emptyNow.current = empty;
    if (!empty || !isTauri()) return;
    let current = true;
    void availableOmpUpdate(projectId).then(
      (version) => {
        if (current) setOmpUpdate(version);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [empty, projectId]);
  async function updateOmp(version: string) {
    setUpdatingOmp(true);
    try {
      await installOmpUpdate(projectId);
      setOmpUpdate(null);
      // A message sent meanwhile started a turn: the update waits for the next start.
      if (emptyNow.current) {
        setOmpUpdated(version);
        onRestart();
      }
    } catch (error) {
      notifyError(updateError(errorMessage(error)));
    } finally {
      setUpdatingOmp(false);
    }
  }
  return { ompUpdate, ompUpdated, setOmpUpdated, updatingOmp, updateOmp };
}
