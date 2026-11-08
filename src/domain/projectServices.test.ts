import { describe, expect, it } from "vitest";
import {
  parseProjectServicesManifest,
  ProjectServicesManifestError,
} from "./projectServices";

const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    profiles: [{ id: "main", label: "Main", services: ["tsapi"] }],
    services: [
      {
        id: "tsapi",
        label: "Tsapi",
        cwd: "/workspaces/tsapi",
        executable: "bash",
        args: ["/workspaces/gitpod-flex-front/scripts/tsapi.sh"],
        port: 3012,
      },
    ],
    ...overrides,
  });

describe("parseProjectServicesManifest", () => {
  it("parses a bounded version 1 manifest", () => {
    expect(parseProjectServicesManifest(manifest())).toEqual({
      version: 1,
      profiles: [{ id: "main", label: "Main", services: ["tsapi"] }],
      services: [
        {
          id: "tsapi",
          label: "Tsapi",
          cwd: "/workspaces/tsapi",
          executable: "bash",
          args: ["/workspaces/gitpod-flex-front/scripts/tsapi.sh"],
          port: 3012,
        },
      ],
    });
  });

  it("rejects malformed JSON and unsupported versions with distinct codes", () => {
    expect(() => parseProjectServicesManifest("{")).toThrow(
      ProjectServicesManifestError,
    );
    try {
      parseProjectServicesManifest(manifest({ version: 2 }));
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupportedVersion" });
    }
  });

  it("rejects duplicate ids, unknown references and invalid ports", () => {
    const service = JSON.parse(manifest()).services[0];
    expect(() =>
      parseProjectServicesManifest(
        manifest({ services: [service, { ...service }] }),
      ),
    ).toThrow(/dupliqué/);
    expect(() =>
      parseProjectServicesManifest(
        manifest({
          profiles: [{ id: "main", label: "Main", services: ["missing"] }],
        }),
      ),
    ).toThrow(/inconnu/);
    expect(() =>
      parseProjectServicesManifest(
        manifest({ services: [{ ...service, port: 70000 }] }),
      ),
    ).toThrow(/port/);
  });

  it("requires safe POSIX working directories and bounded arguments", () => {
    const service = JSON.parse(manifest()).services[0];
    expect(() =>
      parseProjectServicesManifest(
        manifest({ services: [{ ...service, cwd: "../tsapi" }] }),
      ),
    ).toThrow(/POSIX/);
    expect(() =>
      parseProjectServicesManifest(
        manifest({ services: [{ ...service, args: ["bad\0arg"] }] }),
      ),
    ).toThrow(/args/);
  });
});
