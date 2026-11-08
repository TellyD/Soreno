import { describe, expect, it } from "vitest";
import {
  installGuide,
  installPlatform,
  shouldShowInstallHint,
} from "./installHint";

describe("home screen hint", () => {
  it("gives the instruction of the phone platform", () => {
    expect(
      installPlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
        5,
      ),
    ).toBe("ios");
    expect(
      installPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        5,
      ),
    ).toBe("ios");
    expect(
      installPlatform(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36",
        5,
      ),
    ).toBe("android");
    expect(
      installPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        0,
      ),
    ).toBe("other");
  });

  it("shows only in the browser until it is closed", () => {
    expect(shouldShowInstallHint(false, false)).toBe(true);
    expect(shouldShowInstallHint(true, false)).toBe(false);
    expect(shouldShowInstallHint(false, true)).toBe(false);
  });

  it("only offers to put the icon back once the app is installed, with the gestures of its system", () => {
    expect(installGuide("android", true)).toBe("installedAndroid");
    expect(installGuide("ios", true)).toBe("installedIos");
    expect(installGuide("android", false)).toBe("android");
  });
});
