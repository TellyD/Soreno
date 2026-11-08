import { ChevronRight, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { pickAgentProjectDirectory } from "../../data/agentSessionsApi";
import {
  isAbsoluteProjectPath,
  type AgentProject,
} from "../../domain/agentSessions";
import { errorMessage } from "../../domain/errors";
import {
  gitRepositoryName,
  type GitCloneRequest,
} from "../../domain/projectGit";
import { useAgentEnvironmentDiscovery } from "../../hooks/useAgentEnvironmentDiscovery";
import { useNotification, useScopedNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import {
  AgentEnvironmentSelect,
  selectedAgentEnvironment,
} from "./AgentEnvironmentSelect";
import { useAgentStrings } from "./agentStrings";
import { formatOperationError } from "./operationError";
import {
  emptySshConnection,
  isValidSshPort,
  normalizedConnection,
  SshProjectFields,
} from "./SshProjectFields";

export type GitCloneRecovery = { request: GitCloneRequest; path: string };

export function GitCloneForm({
  busy,
  recovery,
  projects = [],
  onCancel,
  onClone,
  onOpenPreserved,
  returnFocusRef,
}: {
  busy: boolean;
  recovery: GitCloneRecovery | null;
  projects?: AgentProject[];
  onCancel: () => void;
  onClone: (request: GitCloneRequest) => Promise<void>;
  onOpenPreserved: (recovery: GitCloneRecovery) => Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const s = useAgentStrings();
  const id = useId();
  const [draft, setDraft] = useState<GitCloneRequest>(() => ({
    id: crypto.randomUUID(),
    name: "",
    environment: { kind: "local", distribution: null },
    parentPath: "",
    folderName: "",
    url: "",
  }));
  const notice = useScopedNotification("agent-clone-form");
  const [picking, setPicking] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [sshBusy, setSshBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const mounted = useRef(false);
  const pickerInFlight = useRef(false);
  const cloneInFlight = useRef(false);
  const sshInFlight = useRef(false);
  const locked = busy || picking || cloning || sshBusy;
  const requestInFlight = () =>
    busy ||
    pickerInFlight.current ||
    cloneInFlight.current ||
    sshInFlight.current;
  const dismiss = () => {
    if (!requestInFlight()) onCancel();
  };
  const surface = useDismissibleLayer<HTMLElement>(true, dismiss);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environments, wslUnavailable, discovering, discover } =
    useAgentEnvironmentDiscovery();
  useEffect(() => {
    if (!cloning) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [cloning]);

  function changeEnvironment(value: string) {
    if (requestInFlight()) return;
    const environment = selectedAgentEnvironment(value, draft.environment);
    const changed =
      environment.kind !== draft.environment.kind ||
      environment.distribution !== draft.environment.distribution;
    setDraft({
      ...draft,
      environment,
      parentPath: changed ? "" : draft.parentPath,
    });
  }
  async function pickParent() {
    if (requestInFlight()) return;
    pickerInFlight.current = true;
    setPicking(true);
    try {
      const selected = await pickAgentProjectDirectory(
        draft.environment,
        draft.parentPath || null,
        s.pickCloneParentTitle,
      );
      if (mounted.current && selected) {
        setDraft((current) => ({
          ...current,
          environment: selected.environment,
          parentPath: selected.path,
        }));
        notice.clear();
      }
    } catch (reason) {
      if (mounted.current)
        notice.error(
          formatOperationError(s, { message: errorMessage(reason) }),
        );
    } finally {
      pickerInFlight.current = false;
      if (mounted.current) setPicking(false);
    }
  }
  async function submit() {
    if (requestInFlight()) return;
    const suggestedName = gitRepositoryName(draft.url);
    let request = {
      ...draft,
      name: draft.name.trim() || suggestedName,
      parentPath: draft.parentPath.trim(),
      folderName: draft.folderName.trim() || suggestedName,
      url: draft.url.trim(),
    };
    if (!request.url) {
      notice.error(s.cloneUrlRequired);
      return;
    }
    if (!request.name) {
      notice.error(s.nameRequired);
      return;
    }
    if (
      request.environment.kind === "wsl" &&
      !request.environment.distribution
    ) {
      notice.error(s.distribution);
      return;
    }
    if (request.environment.kind === "ssh") {
      const ssh = request.environment.ssh;
      if (!ssh?.host.trim()) {
        notice.error(s.sshHostRequired);
        return;
      }
      if (!isValidSshPort(ssh.port)) {
        notice.error(s.sshPortInvalid);
        return;
      }
      request = {
        ...request,
        environment: { ...request.environment, ssh: normalizedConnection(ssh) },
      };
    }
    if (!isAbsoluteProjectPath(request.environment, request.parentPath)) {
      notice.error(s.absolutePath);
      return;
    }
    if (
      !request.folderName ||
      request.folderName === "." ||
      request.folderName === ".." ||
      /[\\/]/.test(request.folderName)
    ) {
      notice.error(s.cloneFolderInvalid);
      return;
    }
    notice.clear();
    cloneInFlight.current = true;
    setCloning(true);
    try {
      await onClone(request);
    } finally {
      cloneInFlight.current = false;
      if (mounted.current) setCloning(false);
    }
  }

  const activeRecovery = recovery?.request.id === draft.id ? recovery : null;
  useNotification(
    wslUnavailable
      ? {
          message: s.wslHint,
          tone: "warning",
          key: "agent-wsl-discovery",
          action: { label: s.refresh, onAction: () => void discover() },
        }
      : null,
  );
  useNotification(
    activeRecovery
      ? {
          message: s.clonePreserved(activeRecovery.path),
          tone: "warning",
          key: `agent-clone-recovery:${draft.id}`,
          action: {
            label: s.openPreserved,
            onAction: () => {
              if (!requestInFlight()) void onOpenPreserved(activeRecovery);
            },
          },
        }
      : null,
  );
  const suggestedName = gitRepositoryName(draft.url);
  return (
    <DialogOverlay>
      <DialogSurface
        className="agent-form-dialog"
        ref={surface}
        returnFocusRef={returnFocusRef}
        aria-labelledby={`${id}-title`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={`${id}-title`}>{s.cloneRepository}</h2>
          <fieldset disabled={locked}>
            <label htmlFor={`${id}-url`}>{s.cloneUrl}</label>
            <Input
              id={`${id}-url`}
              required
              spellCheck={false}
              placeholder={s.cloneUrlPlaceholder}
              value={draft.url}
              onChange={(event) =>
                setDraft({ ...draft, url: event.target.value })
              }
            />
            <AgentEnvironmentSelect
              id={id}
              environment={draft.environment}
              environments={environments}
              discovering={discovering}
              onValueChange={changeEnvironment}
            />
            {draft.environment.kind === "ssh" ? (
              <SshProjectFields
                id={id}
                connection={draft.environment.ssh ?? emptySshConnection()}
                path={draft.parentPath}
                projects={projects}
                disabled={locked}
                interactionLockRef={sshInFlight}
                onBusyChange={setSshBusy}
                onConnectionChange={(ssh) =>
                  setDraft((current) => ({
                    ...current,
                    environment: { kind: "ssh", distribution: null, ssh },
                  }))
                }
                onPathChange={(parentPath) =>
                  setDraft((current) => ({ ...current, parentPath }))
                }
              />
            ) : null}
            {draft.environment.kind !== "ssh" ? (
              <div className="agent-folder-row">
                <Button
                  startIcon={<FolderOpen />}
                  disabled={locked}
                  onClick={() => void pickParent()}
                >
                  {picking ? s.pickingFolder : s.chooseFolder}
                </Button>
                {draft.parentPath ? (
                  <code className="agent-folder-path" title={draft.parentPath}>
                    {draft.parentPath}
                  </code>
                ) : null}
              </div>
            ) : null}
            <details className="agent-form-options">
              <summary
                aria-disabled={locked}
                onClick={(event) => {
                  if (locked) event.preventDefault();
                }}
              >
                <ChevronRight size={14} aria-hidden="true" />
                {s.projectCustomization}
              </summary>
              <div className="agent-form-options-content">
                <label htmlFor={`${id}-name`}>{s.displayName}</label>
                <Input
                  id={`${id}-name`}
                  placeholder={suggestedName}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
                <label htmlFor={`${id}-folder`}>{s.cloneFolder}</label>
                <Input
                  id={`${id}-folder`}
                  spellCheck={false}
                  placeholder={suggestedName}
                  value={draft.folderName}
                  onChange={(event) =>
                    setDraft({ ...draft, folderName: event.target.value })
                  }
                />
              </div>
            </details>
          </fieldset>
          {cloning ? (
            <p className="agent-form-progress" role="status">
              <LoaderCircle
                size={14}
                className="app-loading-spinner"
                aria-hidden="true"
              />
              {s.cloningElapsed(elapsed)}
            </p>
          ) : null}
          <footer>
            <Button disabled={locked} onClick={dismiss}>
              {s.cancel}
            </Button>
            <Button
              aria-busy={cloning || undefined}
              disabled={locked}
              startIcon={
                cloning ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
              variant="primary"
              type="submit"
            >
              {s.cloneRepository}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
