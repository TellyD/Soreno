export const PROJECT_SERVICES_MANIFEST_PATH = ".soreno/services.json";

const MAX_MANIFEST_SIZE = 128 * 1024;
const MAX_PROFILES = 32;
const MAX_SERVICES = 64;
const MAX_ARGS = 256;
const MAX_TEXT = 4096;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type ProjectService = {
  id: string;
  label: string;
  cwd: string;
  executable: string;
  args: string[];
  port?: number;
};

/** Service ids are unique only within their project's manifest. */
export const projectServiceKey = (projectId: string, serviceId: string) =>
  `${projectId}\n${serviceId}`;

export type ProjectServiceProfile = {
  id: string;
  label: string;
  services: string[];
};

export type ProjectServicesManifest = {
  version: 1;
  profiles: ProjectServiceProfile[];
  services: ProjectService[];
};

export class ProjectServicesManifestError extends Error {
  constructor(
    readonly code: "invalid" | "unsupportedVersion",
    message: string,
  ) {
    super(message);
    this.name = "ProjectServicesManifestError";
  }
}

const invalid = (message: string): never => {
  throw new ProjectServicesManifestError("invalid", message);
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} doit être un objet.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000\r\n]/.test(value)
  )
    invalid(`${label} est invalide.`);
  return value as string;
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 64);
  if (!ID_PATTERN.test(id)) invalid(`${label} est invalide.`);
  return id;
}

function uniqueIds<T extends { id: string }>(items: T[], label: string) {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id))
      invalid(`${label} contient l’identifiant dupliqué « ${item.id} ».`);
    ids.add(item.id);
  }
  return ids;
}

function parseService(value: unknown, index: number): ProjectService {
  const entry = object(value, `services[${index}]`);
  const cwd = text(entry.cwd, `services[${index}].cwd`);
  if (
    !cwd.startsWith("/") ||
    cwd.split("/").some((part) => part === "." || part === "..")
  )
    invalid(`services[${index}].cwd doit être un chemin POSIX absolu.`);
  const executable = text(entry.executable, `services[${index}].executable`);
  if (executable.startsWith("-"))
    invalid(`services[${index}].executable est invalide.`);
  const rawArgs = entry.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS)
    invalid(`services[${index}].args est invalide.`);
  const args = (rawArgs as unknown[]).map((arg, argumentIndex) => {
    if (typeof arg !== "string" || arg.length > MAX_TEXT || arg.includes("\0"))
      invalid(`services[${index}].args[${argumentIndex}] est invalide.`);
    return arg as string;
  });
  if (args.reduce((total, arg) => total + arg.length, 0) > 64 * 1024)
    invalid(`services[${index}].args est trop volumineux.`);
  const port = entry.port;
  if (
    port !== undefined &&
    (!Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535)
  )
    invalid(`services[${index}].port est invalide.`);
  return {
    id: identifier(entry.id, `services[${index}].id`),
    label: text(entry.label, `services[${index}].label`, 128),
    cwd,
    executable,
    args,
    ...(port === undefined ? {} : { port: port as number }),
  };
}

function parseProfile(value: unknown, index: number): ProjectServiceProfile {
  const entry = object(value, `profiles[${index}]`);
  const rawServices = entry.services;
  if (
    !Array.isArray(rawServices) ||
    rawServices.length === 0 ||
    rawServices.length > MAX_SERVICES
  )
    invalid(`profiles[${index}].services est invalide.`);
  const services = (rawServices as unknown[]).map((service, serviceIndex) =>
    identifier(service, `profiles[${index}].services[${serviceIndex}]`),
  );
  if (new Set(services).size !== services.length)
    invalid(`profiles[${index}].services contient un doublon.`);
  return {
    id: identifier(entry.id, `profiles[${index}].id`),
    label: text(entry.label, `profiles[${index}].label`, 128),
    services,
  };
}

export function parseProjectServicesManifest(
  content: string,
): ProjectServicesManifest {
  if (content.length > MAX_MANIFEST_SIZE)
    invalid("Le manifeste de services est trop volumineux.");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("Le manifeste de services n’est pas un JSON valide.");
  }
  const manifest = object(value, "Le manifeste");
  if (manifest.version !== 1)
    throw new ProjectServicesManifestError(
      "unsupportedVersion",
      `Version de manifeste non prise en charge : ${String(manifest.version)}.`,
    );
  const rawServices = manifest.services;
  const rawProfiles = manifest.profiles;
  if (
    !Array.isArray(rawServices) ||
    rawServices.length === 0 ||
    rawServices.length > MAX_SERVICES
  )
    invalid("Le manifeste doit contenir entre 1 et 64 services.");
  if (
    !Array.isArray(rawProfiles) ||
    rawProfiles.length === 0 ||
    rawProfiles.length > MAX_PROFILES
  )
    invalid("Le manifeste doit contenir entre 1 et 32 profils.");
  const services = (rawServices as unknown[]).map(parseService);
  const profiles = (rawProfiles as unknown[]).map(parseProfile);
  const serviceIds = uniqueIds(services, "services");
  uniqueIds(profiles, "profiles");
  for (const profile of profiles) {
    const unknown = profile.services.find((id) => !serviceIds.has(id));
    if (unknown)
      invalid(
        `Le profil « ${profile.id} » référence le service inconnu « ${unknown} ».`,
      );
  }
  return { version: 1, profiles, services };
}
