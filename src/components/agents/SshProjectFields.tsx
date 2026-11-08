import {
  ArrowLeft,
  Folder,
  FolderOpen,
  FolderUp,
  KeyRound,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  browseAgentSsh,
  pickAgentSshIdentity,
  scanAgentSshHost,
} from "../../data/agentSessionsApi";
import {
  agentEnvironmentLabel,
  agentProjectNameFromPath,
  type AgentProject,
  type SshBrowseResult,
  type SshConnection,
  type SshHostKey,
} from "../../domain/agentSessions";
import { errorMessage } from "../../domain/errors";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useAgentStrings } from "./agentStrings";
import { formatOperationError } from "./operationError";
import { useScopedNotification } from "../../notifications";

export const emptySshConnection = (): SshConnection => ({
  host: "",
  user: null,
  port: null,
  identityFile: null,
  hostKey: null,
});

export function normalizedConnection(connection: SshConnection): SshConnection {
  return {
    ...connection,
    host: connection.host.trim(),
    user: connection.user?.trim() || null,
    identityFile: connection.identityFile?.trim() || null,
  };
}

export function isValidSshPort(port: number | null) {
  return (
    port === null || (Number.isInteger(port) && port >= 1 && port <= 65535)
  );
}

function connectionKey(connection: SshConnection) {
  const normalized = normalizedConnection(connection);
  return JSON.stringify([
    normalized.host,
    normalized.user,
    normalized.port,
    normalized.identityFile,
    normalized.hostKey,
  ]);
}

function isPublicKeyFile(path: string | null) {
  return /\.pub\s*$/i.test(path ?? "");
}

function isChangedHostError(message: string) {
  return /remote host identification has changed|host key (?:has )?changed|host key mismatch|host key.*revoked|revoked.*host key/i.test(
    message,
  );
}

function isUnknownHostError(message: string) {
  if (isChangedHostError(message)) return false;
  return /(?:^|\r?\n)No (?:RSA|ECDSA|ED25519) host key is known for [^\r\n]+ and you have requested strict checking\.(?:\r?\n|$)/.test(
    message,
  );
}

type TrustPrompt = {
  connection: SshConnection;
  keys: SshHostKey[];
  resumeBrowse: boolean;
  resumePath: string | null;
  snapshot: string;
};

type SshOperation = "browse" | "scan" | "identity";

function SshCheckboxRow({
  checked,
  selected,
  ariaLabel,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  selected?: boolean;
  ariaLabel?: string;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className="agent-ssh-checkbox-row"
      data-selected={selected || undefined}
    >
      <span>{children}</span>
      <Checkbox
        aria-label={ariaLabel}
        checked={checked}
        onCheckedChange={onCheckedChange}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
    </label>
  );
}

export function SshProjectFields({
  id,
  connection,
  path,
  projects = [],
  disabled,
  targetLocked = false,
  allowMultiple = false,
  selectedProjectCount = 0,
  interactionLockRef,
  onBusyChange,
  onConnectionChange,
  onPathChange,
  onSelectionChange,
}: {
  id: string;
  connection: SshConnection;
  path: string;
  projects?: AgentProject[];
  disabled: boolean;
  targetLocked?: boolean;
  allowMultiple?: boolean;
  selectedProjectCount?: number;
  interactionLockRef: MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
  onConnectionChange: (connection: SshConnection) => void;
  onPathChange: (path: string) => void;
  onSelectionChange?: (selection: {
    paths: string[];
    groupName: string | null;
  }) => void;
}) {
  const s = useAgentStrings();
  const [operation, setOperation] = useState<SshOperation | null>(null);
  const notice = useScopedNotification("agent-ssh-fields");
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt | null>(null);
  const trustPromptRef = useRef(trustPrompt);
  trustPromptRef.current = trustPrompt;
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);
  const [browser, setBrowser] = useState<SshBrowseResult | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [groupProjects, setGroupProjects] = useState(false);
  const [groupName, setGroupName] = useState("");
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const mounted = useRef(false);
  const identityInput = useRef<HTMLInputElement>(null);
  const browseStartPath = useRef(path);
  const restoreIdentityFocus = useRef(false);
  const restoreBrowserFocus = useRef(false);
  const restoreTrustFocus = useRef<"browse" | "recheck" | null>(null);
  const renderedConnectionKey = connectionKey(connection);
  const identityIsPublic = isPublicKeyFile(connection.identityFile);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (operation !== null) return;
    if (restoreBrowserFocus.current && !browser) {
      restoreBrowserFocus.current = false;
      document.getElementById(`${id}-ssh-browse`)?.focus();
    } else if (restoreIdentityFocus.current) {
      restoreIdentityFocus.current = false;
      document.getElementById(`${id}-ssh-pick-identity`)?.focus();
    } else if (restoreTrustFocus.current && !trustPrompt) {
      document
        .getElementById(`${id}-ssh-${restoreTrustFocus.current}`)
        ?.focus();
      restoreTrustFocus.current = null;
    }
  }, [browser, id, operation, trustPrompt]);
  useEffect(() => {
    identityInput.current?.setCustomValidity(
      identityIsPublic ? s.sshPublicKeyInvalid : "",
    );
  }, [identityIsPublic, s.sshPublicKeyInvalid]);
  useEffect(() => {
    if (
      trustPromptRef.current &&
      trustPromptRef.current.snapshot !== renderedConnectionKey
    )
      updateTrustPrompt(null);
  }, [renderedConnectionKey]);
  useEffect(() => {
    if (trustPrompt) document.getElementById(`${id}-ssh-trust`)?.focus();
  }, [id, trustPrompt]);
  const sshProjects = useMemo(() => {
    const seen = new Set<string>();
    return projects.filter((project) => {
      const ssh =
        project.environment.kind === "ssh" ? project.environment.ssh : null;
      if (!ssh?.host) return false;
      const key = JSON.stringify(ssh);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [projects]);

  function updateTrustPrompt(next: TrustPrompt | null) {
    trustPromptRef.current = next;
    setTrustPrompt(next);
  }
  function applyChange(next: SshConnection, reset = false, unpin = false) {
    const value = unpin ? { ...next, hostKey: null } : next;
    connectionRef.current = value;
    updateTrustPrompt(null);
    setConnectionIssue(null);
    notice.clear();
    if (reset) setBrowser(null);
    onConnectionChange(value);
  }
  function change(next: SshConnection, reset = false, unpin = false) {
    if (interactionLockRef.current || disabled) return;
    applyChange(next, reset, unpin);
  }
  function changeTarget(next: SshConnection) {
    if (targetLocked || interactionLockRef.current || disabled) return;
    change(next, true, true);
    onPathChange("");
  }
  function begin(kind: SshOperation) {
    if (interactionLockRef.current || disabled) return false;
    interactionLockRef.current = true;
    setOperation(kind);
    onBusyChange(true);
    setConnectionIssue(null);
    notice.clear();
    return true;
  }
  function finish() {
    interactionLockRef.current = false;
    if (mounted.current) {
      setOperation(null);
      onBusyChange(false);
    }
  }
  function failureMessage(reason: unknown) {
    const message = errorMessage(reason);
    if (isChangedHostError(message)) return s.sshChangedHostError;
    if (message.includes("[SSH/keyRequiresAgent]"))
      return formatOperationError(s, { message });
    if (
      /permission denied|authentication failed|too many authentication failures|no supported authentication methods/i.test(
        message,
      )
    )
      return s.sshAuthError;
    if (/timed out|délai ssh dépassé/i.test(message)) return s.sshTimeoutError;
    if (/connection refused/i.test(message)) return s.sshRefusedError;
    if (
      /openssh indisponible|(?:ssh|openssh).*(?:not found|not recognized|no such file|cannot find|unavailable|failed to execute)|(?:not found|not recognized|no such file|cannot find).*(?:ssh|openssh)/i.test(
        message,
      )
    )
      return s.sshOpenSshMissing;
    return formatOperationError(s, { message });
  }
  function fail(reason: unknown, retry: () => void) {
    const message = failureMessage(reason);
    setConnectionIssue(message);
    notice.error(message, { label: s.retry, onAction: retry });
  }
  function validate() {
    if (!connectionRef.current.host.trim()) {
      notice.error(s.sshHostRequired);
      return false;
    }
    if (isPublicKeyFile(connectionRef.current.identityFile)) {
      setConnectionIssue(s.sshPublicKeyInvalid);
      notice.error(s.sshPublicKeyInvalid);
      return false;
    }
    if (!isValidSshPort(connectionRef.current.port)) {
      notice.error(s.sshPortInvalid);
      return false;
    }
    return true;
  }
  async function loadBrowser(
    request: SshConnection,
    nextPath: string | null,
    snapshot: string,
  ) {
    const result = await browseAgentSsh(request, nextPath);
    if (mounted.current && connectionKey(connectionRef.current) === snapshot) {
      setBrowser(result);
      onPathChange(result.path);
    }
  }
  async function discoverHost(
    request: SshConnection,
    snapshot: string,
    resumeBrowse: boolean,
    resumePath: string | null,
    retry: () => void,
  ) {
    try {
      const keys = await scanAgentSshHost({ ...request, hostKey: null });
      if (!mounted.current || connectionKey(connectionRef.current) !== snapshot)
        return;
      if (keys.length) {
        updateTrustPrompt({
          connection: request,
          keys,
          resumeBrowse,
          resumePath,
          snapshot,
        });
      } else {
        setConnectionIssue(s.sshNoHostKey);
        notice.error(s.sshNoHostKey, { label: s.retry, onAction: retry });
      }
    } catch (reason) {
      if (mounted.current && connectionKey(connectionRef.current) === snapshot)
        fail(reason, retry);
    }
  }
  async function browse(nextPath: string | null = path || null) {
    if (
      targetLocked ||
      trustPromptRef.current ||
      !validate() ||
      !begin("browse")
    )
      return;
    if (!browser) {
      browseStartPath.current = path;
      setMultiSelect(false);
      setSelectedPaths([]);
      setGroupProjects(false);
      setGroupName("");
    }
    const request = normalizedConnection(connectionRef.current);
    const snapshot = connectionKey(request);
    try {
      await loadBrowser(request, nextPath, snapshot);
    } catch (reason) {
      const message = errorMessage(reason);
      if (!mounted.current || connectionKey(connectionRef.current) !== snapshot)
        return;
      if (!request.hostKey && isUnknownHostError(message)) {
        setOperation("scan");
        await discoverHost(
          request,
          snapshot,
          true,
          nextPath,
          () => void browse(nextPath),
        );
      } else {
        fail(reason, () => void browse(nextPath));
      }
    } finally {
      finish();
    }
  }
  async function scan() {
    if (!validate() || !begin("scan")) return;
    const request = normalizedConnection(connectionRef.current);
    const snapshot = connectionKey(request);
    try {
      await discoverHost(request, snapshot, false, null, () => void scan());
    } finally {
      finish();
    }
  }
  async function confirmTrust(key: SshHostKey) {
    const prompt = trustPrompt;
    if (
      !prompt ||
      prompt.snapshot !== connectionKey(connectionRef.current) ||
      !begin(prompt.resumeBrowse ? "browse" : "scan")
    ) {
      if (prompt) updateTrustPrompt(null);
      return;
    }
    const trusted = { ...prompt.connection, hostKey: key.key };
    applyChange(trusted);
    if (!prompt.resumeBrowse) {
      finish();
      return;
    }
    const snapshot = connectionKey(trusted);
    try {
      await loadBrowser(trusted, prompt.resumePath, snapshot);
    } catch (reason) {
      if (mounted.current && connectionKey(connectionRef.current) === snapshot)
        fail(reason, () => void browse(prompt.resumePath));
    } finally {
      finish();
    }
  }
  function cancelTrust() {
    restoreTrustFocus.current = trustPrompt?.resumeBrowse
      ? "browse"
      : "recheck";
    updateTrustPrompt(null);
  }
  function closeBrowser(selected: boolean) {
    if (!selected) {
      onPathChange(browseStartPath.current);
    } else if (browser) {
      const paths =
        allowMultiple && multiSelect && selectedPaths.length
          ? selectedPaths
          : [browser.path];
      onPathChange(paths[0]);
      onSelectionChange?.({
        paths,
        groupName:
          multiSelect && groupProjects && selectedPaths.length
            ? groupName.trim()
            : null,
      });
    }
    restoreBrowserFocus.current = true;
    setBrowser(null);
  }
  async function pickIdentity() {
    if (!begin("identity")) return;
    try {
      const selected = await pickAgentSshIdentity();
      if (mounted.current && selected) {
        applyChange({ ...connectionRef.current, identityFile: selected }, true);
        if (isPublicKeyFile(selected)) {
          setConnectionIssue(s.sshPublicKeyInvalid);
          notice.error(s.sshPublicKeyInvalid);
        }
      }
    } catch (reason) {
      if (mounted.current) fail(reason, () => void pickIdentity());
    } finally {
      restoreIdentityFocus.current = true;
      finish();
    }
  }

  const selectedProject = sshProjects.find(
    (project) =>
      JSON.stringify(project.environment.ssh) === JSON.stringify(connection),
  );
  const connectionValue = selectedProject
    ? `project:${selectedProject.id}`
    : "new";
  let trustTarget = "";
  if (trustPrompt) {
    const { user, host, port } = trustPrompt.connection;
    trustTarget = host;
    if (user) trustTarget = `${user}@${trustTarget}`;
    if (port) trustTarget += `:${port}`;
  }
  const displayedIssue = identityIsPublic
    ? s.sshPublicKeyInvalid
    : connectionIssue;
  return (
    <section className="agent-ssh-fields" aria-label={s.sshConnection}>
      {sshProjects.length ? (
        <>
          <label htmlFor={`${id}-ssh-connection`}>{s.sshConnection}</label>
          <Select
            id={`${id}-ssh-connection`}
            value={connectionValue}
            disabled={disabled || targetLocked}
            options={[
              { value: "new", label: s.sshNewConnection },
              ...sshProjects.map((project) => ({
                value: `project:${project.id}`,
                label: `${project.name} · ${agentEnvironmentLabel(project.environment).replace("SSH · ", "")}`,
              })),
            ]}
            onValueChange={(value) => {
              if (interactionLockRef.current || disabled || targetLocked)
                return;
              const selected = sshProjects.find(
                (project) => value === `project:${project.id}`,
              )?.environment.ssh;
              change(selected ? { ...selected } : emptySshConnection(), true);
              onPathChange("");
            }}
          />
        </>
      ) : null}
      <label htmlFor={`${id}-ssh-host`}>{s.sshHost}</label>
      <Input
        id={`${id}-ssh-host`}
        required
        disabled={disabled || targetLocked}
        spellCheck={false}
        value={connection.host}
        onChange={(event) =>
          changeTarget({ ...connection, host: event.target.value })
        }
      />
      <div className="agent-ssh-pair">
        <div>
          <label htmlFor={`${id}-ssh-user`}>{s.sshUser}</label>
          <Input
            id={`${id}-ssh-user`}
            disabled={disabled || targetLocked}
            spellCheck={false}
            value={connection.user ?? ""}
            onChange={(event) =>
              changeTarget({
                ...connection,
                user: event.target.value || null,
              })
            }
          />
        </div>
        <div>
          <label htmlFor={`${id}-ssh-port`}>{s.sshPort}</label>
          <Input
            id={`${id}-ssh-port`}
            disabled={disabled || targetLocked}
            type="number"
            min={1}
            max={65535}
            placeholder="22"
            value={connection.port ?? ""}
            onChange={(event) =>
              changeTarget({
                ...connection,
                port: event.target.value ? Number(event.target.value) : null,
              })
            }
          />
        </div>
      </div>
      <label htmlFor={`${id}-ssh-identity`}>{s.sshIdentity}</label>
      <div className="agent-folder-row">
        <Input
          ref={identityInput}
          id={`${id}-ssh-identity`}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={identityIsPublic || undefined}
          aria-describedby={`${id}-ssh-identity-hint`}
          value={connection.identityFile ?? ""}
          onInvalid={() => notice.error(s.sshPublicKeyInvalid)}
          onChange={(event) =>
            change(
              { ...connection, identityFile: event.target.value || null },
              true,
            )
          }
        />
        <Button
          id={`${id}-ssh-pick-identity`}
          startIcon={<KeyRound />}
          disabled={disabled}
          onClick={() => void pickIdentity()}
        >
          {s.sshChooseIdentity}
        </Button>
      </div>
      <p className="agent-form-hint" id={`${id}-ssh-identity-hint`}>
        {s.sshIdentityHint}
      </p>
      {connection.hostKey ? (
        <div className="agent-ssh-actions">
          <strong className="agent-ssh-verified">{s.sshVerified}</strong>
          <Button
            id={`${id}-ssh-recheck`}
            startIcon={<KeyRound />}
            size="small"
            disabled={disabled || Boolean(trustPrompt)}
            onClick={() => void scan()}
          >
            {operation === "scan" ? s.sshScanning : s.sshRecheck}
          </Button>
        </div>
      ) : null}
      <div className="agent-ssh-actions">
        <Button
          id={`${id}-ssh-browse`}
          startIcon={<FolderOpen />}
          aria-busy={operation === "browse" || undefined}
          disabled={disabled || targetLocked || Boolean(trustPrompt)}
          onClick={() => void browse()}
        >
          {operation === "browse" ? s.sshBrowsing : s.chooseFolder}
        </Button>
        {selectedProjectCount > 1 && !browser ? (
          <span className="agent-folder-path">
            {s.groupProjectCount(selectedProjectCount)}
          </span>
        ) : path && !browser ? (
          <code className="agent-folder-path" title={path}>
            {path}
          </code>
        ) : null}
      </div>
      {operation === "scan" ? (
        <p className="agent-form-hint" role="status" aria-live="polite">
          {s.sshCheckingTrust}
        </p>
      ) : null}
      {displayedIssue ? (
        <p className="agent-ssh-guidance" role="alert">
          {displayedIssue}
        </p>
      ) : null}
      {browser ? (
        <>
          <div className="agent-ssh-browser" aria-label={s.sshCurrentFolder}>
            <div className="agent-ssh-browser-header">
              <IconButton
                className="agent-ssh-browser-back"
                size="medium"
                aria-label={s.back}
                title={s.back}
                onClick={() => closeBrowser(false)}
              >
                <ArrowLeft aria-hidden="true" />
              </IconButton>
              <code>{browser.path}</code>
            </div>
            {browser.parentPath ? (
              <Button
                size="small"
                startIcon={<FolderUp />}
                onClick={() => void browse(browser.parentPath!)}
              >
                {s.sshParentFolder}
              </Button>
            ) : null}
            <ul>
              {allowMultiple ? (
                <li>
                  <SshCheckboxRow
                    checked={multiSelect}
                    onCheckedChange={(checked) => {
                      setMultiSelect(checked);
                      if (!checked) {
                        setSelectedPaths([]);
                        setGroupProjects(false);
                        setGroupName("");
                      }
                    }}
                  >
                    {s.sshMultipleSelection}
                  </SshCheckboxRow>
                </li>
              ) : null}
              {browser.directories.map((directory) => (
                <li key={directory.path}>
                  {allowMultiple && multiSelect ? (
                    <SshCheckboxRow
                      ariaLabel={s.sshSelectProject(directory.name)}
                      checked={selectedPaths.includes(directory.path)}
                      selected={selectedPaths.includes(directory.path)}
                      onCheckedChange={(checked) =>
                        setSelectedPaths((current) =>
                          checked
                            ? [...current, directory.path]
                            : current.filter((path) => path !== directory.path),
                        )
                      }
                    >
                      <Folder size={14} aria-hidden="true" />
                      {directory.name}
                    </SshCheckboxRow>
                  ) : (
                    <button
                      className="agent-ssh-folder-button"
                      type="button"
                      onClick={() => void browse(directory.path)}
                    >
                      <Folder size={14} aria-hidden="true" />
                      {directory.name}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="agent-ssh-browser-actions">
            {allowMultiple && multiSelect && selectedPaths.length ? (
              <div className="agent-ssh-group-option">
                <label className="agent-ssh-group-toggle">
                  <Checkbox
                    checked={groupProjects}
                    onCheckedChange={(checked) => {
                      setGroupProjects(checked);
                      if (checked && !groupName)
                        setGroupName(agentProjectNameFromPath(browser.path));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.preventDefault();
                    }}
                  />
                  <span>{s.sshGroupProjects}</span>
                </label>
                {groupProjects ? (
                  <label
                    className="agent-ssh-group-name"
                    htmlFor={`${id}-ssh-group-name`}
                  >
                    <span>{s.groupName}</span>
                    <Input
                      id={`${id}-ssh-group-name`}
                      maxLength={100}
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
            <Button
              variant="primary"
              disabled={
                groupProjects &&
                (!groupName.trim() || groupName.trim().length > 100)
              }
              onClick={() => closeBrowser(true)}
            >
              {allowMultiple && multiSelect && selectedPaths.length
                ? s.sshSelectProjects(selectedPaths.length)
                : s.sshSelectFolder}
            </Button>
          </div>
        </>
      ) : null}
      {trustPrompt ? (
        <div
          className="agent-ssh-keys"
          role="alert"
          aria-labelledby={`${id}-ssh-trust-title`}
        >
          <h3 id={`${id}-ssh-trust-title`}>{s.sshTrustTitle}</h3>
          <strong>{s.sshTrustTarget(trustTarget)}</strong>
          <p>{s.sshTrustWarning}</p>
          {trustPrompt.keys.map((key, index) => (
            <div className="agent-ssh-key" key={key.key}>
              <code>{key.fingerprint}</code>
              <div className="agent-ssh-actions">
                <Button
                  id={index === 0 ? `${id}-ssh-trust` : undefined}
                  variant="primary"
                  disabled={disabled}
                  aria-label={`${trustPrompt.resumeBrowse ? s.sshTrustAndContinue : s.sshTrustKey} · ${key.fingerprint}`}
                  onClick={() => void confirmTrust(key)}
                >
                  {trustPrompt.resumeBrowse
                    ? s.sshTrustAndContinue
                    : s.sshTrustKey}
                </Button>
                {index === trustPrompt.keys.length - 1 ? (
                  <Button disabled={disabled} onClick={cancelTrust}>
                    {s.cancel}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
