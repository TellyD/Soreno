// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearNotifications, getNotifications } from "../notifications";
import { VaultPicker } from "./VaultPicker";
import { setInputValue } from "./ui/testInput";

const i18nSettings = vi.hoisted(() => ({ languagePreference: "en" }));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: i18nSettings,
    updateSettings: vi.fn(),
  }),
}));

const vaults = [
  { id: "one", name: "One", createdAt: "now", updatedAt: "now" },
  { id: "two", name: "Two", createdAt: "now", updatedAt: "now" },
];

afterEach(() => clearNotifications());

it("localizes the untouched default vault name", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  i18nSettings.languagePreference = "en";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const localVault = {
    id: "local",
    name: "Coffre local",
    createdAt: "now",
    updatedAt: "now",
  };

  try {
    await act(async () =>
      root.render(
        <I18nProvider>
          <VaultPicker
            activeVault={localVault}
            isChangingVault={false}
            onCreateVault={vi.fn()}
            onDeleteVault={vi.fn()}
            onRenameVault={vi.fn()}
            onSelectVault={vi.fn()}
            vaults={[localVault]}
          />
        </I18nProvider>,
      ),
    );
    expect(
      container.querySelector(".status-vault-button")?.textContent,
    ).toContain("Local vault");
    expect(container.textContent).not.toContain("Coffre local");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([["en", "A vault already uses this name."]] as const)(
  "notifies the %s name validation error until the form closes",
  async (language, message) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    i18nSettings.languagePreference = language;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onCreateVault = vi.fn();

    try {
      await act(async () =>
        root.render(
          <I18nProvider>
            <VaultPicker
              activeVault={vaults[0]}
              isChangingVault={false}
              onCreateVault={onCreateVault}
              onDeleteVault={vi.fn()}
              onRenameVault={vi.fn()}
              onSelectVault={vi.fn()}
              vaults={vaults}
            />
          </I18nProvider>,
        ),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(".status-vault-button")!
          .click(),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            ".vault-picker-actions .app-menu-item",
          )!
          .click(),
      );
      const input = container.querySelector<HTMLInputElement>(
        ".vault-picker-form input",
      )!;
      await act(async () => {
        setInputValue(input, "Two");
      });
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );

      expect(onCreateVault).not.toHaveBeenCalled();
      expect(getNotifications()).toEqual([
        expect.objectContaining({ message, tone: "error" }),
      ]);
      expect(container.textContent).not.toContain(message);

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            ".vault-picker-form-actions button",
          )!
          .click(),
      );
      expect(getNotifications()).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
