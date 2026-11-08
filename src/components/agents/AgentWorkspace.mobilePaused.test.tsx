// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  render,
  button,
  click,
  dialog,
  sshStatusHost,
  mobileStatus,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";

const mobileButton = (host: ParentNode) =>
  [...host.querySelectorAll("button")].some(
    (item) => item.textContent === "Mobile",
  );

it("hides mobile access where it is not installed", async () => {
  const host = sshStatusHost();
  await render();
  await vi.waitFor(() =>
    expect(api.loadAgentSshMobileStatus).toHaveBeenCalledWith("p1"),
  );
  expect(mobileButton(host)).toBe(false);
});

it("only lets an installed service be disabled", async () => {
  vi.useFakeTimers();
  const host = sshStatusHost();
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(
    mobileStatus({ installed: true, upToDate: true, active: true }),
  );
  await render();
  await vi.waitFor(() => expect(mobileButton(host)).toBe(true));

  await click("Mobile", host);
  await vi.waitFor(() => button("Désactiver", dialog()));
  expect(dialog().textContent).toContain("L’accès mobile est suspendu");
  expect(() => button("Activer", dialog())).toThrow();
  expect(() => button("Appairer un téléphone", dialog())).toThrow();

  vi.mocked(api.disableAgentSshMobile).mockResolvedValue(mobileStatus({}));
  await click("Désactiver", dialog());
  await click(
    "Désactiver",
    document.querySelector<HTMLElement>('[role="alertdialog"]')!,
  );
  expect(api.disableAgentSshMobile).toHaveBeenCalledWith("p1");
  await vi.waitFor(() => expect(mobileButton(host)).toBe(false));
  const reads = vi.mocked(api.loadAgentSshMobileStatus).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.loadAgentSshMobileStatus).toHaveBeenCalledTimes(reads);
});
