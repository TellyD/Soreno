import { TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { openLogDirectory } from "../data/diagnosticsApi";
import { useI18n } from "../i18n";
import { notifyError } from "../notifications";
import { AppTitleBar } from "./AppTitleBar";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";

type AppErrorBoundaryProps = { children: ReactNode };

// Reporting happens in the root's onCaughtError, which also receives the component stack.
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <AppCrash /> : this.props.children;
  }
}

function AppCrash() {
  const { t } = useI18n();
  return (
    <main className="app-shell app-shell-loading">
      <AppTitleBar />
      <EmptyState
        role="alert"
        fill
        icon={<TriangleAlert />}
        title={t("app.crash.title")}
        description={t("app.crash.description")}
        actions={
          <>
            <Button variant="primary" onClick={() => window.location.reload()}>
              {t("app.crash.reload")}
            </Button>
            <Button
              onClick={() =>
                void openLogDirectory().catch(() =>
                  notifyError(t("logs.openError")),
                )
              }
            >
              {t("logs.open")}
            </Button>
          </>
        }
      />
    </main>
  );
}
