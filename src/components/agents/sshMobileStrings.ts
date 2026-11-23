import { mediumDateTimeFormat } from "../../domain/dateTime";

export const sshMobileStringsEn = {
  sshMobile: "Mobile",
  sshMobileTitle: "Mobile access",
  sshMobileIntro:
    "Follow this server’s sessions on your phone from any network, after scanning a QR code. Nothing to install on the phone.",
  sshMobilePaused:
    "Mobile access is suspended while its security is being consolidated. The service is still installed on this server but no phone can reach it. You can disable it; nothing else is possible for now.",
  sshMobileLoading: "Reading mobile access…",
  sshMobileOutdated: "Update required",
  sshMobileLegacy:
    "Mobile access no longer goes through Tailscale. After the update, pair your phones again.",
  sshMobileUnsupported: (platform: string) =>
    `Unavailable: mobile access requires a Linux x86_64 or aarch64 server (detected: ${platform}).`,
  sshMobileConnected: "Connected",
  sshMobileConnecting: "Waiting…",
  sshMobileRelayUnreachable:
    "Relay unreachable: phones cannot reach this server for now. The service keeps retrying.",
  sshMobilePair: "Pair a phone",
  sshMobileNewQr: "New QR code",
  sshMobileQrAlt: "Pairing QR code",
  sshMobilePhoneSteps: [
    "Scan the QR code with the phone’s camera.",
    "The page opens and the phone is paired.",
    "Add the page to the home screen.",
  ],
  sshMobilePairingValidity: (expiresAt: number) =>
    `Valid for 10 minutes, once · expires at ${new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(expiresAt)}`,
  sshMobilePaired: "Phone paired.",
  sshMobilePairingExpired: "QR code expired.",
  sshMobileDevices: "Paired devices",
  sshMobileNoDevices: "No paired phone yet.",
  sshMobileDevicesUnknown:
    "Paired devices cannot be read right now; Soreno will try again.",
  sshMobileDeviceDates: (pairedAt: number, lastSeenAt: number | null) => {
    const date = mediumDateTimeFormat("en");
    return `Paired ${date.format(pairedAt)} · ${lastSeenAt === null ? "never used" : `last seen ${date.format(lastSeenAt)}`}`;
  },
  sshMobileRevoke: "Revoke",
  sshMobileEnable: "Enable",
  sshMobileUpdate: "Update",
  sshMobileDisable: "Disable",
  sshMobileDisableTitle: "Disable mobile access?",
  sshMobileDisableDescription:
    "Every paired phone loses access to this server. After enabling it again, you will need to pair them again.",
  sshMobileFailed: "Mobile access operation failed.",
  sshMobileErrors: {
    unsupported: "Mobile access requires a Linux x86_64 or aarch64 server.",
    launch:
      "Unable to launch soreno-remote on this server without systemd: run the activation again.",
    exited:
      "soreno-remote stops right after launch: check `~/.cache/soreno/remote/serve.log` on the server.",
    busy: "Another soreno-remote start is in progress on the server: try again in a moment.",
    kill: "soreno-remote does not stop; its files are kept: stop the process listed in `~/.cache/soreno/remote/pid` on the server, then try again.",
    systemd:
      "User systemd is unavailable for this account: `systemctl --user` must work on the server.",
    linger:
      "Unable to keep the service running after logout: ask an administrator to run `sudo loginctl enable-linger $USER` on the server.",
    start:
      "systemd could not start soreno-remote: check `systemctl --user status soreno-remote` on the server.",
    stopped:
      "The soreno-remote service does not stay active: check `journalctl --user -u soreno-remote` on the server.",
    stop: "systemd could not stop soreno-remote; the service and its files are kept: check `systemctl --user status soreno-remote` on the server, then try again.",
    files:
      "Unable to write or remove the mobile access files on the server (`~/.config/systemd/user`, `~/.cache/soreno/remote`).",
    hash: "The transferred soreno-remote binary does not match its SHA-256 fingerprint (`sha256sum` or `shasum` is required on the server).",
    binary: "The soreno-remote binary does not run on this server.",
    pairing: "Unable to create a pairing QR code on the server.",
    revoke: "Unable to revoke this device on the server.",
    relay:
      "Mobile access is enabled, but the server does not reach the Soreno relay yet: check that it may connect out on TCP port 8790. The service keeps retrying.",
  },
};

export const sshMobileStringsFr: typeof sshMobileStringsEn = {
  sshMobile: "Mobile",
  sshMobileTitle: "Accès mobile",
  sshMobileIntro:
    "Suivez les sessions de ce serveur sur votre téléphone, depuis n’importe quel réseau, après avoir scanné un QR code. Rien à installer sur le téléphone.",
  sshMobilePaused:
    "L’accès mobile est suspendu le temps d’en consolider la sécurité. Le service reste installé sur ce serveur, mais aucun téléphone ne peut le joindre. Vous pouvez le désactiver ; rien d’autre n’est possible pour l’instant.",
  sshMobileLoading: "Lecture de l’accès mobile…",
  sshMobileOutdated: "Mise à jour nécessaire",
  sshMobileLegacy:
    "L’accès mobile ne passe plus par Tailscale. Après la mise à jour, appairez de nouveau vos téléphones.",
  sshMobileUnsupported: (platform: string) =>
    `Indisponible : l’accès mobile exige un serveur Linux x86_64 ou aarch64 (détecté : ${platform}).`,
  sshMobileConnected: "Connecté",
  sshMobileConnecting: "En attente…",
  sshMobileRelayUnreachable:
    "Relais injoignable : les téléphones ne peuvent pas joindre ce serveur pour l’instant. Le service réessaie tout seul.",
  sshMobilePair: "Appairer un téléphone",
  sshMobileNewQr: "Nouveau QR code",
  sshMobileQrAlt: "QR code d’appairage",
  sshMobilePhoneSteps: [
    "Scannez le QR code avec l’appareil photo du téléphone.",
    "La page s’ouvre et le téléphone est appairé.",
    "Ajoutez la page à l’écran d’accueil.",
  ],
  sshMobilePairingValidity: (expiresAt: number) =>
    `Valable 10 minutes, une seule fois · expire à ${new Intl.DateTimeFormat("fr", { timeStyle: "short" }).format(expiresAt)}`,
  sshMobilePaired: "Téléphone appairé.",
  sshMobilePairingExpired: "QR code expiré.",
  sshMobileDevices: "Appareils appairés",
  sshMobileNoDevices: "Aucun téléphone appairé pour l’instant.",
  sshMobileDevicesUnknown:
    "Les appareils appairés sont illisibles pour l’instant ; Soreno réessaie.",
  sshMobileDeviceDates: (pairedAt: number, lastSeenAt: number | null) => {
    const date = mediumDateTimeFormat("fr");
    return `Appairé le ${date.format(pairedAt)} · ${lastSeenAt === null ? "jamais utilisé" : `vu le ${date.format(lastSeenAt)}`}`;
  },
  sshMobileRevoke: "Révoquer",
  sshMobileEnable: "Activer",
  sshMobileUpdate: "Mettre à jour",
  sshMobileDisable: "Désactiver",
  sshMobileDisableTitle: "Désactiver l’accès mobile ?",
  sshMobileDisableDescription:
    "Tous les téléphones appairés perdront l’accès à ce serveur. Après une nouvelle activation, il faudra les appairer de nouveau.",
  sshMobileFailed: "L’opération sur l’accès mobile a échoué.",
  sshMobileErrors: {
    unsupported: "L’accès mobile exige un serveur Linux x86_64 ou aarch64.",
    launch:
      "Impossible de lancer soreno-remote sur ce serveur sans systemd : relancez l’activation.",
    exited:
      "soreno-remote s’arrête dès son lancement : consultez `~/.cache/soreno/remote/serve.log` sur le serveur.",
    busy: "Un autre démarrage de soreno-remote est en cours sur le serveur : réessayez dans un instant.",
    kill: "soreno-remote ne s’arrête pas ; ses fichiers sont conservés : arrêtez le processus indiqué dans `~/.cache/soreno/remote/pid` sur le serveur, puis réessayez.",
    systemd:
      "systemd utilisateur est indisponible pour ce compte : `systemctl --user` doit fonctionner sur le serveur.",
    linger:
      "Impossible de maintenir le service après déconnexion : faites lancer `sudo loginctl enable-linger $USER` sur le serveur par un administrateur.",
    start:
      "systemd n’a pas pu démarrer soreno-remote : consultez `systemctl --user status soreno-remote` sur le serveur.",
    stopped:
      "Le service soreno-remote ne reste pas actif : consultez `journalctl --user -u soreno-remote` sur le serveur.",
    stop: "systemd n’a pas pu arrêter soreno-remote ; le service et ses fichiers sont conservés : consultez `systemctl --user status soreno-remote` sur le serveur, puis réessayez.",
    files:
      "Impossible d’écrire ou de supprimer les fichiers de l’accès mobile sur le serveur (`~/.config/systemd/user`, `~/.cache/soreno/remote`).",
    hash: "Le binaire soreno-remote transféré ne correspond pas à son empreinte SHA-256 (`sha256sum` ou `shasum` est requis sur le serveur).",
    binary: "Le binaire soreno-remote ne s’exécute pas sur ce serveur.",
    pairing: "Impossible de créer un QR code d’appairage sur le serveur.",
    revoke: "Impossible de révoquer cet appareil sur le serveur.",
    relay:
      "L’accès mobile est activé, mais le serveur ne joint pas encore le relais Soreno : vérifiez qu’il peut se connecter en sortie sur le port TCP 8790. Le service réessaie tout seul.",
  },
};
