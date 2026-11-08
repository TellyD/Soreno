import { expect, it } from "vitest";
import { agentStringsForLocale } from "./agentStrings";
import { gitErrorMessage } from "../../domain/projectGit";
import {
  formatOperationError,
  type OperationErrorInput,
} from "./operationError";

const format = (locale: string, input: OperationErrorInput) =>
  formatOperationError(agentStringsForLocale(locale), input);

it("summarizes a DNS log, appends the localized warning and drops the raw log", () => {
  const message = `fatal: unable to access repository: Could not resolve host: example.test\n${"network trace\n".repeat(30)}`;

  expect(
    format("en-US", { message, warning: "The result may be incomplete." }),
  ).toBe(
    "Server name could not be resolved (DNS). Check your network connection and retry. The result may be incomplete.",
  );
});

it("replaces SSH host-key output with actionable localized guidance", () => {
  expect(
    format("fr-FR", {
      message:
        "No ED25519 host key is known for server.test and you have requested strict checking. Host key verification failed.",
    }),
  ).toBe(
    "L’identité du serveur SSH n’a pas pu être vérifiée. Vérifiez sa clé d’hôte avant de réessayer.",
  );
});

it("explains a confirmed locked SSH key without leaking diagnostics", () => {
  expect(
    format("en-US", {
      message:
        "[SSH/keyRequiresAgent]\nuser@private-host: Permission denied (publickey).",
      fileCode: "ssh",
    }),
  ).toBe(agentStringsForLocale("en-US").sshKeyRequiresAgent);
});

it("localizes authentication failures in French", () => {
  expect(
    format("fr-FR", {
      message:
        "remote: HTTP Basic: Access denied\nfatal: Authentication failed for repository",
    }),
  ).toBe(
    "L’authentification Git a été refusée. Vérifiez les identifiants Git de cet environnement.",
  );
});

it("localizes Git error codes", () => {
  expect(format("en-US", { message: "[Git/dirty]" })).toBe(
    "The working tree must be clean before this Git operation.",
  );
  expect(format("fr-FR", { message: "[Git/rebaseConflict] x" })).toBe(
    agentStringsForLocale("fr-FR").operationGitRebaseConflict,
  );
});

it("explains a deletion blocked by a session automation", () => {
  expect(
    format("fr-FR", {
      message:
        "[Session/hasAutomation]\nSupprimez d’abord l’automatisation de cette session.",
    }),
  ).toBe(agentStringsForLocale("fr-FR").operationSessionHasAutomation);
  expect(
    format("fr-FR", {
      message: gitErrorMessage({
        code: "sessionHasAutomation",
        message: "Le worktree n’a pas été modifié : automatisation",
      }),
    }),
  ).toBe(agentStringsForLocale("fr-FR").operationSessionHasAutomation);
});

it("localizes project file codes instead of the raw message", () => {
  expect(
    format("en-US", {
      message: "Ce fichier binaire n’est pas éditable.",
      fileCode: "binary",
    }),
  ).toBe("This binary file can’t be edited.");
});

it("summarizes project file transport codes without their raw output", () => {
  expect(
    format("en-US", {
      message: "sh: 1: cannot open src/App.tsx: Permission denied",
      fileCode: "ssh",
    }),
  ).toBe(
    "Unable to access the remote project. Check the connection and project permissions.",
  );
});

it("keeps SSH diagnostics ahead of the project file transport summary", () => {
  expect(
    format("en-US", {
      message: "ssh: Could not resolve hostname devbox",
      fileCode: "ssh",
    }),
  ).toBe(
    "Server name could not be resolved (DNS). Check your network connection and retry.",
  );
});

it.each([
  [
    "[Git/timeout]",
    "Unable to read the Git repository. Git didn’t respond in time. Check access to the repository, then try again.",
  ],
  ["[Git/failed]", "Unable to read the Git repository."],
])(
  "prefixes the known cause of %s with the operation context",
  (message, expected) => {
    expect(
      format("en-US", {
        message,
        context: "Unable to read the Git repository.",
      }),
    ).toBe(expected);
  },
);

it("appends the malformed Git detail only in the backend language", () => {
  const detail = "Git a retourné un statut porcelain v2 invalide.";
  const context = "Contexte du dépôt.";
  const warning = "Avertissement.";
  const message = `[Git/malformed] ${detail}`;

  expect(format("fr-FR", { message, context, warning })).toBe(
    `${context} ${agentStringsForLocale("fr-FR").operationGitMalformed} ${detail} ${warning}`,
  );
  expect(format("en-US", { message, context })).toBe(
    `${context} ${agentStringsForLocale("en-US").operationGitMalformed}`,
  );
  expect(
    format("fr-FR", { message: "[Git/failed] secret detail", context }),
  ).not.toContain("secret detail");
});

it("never shows unknown backend text", () => {
  expect(format("en-US", { message: "Workspace unavailable" })).toBe(
    "The operation failed. Please try again.",
  );
});
