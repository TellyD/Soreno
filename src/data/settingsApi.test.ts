import { describe, expect, it } from "vitest";
import { defaultAppSettings, normalizeSettings } from "./settingsApi";

describe("normalizeSettings", () => {
  it("keeps only non-empty usage account ids", () => {
    expect(
      normalizeSettings({
        codexUsageAccountId: "",
        claudeUsageAccountId: 3,
      } as unknown as Partial<typeof defaultAppSettings>),
    ).toMatchObject({ codexUsageAccountId: null, claudeUsageAccountId: null });
    expect(
      normalizeSettings({ codexUsageAccountId: "account:x" }),
    ).toMatchObject({ codexUsageAccountId: "account:x" });
  });

  it("keeps hidden agents that can still be launched, once each", () => {
    expect(
      normalizeSettings({
        hiddenAgentPresets: ["pi", "", "retired-agent", "pi", "claude"],
      } as unknown as Partial<typeof defaultAppSettings>),
    ).toMatchObject({ hiddenAgentPresets: ["pi", "claude"] });
  });

  it("keeps hidden chat commands once each, and an emptied list empty", () => {
    expect(
      normalizeSettings({
        hiddenChatCommands: ["green", "", 3, "green", "skill:review"],
      } as unknown as Partial<typeof defaultAppSettings>),
    ).toMatchObject({ hiddenChatCommands: ["green", "skill:review"] });
    expect(
      normalizeSettings({ hiddenChatCommands: [] }).hiddenChatCommands,
    ).toEqual([]);
  });

  it("keeps a chosen Git model and treats a blank one as the default", () => {
    expect(
      normalizeSettings({ codexGitModel: " gpt-5.4-mini " }).codexGitModel,
    ).toBe("gpt-5.4-mini");
    expect(normalizeSettings({ codexGitModel: "  " }).codexGitModel).toBeNull();
  });

  it("keeps agent notifications and Git fast mode on unless explicitly turned off", () => {
    expect(normalizeSettings({})).toMatchObject({
      agentNotificationsEnabled: true,
      codexGitFastMode: true,
    });
    expect(
      normalizeSettings({
        agentNotificationsEnabled: false,
        codexGitFastMode: false,
      }),
    ).toMatchObject({
      agentNotificationsEnabled: false,
      codexGitFastMode: false,
    });
  });
});
