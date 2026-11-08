import {
  Check,
  ChevronRight,
  Copy,
  HardDrive,
  LoaderCircle,
  MessageCircleQuestion,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  Server,
  SquarePlus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { agentProviderLabel } from "@/domain/agentSessions";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  installGuide,
  installPlatform,
  isInstalledGuide,
  isStandalone,
  loadInstallHintDismissed,
  promptInstall,
  saveInstallHintDismissed,
  shouldShowInstallHint,
  type InstallGuide,
} from "./installHint";
import { HeaderMenu } from "./HeaderMenu";
import type { RemoteHost, RemoteSession, ServerState } from "./mobileApi";
import {
  sessionActivity,
  sessionActivityLabel,
  sessionHref,
  sessionSubtitle,
  sessionTitle,
  sortHosts,
  unreadSessions,
} from "./mobileSessions";
import type { MobileStrings } from "./mobileStrings";
import { unreadKey } from "./sessionUnread";
import type { ServersState } from "./useServers";

type Strings = { strings: MobileStrings };

function ActivityBadge({
  session,
  unread,
  strings,
}: Strings & {
  session: Pick<RemoteSession, "working" | "awaiting">;
  unread: boolean;
}) {
  const activity = sessionActivity(session, unread);
  return (
    <span className={`mobile-activity is-${activity}`}>
      {activity === "working" ? (
        <LoaderCircle
          size={11}
          className="app-loading-spinner"
          aria-hidden="true"
        />
      ) : activity === "awaiting" ? (
        <MessageCircleQuestion size={11} aria-hidden="true" />
      ) : (
        <span className="mobile-activity-dot" aria-hidden="true" />
      )}
      {sessionActivityLabel(activity, strings)}
    </span>
  );
}

function InstallHint({
  strings,
  guide,
  onDismiss,
}: Strings & { guide: InstallGuide; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const address = `${window.location.origin}/`;
  const copy = () =>
    void navigator.clipboard.writeText(address).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <aside
      className="mobile-install"
      aria-label={strings.installTitle[guide]}
      tabIndex={-1}
    >
      <SquarePlus
        size={20}
        className="mobile-install-icon"
        aria-hidden="true"
      />
      <div className="mobile-install-body">
        <strong>{strings.installTitle[guide]}</strong>
        <ol className="mobile-install-steps">
          {strings.installSteps[guide].map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {isInstalledGuide(guide) ? null : (
          <div className="mobile-install-address">
            <code>{address}</code>
            <Button
              size="small"
              startIcon={copied ? <Check /> : <Copy />}
              onClick={copy}
            >
              {copied ? strings.addressCopied : strings.copyAddress}
            </Button>
          </div>
        )}
      </div>
      <IconButton
        aria-label={strings.installDismiss}
        title={strings.installDismiss}
        onClick={onDismiss}
      >
        <X />
      </IconButton>
    </aside>
  );
}

function SessionRow({
  session,
  host,
  showHost,
  disabled,
  unread,
  strings,
}: Strings & {
  session: RemoteSession;
  host: RemoteHost;
  showHost: boolean;
  disabled: boolean;
  unread: ReadonlySet<string>;
}) {
  const content = (
    <>
      <span className="mobile-session-main">
        <span className="mobile-session-title">{sessionTitle(session)}</span>
        {sessionSubtitle(session) ? (
          <span className="mobile-session-name">
            {sessionSubtitle(session)}
          </span>
        ) : null}
        <span className="mobile-session-meta">
          <ActivityBadge
            session={session}
            unread={unread.has(unreadKey(host.server, session.key))}
            strings={strings}
          />
          {showHost ? (
            <span className="mobile-session-host">
              <Server size={12} aria-hidden="true" />
              {host.host}
            </span>
          ) : null}
          {session.deleted ? (
            <span className="mobile-session-provider is-missing">
              {strings.deletedConversationShort}
            </span>
          ) : session.provider ? (
            <span className="mobile-session-provider">
              {agentProviderLabel(session.provider)}
            </span>
          ) : (
            <span className="mobile-session-provider is-missing">
              {strings.noConversationShort}
            </span>
          )}
          {session.attached ? (
            <span className="mobile-session-attached" title={strings.attached}>
              <MonitorSmartphone size={13} aria-hidden="true" />
              <span className="mobile-visually-hidden">{strings.attached}</span>
            </span>
          ) : null}
        </span>
      </span>
      {disabled ? null : (
        <ChevronRight
          size={18}
          className="mobile-session-chevron"
          aria-hidden="true"
        />
      )}
    </>
  );
  return (
    <li>
      {disabled ? (
        <div className="mobile-session" aria-disabled="true">
          {content}
        </div>
      ) : (
        <a
          className="mobile-session"
          href={sessionHref(host.server, session.key)}
        >
          {content}
        </a>
      )}
    </li>
  );
}

function stateLabel(state: ServerState, strings: MobileStrings) {
  switch (state) {
    case "online":
      return strings.hostOnline;
    case "connecting":
      return strings.hostConnecting;
    case "offline":
      return strings.hostOffline;
    case "unpaired":
      return strings.hostUnpaired;
  }
}

function HostGroup({
  host,
  unread,
  strings,
  onForget,
}: Strings & {
  host: RemoteHost;
  unread: ReadonlySet<string>;
  onForget: () => void;
}) {
  const away = host.state !== "online";
  return (
    <section
      className={away ? "mobile-host is-offline" : "mobile-host"}
      aria-label={host.host}
    >
      <header className="mobile-host-header">
        <h2 className="mobile-host-name">{host.host}</h2>
        <span className={`mobile-host-status is-${host.state}`}>
          <span className="mobile-host-dot" aria-hidden="true" />
          {stateLabel(host.state, strings)}
        </span>
        <span className="mobile-host-count">
          {strings.sessionCount(host.sessions.length)}
        </span>
        <HeaderMenu
          label={strings.serverActions(host.host)}
          actions={[
            {
              id: "forget",
              label: strings.forgetServer,
              icon: <Trash2 />,
              onSelect: onForget,
            },
          ]}
        />
      </header>
      {host.state === "offline" ? (
        <p className="mobile-host-note">{strings.hostOfflineBody}</p>
      ) : host.state === "unpaired" ? (
        <div className="mobile-host-unpaired" role="status">
          <p className="mobile-host-note">{strings.hostUnpairedBody}</p>
          <Button size="small" startIcon={<Trash2 />} onClick={onForget}>
            {strings.forgetServer}
          </Button>
        </div>
      ) : null}
      {host.sessions.length ? (
        <ul className="mobile-session-list">
          {host.sessions.map((session) => (
            <SessionRow
              key={session.key}
              session={session}
              host={host}
              showHost={false}
              disabled={away}
              unread={unread}
              strings={strings}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SessionList({
  servers,
  unread,
  strings,
  onScan,
}: Strings & {
  servers: ServersState;
  unread: ReadonlySet<string>;
  onScan: () => void;
}) {
  const hosts = sortHosts(servers.hosts);
  const finished = unreadSessions(servers.hosts, unread);
  const empty =
    hosts.some((host) => host.state === "online") &&
    hosts.every((host) => host.sessions.length === 0);
  const [guide] = useState(() =>
    installGuide(
      installPlatform(navigator.userAgent, navigator.maxTouchPoints),
      isStandalone(),
    ),
  );
  const [installHint, setInstallHint] = useState(() =>
    shouldShowInstallHint(isInstalledGuide(guide), loadInstallHintDismissed()),
  );
  const hintRef = useRef<HTMLDivElement>(null);
  const install = () =>
    void promptInstall().then((prompted) => {
      if (prompted) return;
      setInstallHint(true);
      // The steps may be out of sight, below a long list or behind the menu.
      requestAnimationFrame(() => {
        hintRef.current?.scrollIntoView({ block: "start" });
        hintRef.current?.querySelector<HTMLElement>(".mobile-install")?.focus();
      });
    });
  const forget = (host: RemoteHost) => {
    if (window.confirm(strings.forgetConfirm(host.host)))
      void servers.forget(host.server);
  };
  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-header-title">
          <h1 className="mobile-app-title">{strings.appName}</h1>
        </div>
        <HeaderMenu
          label={strings.moreActions}
          actions={[
            {
              id: "scan",
              label: strings.scanQr,
              icon: <QrCode />,
              onSelect: onScan,
            },
            {
              id: "install",
              label: strings.installApp,
              icon: <SquarePlus />,
              onSelect: install,
            },
            {
              id: "reload",
              label: strings.reload,
              icon: <RefreshCw />,
              onSelect: () => window.location.reload(),
            },
          ]}
        />
      </header>
      <main className="mobile-content">
        {installHint ? (
          <div ref={hintRef}>
            <InstallHint
              strings={strings}
              guide={guide}
              onDismiss={() => {
                saveInstallHintDismissed();
                setInstallHint(false);
              }}
            />
          </div>
        ) : null}
        {servers.storeFailed ? (
          <EmptyState
            fill
            icon={<HardDrive />}
            title={strings.storeFailedTitle}
            description={strings.storeFailedBody}
            actions={
              <Button
                size="large"
                variant="primary"
                startIcon={<RefreshCw />}
                onClick={servers.reload}
              >
                {strings.retry}
              </Button>
            }
          />
        ) : !servers.servers ? (
          <LoadingState className="mobile-loading">
            {strings.loading}
          </LoadingState>
        ) : servers.servers.length === 0 ? (
          <EmptyState
            fill
            icon={<QrCode />}
            title={strings.noServersTitle}
            description={strings.noServersBody}
            actions={
              <Button
                size="large"
                variant="primary"
                startIcon={<QrCode />}
                onClick={onScan}
              >
                {strings.scanQr}
              </Button>
            }
          />
        ) : (
          <>
            {empty ? (
              <EmptyState
                className="mobile-empty"
                icon={<SquareTerminal />}
                description={strings.empty}
              />
            ) : null}
            {finished.length ? (
              <section
                className="mobile-unread"
                aria-label={strings.unreadTitle}
              >
                <h2 className="mobile-section-title">{strings.unreadTitle}</h2>
                <ul className="mobile-session-list">
                  {finished.map(({ host, session }) => (
                    <SessionRow
                      key={`${host.server}/${session.key}`}
                      session={session}
                      host={host}
                      showHost
                      disabled={false}
                      unread={unread}
                      strings={strings}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
            {hosts.map((host) => (
              <HostGroup
                key={host.server}
                host={host}
                unread={unread}
                strings={strings}
                onForget={() => forget(host)}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}
