import { describe, expect, it } from "vitest";
import {
  MAX_VAULT_NAME_LENGTH,
  normalizeVaultName,
  validateVaultName,
  type Vault,
} from "./vaults";

const vaults: Vault[] = [
  {
    id: "local",
    name: "Coffre local",
    createdAt: "2026-06-29T08:00:00.000Z",
    updatedAt: "2026-06-29T08:00:00.000Z",
  },
  {
    id: "work",
    name: "Travail",
    createdAt: "2026-06-29T09:00:00.000Z",
    updatedAt: "2026-06-29T09:00:00.000Z",
  },
];

describe("vault name helpers", () => {
  it("trims vault names", () => {
    expect(normalizeVaultName("  Projet  ")).toBe("Projet");
  });

  it("rejects empty vault names", () => {
    expect(validateVaultName("   ", vaults)).toBe("empty");
  });

  it("rejects long vault names", () => {
    expect(
      validateVaultName("a".repeat(MAX_VAULT_NAME_LENGTH + 1), vaults),
    ).toBe("too-long");
  });

  it("rejects duplicate names outside the current vault", () => {
    expect(validateVaultName("Coffre local", vaults)).toBe("duplicate");
    expect(validateVaultName("Coffre local", vaults, "local")).toBeNull();
  });
});
