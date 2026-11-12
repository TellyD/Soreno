// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  runtime,
  container,
  gitPanelContainer,
  statusBarContainer,
  root,
  data,
  guard,
  project,
  cacheWorktrees,
  session,
  setStatus,
  render,
  button,
  action,
  context,
  click,
  dialog,
  input,
  addProject,
  projectNames,
  sshStatusHost,
  mobileStatus,
  enableProjectServices,
  setGitPanelContainer,
  toggleServices,
  type AgentProjectWorktreeGroup,
  type WorkspaceData,
  retryFromNotification,
  requestAutomations,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as gitApi from "../../data/projectGitApi";
import * as automationsApi from "../../data/automationsApi";
import { getNotifications } from "../../notifications";

vi.mock("../../data/automationsApi", () => ({
  loadAgentAutomations: vi.fn(),
  saveAgentAutomation: vi.fn(),
  deleteAgentAutomation: vi.fn(),
  runAgentAutomation: vi.fn(),
  refreshAgentAutomations: vi.fn(),
  markAgentAutomationSeen: vi.fn(),
}));

vi.mock("../../domain/agentSessions", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../domain/agentSessions",
  )),
  MOBILE_ACCESS_PAUSED: false,
}));

const operationFailed = expect.objectContaining({
  message: "L’opération a échoué. Réessayez.",
  tone: "error",
});
const remoteStopFailed = () =>
  new Error(
    "[SSH/remoteStopFailed]\nImpossible d’arrêter la session sur le serveur SSH : ssh: connect to host remote.example port 2222: Connection timed out",
  );
const remoteStopNotification = expect.objectContaining({
  message: expect.stringContaining("peut-être injoignable"),
  tone: "error",
  action: expect.objectContaining({ label: "Déconnecter et supprimer" }),
});

it("closes a tab of an unreachable SSH server by disconnecting its project", async () => {
  sshStatusHost();
  setStatus("s1", "idle");
  vi.mocked(api.deleteAgentSession).mockRejectedValueOnce(remoteStopFailed());
  await render();

  await click("Fermer l’onglet · Pi notes");
  expect(getNotifications()).toEqual([remoteStopNotification]);
  expect(button("Pi notes")).not.toBeNull();
  expect(api.setAgentProjectConnected).not.toHaveBeenCalled();

  await act(async () => getNotifications()[0].action!.onAction());
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    false,
  );
  expect(api.deleteAgentSession).toHaveBeenCalledTimes(2);
  expect(api.deleteAgentSession).toHaveBeenLastCalledWith("s1");
  expect(getNotifications()).toEqual([]);
  expect(container.textContent).not.toContain("Pi notes");
});

it("turns a failed deletion confirmation into disconnect and delete", async () => {
  sshStatusHost();
  setStatus("s1", "idle");
  vi.mocked(api.deleteAgentSession).mockRejectedValueOnce(remoteStopFailed());
  await render();

  await action("Pi notes", "Supprimer la session");
  await click("Supprimer la session", dialog());
  expect(dialog().textContent).toContain("peut-être injoignable");
  expect(dialog().textContent).not.toContain("Connection timed out");
  await click("Déconnecter et supprimer", dialog());

  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    false,
  );
  expect(api.deleteAgentSession).toHaveBeenCalledTimes(2);
  expect(dialog()).toBeNull();
  expect(getNotifications()).toEqual([]);
  expect(container.textContent).not.toContain("Pi notes");
});

it("deletes a group of an unreachable SSH server by disconnecting its group project", async () => {
  sshStatusHost();
  data.projects.push({
    ...data.projects[0],
    id: "group-g1",
    name: "Suite",
    path: "/home/dev/.soreno/groups/g1",
  });
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1"], groupProjectId: "group-g1" },
  ];
  vi.mocked(api.deleteAgentProjectGroup).mockRejectedValueOnce(
    remoteStopFailed(),
  );
  await render();

  await click(
    "Supprimer le groupe",
    await context("Replier le groupe · Suite", true),
  );
  await click("Supprimer le groupe", dialog());
  expect(dialog().textContent).toContain("peut-être injoignable");
  await click("Déconnecter et supprimer", dialog());

  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "group-g1",
    false,
  );
  await vi.waitFor(() =>
    expect(api.deleteAgentProjectGroup).toHaveBeenCalledTimes(2),
  );
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(data.groups).toEqual([]);
});

it("guards the selected project sharing the SSH connection before disconnecting", async () => {
  sshStatusHost();
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  data.projects.push({
    ...data.projects[0],
    id: "p2",
    name: "Shared remote",
    path: "/projects/shared",
  });
  setStatus("s1", "idle");
  vi.mocked(api.deleteAgentSession).mockRejectedValueOnce(remoteStopFailed());
  await render(false, null, gitPanelContainer);

  await click("Fermer l’onglet · Pi notes");
  expect(getNotifications()).toEqual([remoteStopNotification]);
  await click("Shared remote");
  expect(button("Shared remote").getAttribute("aria-current")).toBe("page");
  runtime.projectNavigationPrepare.mockClear();
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);

  await act(async () => getNotifications()[0].action!.onAction());
  expect(runtime.projectNavigationPrepare).toHaveBeenCalledTimes(1);
  expect(api.setAgentProjectConnected).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).toHaveBeenCalledTimes(1);
});

it("reports SSH session activity in the compact project status without a health probe", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  await render();
  const status = () => host.querySelector<HTMLElement>('[role="status"]')!;
  expect(status().title).toContain("1 session active");
  expect(api.startAgentSession).not.toHaveBeenCalled();

  setStatus("s1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("À la demande");

  data.statuses = [
    { sessionId: "s1", state: "exited", exitCode: 255 },
    { sessionId: "s2", state: "running", exitCode: null },
  ];
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("1 session active");
  setStatus("s2", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("Session en erreur");

  vi.mocked(api.listAgentStatuses).mockRejectedValueOnce(
    new Error("Status unavailable"),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("État indisponible");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("Session en erreur");

  data.statuses = [{ sessionId: "s1", state: "running", exitCode: null }];
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(status().title).toContain("État indisponible");
});

it("names running SSH sessions on the server once their name settles", async () => {
  vi.useFakeTimers();
  sshStatusHost();
  vi.mocked(api.setAgentRemoteLabel).mockRejectedValueOnce(
    new Error("ssh: connect to host remote.example port 2222"),
  );
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(1);
  expect(api.setAgentRemoteLabel).toHaveBeenCalledWith(
    "s1",
    "Soreno · Pi notes",
  );
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(1);
  expect(getNotifications()).toEqual([]);

  vi.mocked(api.setAgentRemoteLabel).mockClear();
  await act(async () => runtime.titles.get("s1")!("π - Revue"));
  await act(async () => runtime.titles.get("s1")!("π - Revue des tests"));
  await act(async () => vi.advanceTimersByTimeAsync(1900));
  expect(api.setAgentRemoteLabel).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(1);
  expect(api.setAgentRemoteLabel).toHaveBeenCalledWith(
    "s1",
    "Soreno · Revue des tests",
  );
});

it("never reaches a disconnected SSH project to name its sessions", async () => {
  vi.useFakeTimers();
  sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.setAgentRemoteLabel).not.toHaveBeenCalled();
});

it("sends a renamed SSH session label only after the previous push finishes", async () => {
  vi.useFakeTimers();
  sshStatusHost();
  let finishFirst!: () => void;
  vi.mocked(api.setAgentRemoteLabel).mockImplementationOnce(
    () => new Promise<void>((resolve) => (finishFirst = resolve)),
  );
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(1);

  await act(async () => runtime.titles.get("s1")!("π - Revue"));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(1);

  await act(async () => finishFirst());
  expect(api.setAgentRemoteLabel).toHaveBeenCalledTimes(2);
  expect(api.setAgentRemoteLabel).toHaveBeenLastCalledWith(
    "s1",
    "Soreno · Revue",
  );
});

it("blocks native close while starting SSH port forwarding", async () => {
  const host = sshStatusHost();
  let finishStart!: () => void;
  let pendingAtIpcStart = false;
  vi.mocked(api.startAgentSshPortForward).mockImplementationOnce(() => {
    pendingAtIpcStart = guard.hasPendingWork();
    return new Promise((resolve) => {
      finishStart = () => resolve({ forwards: [], ignoredPorts: [] });
    });
  });
  await render();
  await vi.waitFor(() =>
    expect(api.listAgentSshPortForwards).toHaveBeenCalledWith("p1"),
  );
  await click("Ports", host);
  await input("Ports distants", "2928");
  await click("Démarrer les redirections", dialog());

  expect(pendingAtIpcStart).toBe(true);
  expect(guard.hasPendingWork()).toBe(true);
  expect(await guard.prepare()).toBe(false);

  await act(async () => finishStart());
  expect(guard.hasPendingWork()).toBe(false);
  await act(async () => expect(await guard.prepare()).toBe(true));
});

it("starts and stops SSH port ranges from the status bar", async () => {
  const host = sshStatusHost();
  vi.mocked(api.startAgentSshPortForward).mockResolvedValueOnce({
    forwards: [
      { remotePort: 2928, localPort: 2928 },
      { remotePort: 8088, localPort: 49152 },
    ],
    ignoredPorts: ["nope"],
  });
  await render();
  await vi.waitFor(() =>
    expect(api.listAgentSshPortForwards).toHaveBeenCalledWith("p1"),
  );

  await click("Ports", host);
  await input("Ports distants", "2928 8088:8089 nope");
  await click("Démarrer les redirections", dialog());

  expect(api.startAgentSshPortForward).toHaveBeenCalledWith(
    "p1",
    "2928 8088:8089 nope",
  );
  expect(button("Ports · 2", host)).not.toBeNull();
  expect(dialog().textContent).toContain("2928→http://localhost:2928");
  expect(dialog().textContent).toContain("8088→http://localhost:49152");
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Port ignoré : nope.",
      tone: "warning",
    }),
  );

  await click("Tout arrêter", dialog());
  expect(api.stopAgentSshPortForward).toHaveBeenCalledWith("p1");
  expect(button("Ports", host)).not.toBeNull();
  expect(dialog().textContent).toContain("Aucune redirection de port active");
});

const activeStatus = mobileStatus({
  installed: true,
  upToDate: true,
  active: true,
  connected: true,
  stateFresh: true,
  host: "devbox",
  server: "c2VydmVyLXB1YmxpYy1rZXk",
});
const iphone = {
  id: "a1b2c3d4e5f60718",
  label: "iPhone · Safari",
  pairedAt: Date.UTC(2026, 9, 1, 8, 30),
  lastSeenAt: Date.UTC(2026, 9, 7, 18, 5),
};
const pixel = {
  id: "0f1e2d3c4b5a6978",
  label: "Android · Chrome",
  pairedAt: Date.UTC(2026, 9, 2, 9, 0),
  lastSeenAt: null,
};
const pairingSecret = "Zm9vYmFyLXNlY3JldC1wYWlyaW5nLXRva2VuLXZhbHVl";
const pairing = (expiresAt = Date.now() + 600_000) => ({
  id: "0123456789abcdef",
  url: `https://192.0.2.10/#p=${activeStatus.server}.${pairingSecret}`,
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>',
  expiresAt,
});
const alertDialog = () =>
  document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const pairingQr = () =>
  dialog().querySelector<HTMLImageElement>('img[alt="QR code d’appairage"]');
const deviceLabels = () =>
  [...dialog().querySelectorAll(".ssh-mobile-device strong")].map(
    (item) => item.textContent,
  );
const connectionStatus = () =>
  dialog().querySelector(".ssh-mobile-connection")?.textContent;

it("enables mobile access, then shows a pairing QR code without its secret", async () => {
  const host = sshStatusHost();
  const qr = pairing();
  vi.mocked(api.enableAgentSshMobile).mockResolvedValueOnce(activeStatus);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValueOnce(qr);
  await render();

  await click("Mobile", host);
  await vi.waitFor(() => button("Activer", dialog()));
  expect(api.loadAgentSshMobileStatus).toHaveBeenCalledWith("p1");

  await click("Activer", dialog());
  await vi.waitFor(() => expect(pairingQr()).not.toBeNull());
  expect(api.enableAgentSshMobile).toHaveBeenCalledWith("p1");
  expect(api.pairAgentSshMobile).toHaveBeenCalledWith("p1");
  expect(pairingQr()!.src).toBe(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.qrSvg)}`,
  );
  expect(dialog().innerHTML).not.toContain(pairingSecret);
  expect(dialog().innerHTML).not.toContain("#p=");
  expect(connectionStatus()).toBe("Connecté");
  expect(button("Nouveau QR code", dialog())).not.toBeNull();
});

it("hides the QR code once a phone uses it", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  const qr = pairing();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(activeStatus);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValueOnce(qr);
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(pairingQr()).toBeNull();
  await click("Appairer un téléphone", dialog());
  expect(api.pairAgentSshMobile).toHaveBeenCalledWith("p1");
  expect(pairingQr()).not.toBeNull();

  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    devices: [iphone],
    pairingsUsed: [qr.id],
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(pairingQr()).toBeNull();
  expect(dialog().textContent).toContain("Téléphone appairé.");
  expect(deviceLabels()).toEqual(["iPhone · Safari"]);
  expect(button("Appairer un téléphone", dialog())).not.toBeNull();
});

it("treats a QR code evicted by newer ones as expired, not as paired", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  const qr = pairing();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(activeStatus);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValueOnce(qr);
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  await click("Appairer un téléphone", dialog());
  expect(pairingQr()).not.toBeNull();

  // Eight codes made elsewhere pushed this one out; no phone used it.
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    pairings: ["1111111111111111"],
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(pairingQr()).toBeNull();
  expect(dialog().textContent).toContain("QR code expiré.");
  expect(dialog().textContent).not.toContain("Téléphone appairé.");
  expect(button("Appairer un téléphone", dialog())).not.toBeNull();
});

it("hides the QR code when it expires", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  const qr = pairing();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(activeStatus);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValueOnce(qr);
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    pairings: [qr.id],
  });
  await click("Appairer un téléphone", dialog());
  await act(async () =>
    vi.advanceTimersByTimeAsync(qr.expiresAt - Date.now() - 1),
  );
  expect(pairingQr()).not.toBeNull();

  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(pairingQr()).toBeNull();
  expect(dialog().textContent).toContain("QR code expiré.");
  expect(dialog().textContent).not.toContain("Téléphone appairé.");
  await click("Appairer un téléphone", dialog());
  expect(api.pairAgentSshMobile).toHaveBeenCalledTimes(2);
});

it("keeps the QR code and the last device list while the authorizations cannot be read", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  const qr = pairing();
  const unreadable = {
    ...activeStatus,
    devices: null,
    pairings: null,
    pairingsUsed: null,
  };
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(unreadable);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValueOnce(qr);
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(dialog().textContent).toContain(
    "Les appareils appairés sont illisibles pour l’instant ; Soreno réessaie.",
  );
  expect(dialog().textContent).not.toContain(
    "Aucun téléphone appairé pour l’instant.",
  );
  await click("Appairer un téléphone", dialog());
  expect(pairingQr()).not.toBeNull();

  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    devices: [iphone],
    pairings: [qr.id],
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(deviceLabels()).toEqual(["iPhone · Safari"]);
  expect(pairingQr()).not.toBeNull();

  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(unreadable);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.loadAgentSshMobileStatus).toHaveBeenCalledTimes(3);
  expect(pairingQr()).not.toBeNull();
  expect(dialog().textContent).not.toContain("Téléphone appairé.");
  expect(deviceLabels()).toEqual(["iPhone · Safari"]);
});

it("revokes a paired device and shows the returned list", async () => {
  const host = sshStatusHost();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValueOnce({
    ...activeStatus,
    devices: [iphone, pixel],
  });
  vi.mocked(api.revokeAgentSshMobile).mockResolvedValueOnce({
    ...activeStatus,
    devices: [pixel],
  });
  await render();

  await click("Mobile", host);
  await vi.waitFor(() =>
    expect(deviceLabels()).toEqual(["iPhone · Safari", "Android · Chrome"]),
  );
  const items = dialog().querySelectorAll(".ssh-mobile-devices li");

  await click("Révoquer", items[0]);
  expect(api.revokeAgentSshMobile).toHaveBeenCalledWith("p1", iphone.id);
  expect(deviceLabels()).toEqual(["Android · Chrome"]);
});

it("updates a legacy Tailscale installation, then pairs again", async () => {
  const host = sshStatusHost();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValueOnce(
    mobileStatus({ installed: true, legacy: true, active: true }),
  );
  vi.mocked(api.enableAgentSshMobile).mockResolvedValueOnce(activeStatus);
  await render();

  await click("Mobile", host);
  await vi.waitFor(() => button("Mettre à jour", dialog()));
  expect(button("Désactiver", dialog())).not.toBeNull();

  await click("Mettre à jour", dialog());
  expect(api.enableAgentSshMobile).toHaveBeenCalledWith("p1");
  await vi.waitFor(() => expect(pairingQr()).not.toBeNull());
  expect(api.pairAgentSshMobile).toHaveBeenCalledWith("p1");
});

it("pairs after enabling even when the relay is not reached yet", async () => {
  const host = sshStatusHost();
  vi.mocked(api.enableAgentSshMobile).mockRejectedValueOnce(
    new Error("[Mobile/relay] soreno-remote ne joint pas le relais."),
  );
  await render();

  await click("Mobile", host);
  await vi.waitFor(() => button("Activer", dialog()));
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValueOnce({
    ...activeStatus,
    connected: false,
  });
  await click("Activer", dialog());
  await vi.waitFor(() => expect(pairingQr()).not.toBeNull());
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "L’accès mobile est activé, mais le serveur ne joint pas encore le relais Soreno : vérifiez qu’il peut se connecter en sortie sur le port TCP 8790. Le service réessaie tout seul.",
  );
});

it("shows an unreachable relay, then the connection once restored", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    connected: false,
  });
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(dialog().querySelector(".ssh-mobile-warning")?.textContent).toContain(
    "Relais injoignable",
  );

  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue({
    ...activeStatus,
    connected: false,
    stateFresh: false,
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(dialog().querySelector(".ssh-mobile-warning")).toBeNull();
  expect(connectionStatus()).toBe("En attente…");

  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(activeStatus);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(connectionStatus()).toBe("Connecté");
  expect(api.loadAgentSshMobileStatus).toHaveBeenCalledTimes(3);
});

it("asks for confirmation before disabling mobile access", async () => {
  const host = sshStatusHost();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValueOnce({
    ...activeStatus,
    devices: [iphone],
  });
  await render();

  await click("Mobile", host);
  await vi.waitFor(() => button("Désactiver", dialog()));
  await click("Désactiver", dialog());
  expect(api.disableAgentSshMobile).not.toHaveBeenCalled();
  await click("Désactiver", alertDialog());
  expect(api.disableAgentSshMobile).toHaveBeenCalledWith("p1");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(button("Activer", dialog())).not.toBeNull();
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
});

it("shows the last failed mobile status read until a later read succeeds, beside an action error", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  const offline = new Error("[Mobile/busy] démarrage en cours.");
  const offlineText =
    "Un autre démarrage de soreno-remote est en cours sur le serveur : réessayez dans un instant.";
  const revokeText = "Impossible de révoquer cet appareil sur le serveur.";
  const alerts = () =>
    [...dialog().querySelectorAll('[role="alert"]')].map(
      (alert) => alert.textContent,
    );
  vi.mocked(api.loadAgentSshMobileStatus)
    .mockRejectedValueOnce(offline)
    .mockResolvedValue({ ...activeStatus, devices: [iphone] });
  vi.mocked(api.revokeAgentSshMobile).mockRejectedValueOnce(
    new Error("[Mobile/revoke] soreno-remote revoke a échoué."),
  );
  await render();

  await click("Mobile", host);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(alerts()).toEqual([offlineText]);

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(alerts()).toEqual([]);
  expect(connectionStatus()).toBe("Connecté");

  vi.mocked(api.loadAgentSshMobileStatus).mockRejectedValueOnce(offline);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(alerts()).toEqual([offlineText]);

  await click("Révoquer", dialog());
  expect(alerts()).toEqual([revokeText]);

  vi.mocked(api.loadAgentSshMobileStatus).mockRejectedValueOnce(offline);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(alerts()).toEqual([offlineText, revokeText]);

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(alerts()).toEqual([revokeText]);
});

it("explains a failed activation and offers to update what was installed", async () => {
  const host = sshStatusHost();
  vi.mocked(api.enableAgentSshMobile).mockRejectedValueOnce(
    new Error("[Mobile/linger] loginctl enable-linger a échoué."),
  );
  await render();

  await click("Mobile", host);
  await vi.waitFor(() => button("Activer", dialog()));
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValueOnce(
    mobileStatus({ installed: true, upToDate: true }),
  );
  await click("Activer", dialog());

  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "Impossible de maintenir le service après déconnexion : faites lancer `sudo loginctl enable-linger $USER` sur le serveur par un administrateur.",
  );
  expect(dialog().textContent).toContain("Mise à jour nécessaire");
  expect(button("Désactiver", dialog())).not.toBeNull();
  expect(button("Mettre à jour", dialog())).not.toBeNull();
  expect(api.pairAgentSshMobile).not.toHaveBeenCalled();
});

it("counts active service sessions in the SSH project status", async () => {
  const host = sshStatusHost();
  data.sessions = [
    {
      id: "service-api",
      projectId: "p1",
      name: "API",
      kind: "service",
      serviceId: "api",
      workingDirectory: "/srv/api",
      executable: "npm",
      args: ["run", "api"],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  data.statuses = [
    { sessionId: "service-api", state: "running", exitCode: null },
  ];

  await render();

  expect(host.querySelector<HTMLElement>('[role="status"]')?.title).toContain(
    "1 session active",
  );
  expect(button("Services 1/1", host).getAttribute("aria-pressed")).toBe(
    "false",
  );
});

it("scopes the footer SSH address to the visible selected project and clears its portal on unmount", async () => {
  const host = sshStatusHost();
  data.projects.push(
    {
      ...data.projects[0],
      id: "p2",
      name: "Remote two",
      environment: {
        ...data.projects[0].environment,
        ssh: { ...data.projects[0].environment.ssh!, host: "other.example" },
      },
    },
    { ...project, id: "local", name: "Local repo" },
    {
      ...project,
      id: "wsl",
      name: "WSL repo",
      environment: { kind: "wsl", distribution: "Ubuntu" },
    },
  );
  await render();
  await render(true);
  expect(host.childElementCount).toBe(0);
  await render();
  await click("Remote two");
  expect(host.textContent).toContain("SSH · Remote two");
  expect(host.textContent).not.toContain("other.example");
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("other.example");
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("À la demande");
  await click("Local repo");
  expect(host.childElementCount).toBe(0);
  await click("WSL repo");
  expect(host.childElementCount).toBe(0);
  await click("Soreno");
  expect(host.textContent).toContain("SSH · Soreno");
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("remote.example");
  await act(async () => root.render(null));
  expect(host.childElementCount).toBe(0);
});

it("shows SSH starting and launch failure without claiming a connected server", async () => {
  const host = sshStatusHost();
  setStatus("s1", "idle");
  let failStart!: (error: Error) => void;
  vi.mocked(api.startAgentSession).mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        failStart = reject;
      }),
  );
  await render();
  await click("Codex tests");
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("Démarrage");
  await act(async () => failStart(new Error("SSH launch failed")));
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("Session en erreur");
  await retryFromNotification();
  expect(
    host.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("1 session active");
  expect(host.textContent).not.toMatch(/connecté|connected/i);
});

it("keeps the connecting spinner through reload and reserves rapid clicks", async () => {
  const host = sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  await render();
  let finishReload!: () => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishReload = () => resolve(structuredClone(data));
      }),
  );

  const connect = button("Connecter · Soreno", host);
  await act(async () => {
    connect.click();
    connect.click();
  });

  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    true,
  );
  const pending = button("Connexion…", host);
  expect(pending.disabled).toBe(true);

  await act(async () => finishReload());
  expect(button("Déconnecter · Soreno", host).disabled).toBe(false);
});

it("clears the connecting spinner after failure", async () => {
  const host = sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  let failConnect!: () => void;
  vi.mocked(api.setAgentProjectConnected).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failConnect = () => reject(new Error("SSH reconnect failed"));
      }),
  );
  await render();

  await click("Connecter · Soreno", host);
  expect(button("Connexion…", host).disabled).toBe(true);
  await act(async () => failConnect());

  expect(button("Connecter · Soreno", host).disabled).toBe(false);
  expect(host.querySelector(".app-loading-spinner")).toBeNull();
  expect(getNotifications()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("SSH reconnect failed");
});

it("reserves disconnection before its guard and disables cancellation", async () => {
  const host = sshStatusHost();
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  let finishGuard!: (allowed: boolean) => void;
  runtime.projectNavigationPrepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishGuard = resolve;
      }),
  );
  await render(false, null, gitPanelContainer);
  await click("Déconnecter · Soreno", host);
  const confirm = button("Déconnecter", dialog());

  await act(async () => {
    confirm.click();
    confirm.click();
  });

  expect(runtime.projectNavigationPrepare).toHaveBeenCalledTimes(1);
  expect(api.setAgentProjectConnected).not.toHaveBeenCalled();
  const pending = button("Déconnexion…", host);
  expect(pending.disabled).toBe(true);
  expect(
    dialog().querySelector<HTMLButtonElement>(".confirmation-dialog-close")
      ?.disabled,
  ).toBe(true);
  expect(button("Annuler", dialog()).disabled).toBe(true);
  await act(async () => button("Annuler", dialog()).click());
  expect(dialog()).not.toBeNull();

  await act(async () => finishGuard(false));
  expect(button("Déconnecter · Soreno", host).disabled).toBe(false);
  expect(button("Annuler", dialog()).disabled).toBe(false);
});

it("keeps the disconnecting spinner until IPC and reload finish", async () => {
  const host = sshStatusHost();
  let finishDisconnect!: () => void;
  vi.mocked(api.setAgentProjectConnected).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDisconnect = () => {
          data.disconnectedProjectIds = ["p1"];
          resolve();
        };
      }),
  );
  await render();
  await click("Déconnecter · Soreno", host);
  await click("Déconnecter", dialog());

  expect(button("Déconnexion…", host).disabled).toBe(true);
  await act(async () => finishDisconnect());
  expect(button("Connecter · Soreno", host).disabled).toBe(false);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("invalidates delayed project navigation when an SSH transition starts", async () => {
  const host = sshStatusHost();
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  data.disconnectedProjectIds = ["p1"];
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  let finishNavigation!: () => void;
  runtime.projectNavigationPrepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishNavigation = () => resolve(true);
      }),
  );
  let finishConnect!: () => void;
  vi.mocked(api.setAgentProjectConnected).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishConnect = () => {
          data.disconnectedProjectIds = [];
          resolve();
        };
      }),
  );
  await render(false, null, gitPanelContainer);

  await click("Other");
  await click("Connecter · Soreno", host);
  await act(async () => finishNavigation());

  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(button("Other").getAttribute("aria-current")).toBeNull();
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await act(async () => finishConnect());
});

it.each([
  ["disconnecting", false],
  ["reconnecting", true],
] as const)(
  "keeps known worktrees visible while %s an SSH project",
  async (_transition, initiallyDisconnected) => {
    const host = sshStatusHost();
    if (initiallyDisconnected) data.disconnectedProjectIds = ["p1"];
    const groups: AgentProjectWorktreeGroup[] = [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
        ],
      },
    ];
    cacheWorktrees(data, groups);
    vi.mocked(api.listAgentWorktrees)
      .mockResolvedValueOnce({ groups, complete: true, missingProjectIds: [] })
      .mockImplementation(() => new Promise(() => {}));

    await render();
    await vi.waitFor(() => expect(button("main")).not.toBeNull());
    if (initiallyDisconnected) await click("Connecter · Soreno", host);
    else {
      await click("Déconnecter · Soreno", host);
      await click("Déconnecter", dialog());
    }

    expect(button("main")).not.toBeNull();
    expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
      "p1",
      initiallyDisconnected,
    );
  },
);

it("confirms and disconnects every project sharing the SSH connection", async () => {
  const host = sshStatusHost();
  data.projects.push({
    ...data.projects[0],
    id: "p2",
    name: "Shared remote",
    path: "/projects/shared",
  });
  await render();
  await click("Déconnecter · Soreno", host);
  expect(dialog().textContent).toContain(
    "agents de tous les projets utilisant la même connexion SSH",
  );
  expect(dialog().textContent).toContain(
    "travail non enregistré peut être perdu",
  );
  await click("Annuler", dialog());
  expect(api.setAgentProjectConnected).not.toHaveBeenCalled();

  await click("Déconnecter · Soreno", host);
  await click("Déconnecter", dialog());
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    false,
  );
  expect(data.disconnectedProjectIds).toEqual(["p1", "p2"]);
  expect(button("Connecter · Soreno", host)).not.toBeNull();
  expect(
    host.querySelector('[role="status"]')?.getAttribute("data-state"),
  ).toBe("offline");
  await click("Shared remote");
  expect(button("Connecter · Shared remote", host)).not.toBeNull();
  expect(
    host.querySelector('[role="status"]')?.getAttribute("data-state"),
  ).toBe("offline");

  await click("Connecter · Shared remote", host);
  expect(api.setAgentProjectConnected).toHaveBeenLastCalledWith("p2", true);
  expect(data.disconnectedProjectIds).toEqual([]);
  await click("Soreno");
  expect(button("Déconnecter · Soreno", host)).not.toBeNull();
});

it("turns a persisted disconnect failure into an acknowledgement", async () => {
  const host = sshStatusHost();
  vi.mocked(api.setAgentProjectConnected).mockImplementationOnce(async () => {
    data.disconnectedProjectIds = ["p1"];
    throw new Error("Ona shutdown failed");
  });
  await render();
  await click("Déconnecter · Soreno", host);
  await click("Déconnecter", dialog());

  expect(getNotifications()).toEqual([operationFailed]);
  expect(dialog().textContent).not.toContain("Ona shutdown failed");
  const confirm = dialog().querySelector<HTMLButtonElement>(
    ".confirmation-dialog-confirm",
  )!;

  await act(async () => confirm.click());
  expect(api.setAgentProjectConnected).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(getNotifications()).toEqual([]);
});

it("keeps the disconnect confirmation open on error and retries the same project", async () => {
  const host = sshStatusHost();
  vi.mocked(api.setAgentProjectConnected).mockRejectedValueOnce(
    new Error("SSH disconnect failed"),
  );
  await render();
  await click("Déconnecter · Soreno", host);
  await click("Déconnecter", dialog());
  expect(getNotifications()).toEqual([operationFailed]);
  expect(dialog().textContent).not.toContain("SSH disconnect failed");
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    false,
  );
  await click("Déconnecter", dialog());
  expect(api.setAgentProjectConnected).toHaveBeenCalledTimes(2);
  expect(dialog()).toBeNull();
  expect(button("Connecter · Soreno", host)).not.toBeNull();
});

it("retries a failed reconnect for its original project without launching agents", async () => {
  const host = sshStatusHost();
  data.projects.push({ ...project, id: "p2", name: "Local repo" });
  data.disconnectedProjectIds = ["p1"];
  vi.mocked(api.setAgentProjectConnected).mockRejectedValueOnce(
    new Error("SSH reconnect failed"),
  );
  await render();

  await click("Connecter · Soreno", host);
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    true,
  );
  expect(
    host.querySelector('[role="status"]')?.getAttribute("data-state"),
  ).toBe("offline");
  expect(getNotifications()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("SSH reconnect failed");
  expect(api.startAgentSession).not.toHaveBeenCalled();

  await click("Local repo");
  expect(host.childElementCount).toBe(0);
  await retryFromNotification();
  expect(api.setAgentProjectConnected).toHaveBeenCalledTimes(2);
  expect(api.setAgentProjectConnected).toHaveBeenLastCalledWith("p1", true);
  expect(getNotifications()).toEqual([]);
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await click("Soreno");
  expect(button("Déconnecter · Soreno", host)).not.toBeNull();
});

it("does not retry a stale failed reconnect after a service failure", async () => {
  enableProjectServices();
  data.statuses[1] = { sessionId: "s2", state: "running", exitCode: null };
  data.disconnectedProjectIds = ["p1"];
  vi.mocked(api.setAgentProjectConnected).mockImplementationOnce(async () => {
    data.disconnectedProjectIds = [];
    throw new Error("SSH reconnect failed after persistence");
  });
  await render();

  await click("Connecter · Soreno", statusBarContainer);
  await toggleServices();
  await vi.waitFor(() =>
    expect(button("Arrêter API", container).disabled).toBe(false),
  );
  vi.mocked(api.stopAgentSession).mockRejectedValueOnce(
    new Error("service stop failed"),
  );
  await click("Arrêter API", container);
  await vi.waitFor(() =>
    expect(getNotifications()).toContainEqual(operationFailed),
  );
  expect(container.textContent).not.toContain("service stop failed");

  await click("Codex tests");
  const reloadCount = vi.mocked(api.loadAgentWorkspace).mock.calls.length;
  await retryFromNotification();
  await vi.waitFor(() =>
    expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(reloadCount + 1),
  );
  expect(api.setAgentProjectConnected).toHaveBeenCalledTimes(1);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("keeps offline session navigation passive, disables creation and reconnects without relaunching", async () => {
  const host = sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  setStatus("s1", "idle");
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  expect(
    host.querySelector('[role="status"]')?.getAttribute("data-state"),
  ).toBe("offline");
  expect(button("Nouvelle session · Soreno").disabled).toBe(true);
  expect(
    gitPanelContainer
      .querySelector(".agent-git-panel")
      ?.getAttribute("data-disconnected"),
  ).toBe("true");

  await click("Codex tests");
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  let finishWorktrees!: (
    groups: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWorktrees = resolve;
      }),
  );
  await click("Connecter · Soreno", host);
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    true,
  );
  expect(button("Déconnecter · Soreno", host)).not.toBeNull();
  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.textContent).not.toContain("Chargement des projets…");
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await act(async () =>
    finishWorktrees({ groups: [], complete: true, missingProjectIds: [] }),
  );

  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it("keeps a dormant SSH project passive until launching a session connects it", async () => {
  const host = sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  data.dormantProjectIds = ["p1"];
  setStatus("s1", "idle");
  vi.mocked(api.startAgentSession).mockImplementation(async (id) => {
    data.disconnectedProjectIds = [];
    data.dormantProjectIds = [];
    setStatus(id, "running");
  });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  const gitPanel = () => gitPanelContainer.querySelector(".agent-git-panel");
  const status = host.querySelector('[role="status"]');
  expect(status?.getAttribute("data-state")).toBe("dormant");
  expect(button("Connecter · Soreno", host)).not.toBeNull();
  expect(gitPanel()?.getAttribute("data-disconnected")).toBe("true");
  expect(button("Nouvelle session · Soreno").disabled).toBe(false);
  expect(api.startAgentSession).not.toHaveBeenCalled();

  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  await vi.waitFor(() =>
    expect(gitPanel()?.hasAttribute("data-disconnected")).toBe(false),
  );
  expect(button("Déconnecter · Soreno", host)).not.toBeNull();
});

it("connects a dormant SSH project before reading it for a quick worktree", async () => {
  sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  data.dormantProjectIds = ["p1"];
  await render();

  await click("Créer un worktree · Soreno");

  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(api.setAgentProjectConnected).toHaveBeenCalledExactlyOnceWith(
    "p1",
    true,
  );
  expect(
    vi.mocked(api.setAgentProjectConnected).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(gitApi.readGitRepository).mock.invocationCallOrder[0],
  );
});

it("does not let a disconnected SSH project affect local session launches", async () => {
  data.projects.push({
    ...project,
    id: "remote",
    name: "Remote",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "remote.example",
        user: null,
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  });
  data.disconnectedProjectIds = ["remote"];
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  expect(
    gitPanelContainer
      .querySelector(".agent-git-panel")
      ?.hasAttribute("data-disconnected"),
  ).toBe(false);
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it("attaches to the open automation session the server launched", async () => {
  data.projects = [
    {
      ...project,
      environment: {
        kind: "ssh",
        distribution: null,
        ssh: {
          host: "remote.example",
          user: null,
          port: null,
          identityFile: null,
          hostKey: null,
        },
      },
    },
  ];
  data.sessions = data.sessions.map((item) =>
    item.id === "s2" ? { ...item, favorite: true } : item,
  );
  const automations = [
    {
      sessionId: "s2",
      prompt: "/revue",
      frequency: "daily" as const,
      weekday: 1,
      time: "08:00",
      timeZone: "Europe/Paris",
      enabled: true,
      lastRun: null,
      seenRunAt: null,
    },
  ];
  vi.mocked(automationsApi.loadAgentAutomations).mockResolvedValue(automations);
  vi.mocked(automationsApi.refreshAgentAutomations).mockResolvedValue(
    automations,
  );
  await render();
  await requestAutomations();
  const row = await vi.waitFor(() =>
    container.querySelector<HTMLButtonElement>(
      'ul[aria-label="automations.title"] button',
    )!,
  );
  await act(async () => row.click());
  await click("automations.openSession");

  await vi.waitFor(() =>
    expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2"),
  );
});

it.each([false, true])(
  "never shows empty project actions before the first workspace snapshot (persisted selection=%s)",
  async (persisted) => {
    if (persisted)
      localStorage.setItem(
        "soreno.agents.selection.v1",
        JSON.stringify({ projectId: "p1", sessionId: "s1" }),
      );
    let finish!: (value: WorkspaceData) => void;
    vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setGitPanelContainer(document.createElement("div"));
    document.body.append(gitPanelContainer);
    await render(false, null, gitPanelContainer);
    expect(
      container.querySelector(
        '.agent-project-list [role="status"].app-loading-spinner',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Chargement des projets…");
    expect(container.textContent).not.toContain("Ajoutez un dossier de projet");
    expect(container.textContent).not.toContain("Sélectionnez une session");
    expect(
      gitPanelContainer
        .querySelector('[role="status"]')
        ?.getAttribute("aria-label"),
    ).toContain("Chargement des projets");
    expect(container.textContent).not.toContain("Cloner un dépôt");
    await act(async () => finish(structuredClone(data)));
    expect(gitPanelContainer.textContent).toContain("Soreno");
    expect(api.startAgentSession).not.toHaveBeenCalled();
    if (persisted)
      expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
    else expect(container.textContent).toContain("Sélectionnez une session");
  },
);

it("keeps the initial workspace error through forms and successful status polling, then waits for retry", async () => {
  vi.useFakeTimers();
  const cachedTitles = { s1: "Cached Pi", s2: "Cached Codex" };
  localStorage.setItem(
    "soreno.agents.terminal-titles.v1",
    JSON.stringify(cachedTitles),
  );
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Initial IPC failure"),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  const loadFailed = expect.objectContaining({
    message: "Chargement des projets agents impossible.",
    tone: "error",
  });
  expect(getNotifications()).toEqual([loadFailed]);
  expect(document.body.textContent).not.toContain("Initial IPC failure");
  await addProject("Ajouter un projet");
  await click("Annuler", dialog());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.listAgentStatuses).toHaveBeenCalled();
  expect(getNotifications()).toEqual([loadFailed]);
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.terminal-titles.v1")!),
  ).toEqual(cachedTitles);

  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await retryFromNotification();
  expect(
    container
      .querySelector('.agent-project-list [role="status"]')
      ?.getAttribute("aria-label"),
  ).toContain("Chargement des projets");
  expect(container.textContent).not.toContain("Chargement des projets…");
  expect(container.textContent).not.toContain("Ajoutez un dossier de projet");
  expect(gitPanelContainer.textContent).not.toContain("Ajouter un projet");
  await act(async () => finish(structuredClone(data)));
  expect(button("Cached Pi")).not.toBeNull();
  expect(button("Cached Codex")).not.toBeNull();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it.each(["success", "status failure", "start failure"] as const)(
  "hides the resume hint throughout launch and restores it after a %s",
  async (outcome) => {
    localStorage.setItem(
      "soreno.agents.selection.v1",
      JSON.stringify({ projectId: "p1", sessionId: "s1" }),
    );
    data.statuses[0] = {
      ...data.statuses[0],
      state: "idle",
      resume: "linked",
      conversation: {
        provider: "pi",
        sessionId: "pi-1",
        sessionFile: "/sessions/pi-1.jsonl",
        name: "Première conversation",
      },
    };
    let finishStatuses!: () => void;
    vi.mocked(api.listAgentStatuses).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishStatuses = () =>
            outcome === "status failure"
              ? reject(new Error("Status failed"))
              : resolve(structuredClone(data.statuses));
        }),
    );
    let finishStart!: () => void;
    vi.mocked(api.startAgentSession).mockImplementationOnce(
      (id) =>
        new Promise<void>((resolve, reject) => {
          finishStart = () => {
            if (outcome === "start failure") reject(new Error("Start failed"));
            else {
              setStatus(id, "running");
              resolve();
            }
          };
        }),
    );

    await render();
    expect(
      container.querySelector(".agent-terminal-toolbar .agent-resume-hint")
        ?.textContent,
    ).toBe("Cliquez sur cette session pour reprendre sa conversation liée.");
    await click("Première conversation");
    expect(container.textContent).not.toContain(
      "Cliquez sur cette session pour reprendre sa conversation liée.",
    );
    expect(button("Première conversation").getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(button("Codex tests").hasAttribute("aria-busy")).toBe(false);
    expect(api.startAgentSession).not.toHaveBeenCalled();

    await act(async () => finishStatuses());
    if (outcome !== "status failure") {
      expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
      expect(container.textContent).not.toContain(
        "Cliquez sur cette session pour reprendre sa conversation liée.",
      );
      expect(
        button("Première conversation").querySelector(".app-loading-spinner"),
      ).not.toBeNull();
      await act(async () => finishStart());
    }

    expect(
      button("Première conversation").querySelector(".app-loading-spinner"),
    ).toBeNull();
    expect(button("Première conversation").hasAttribute("aria-busy")).toBe(
      false,
    );
    expect(
      container.textContent?.includes(
        "Cliquez sur cette session pour reprendre sa conversation liée.",
      ),
    ).toBe(outcome !== "success");
    expect(button("Première conversation").disabled).toBe(false);
    expect(api.startAgentSession).toHaveBeenCalledTimes(
      outcome === "status failure" ? 0 : 1,
    );
  },
);

it("keeps launch feedback stable until the post-start refresh finishes", async () => {
  await render();
  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  expect(button("Codex tests").getAttribute("aria-busy")).toBe("true");
  expect(
    container.querySelector(".agent-activity-list")?.textContent,
  ).toContain("Démarrage…");
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledTimes(1);
  await act(async () => finish(structuredClone(data)));
  expect(button("Codex tests").hasAttribute("aria-busy")).toBe(false);
});
