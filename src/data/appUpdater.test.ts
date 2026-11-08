import { expect, it, vi } from "vitest";
import { installAppUpdate, type AppUpdate } from "./appUpdater";

it("asks the Windows installer to restart Soreno", async () => {
  const install = vi.fn().mockResolvedValue(undefined);

  await installAppUpdate({ install } as unknown as AppUpdate);

  expect(install).toHaveBeenCalledWith({ restartAfterInstall: true });
});
