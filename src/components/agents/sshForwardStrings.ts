export const sshForwardStringsEn = {
  sshForwardPorts: "Ports",
  sshForwardCount: (count: number) => `Ports · ${count}`,
  sshForwardTitle: "SSH port forwarding",
  sshForwardDescription: (address: string) =>
    `Forward remote ports from ${address} to this computer.`,
  sshForwardInput: "Remote ports",
  sshForwardPlaceholder: "2928 8088:8095",
  sshForwardHint:
    "Separate ports with spaces. Ranges can be entered in either direction.",
  sshForwardStart: "Start forwarding",
  sshForwardStop: "Stop all",
  sshForwardEmpty: "No active port forwarding.",
  sshForwardLocalChanged:
    "The matching local port was unavailable, so Soreno selected a free port.",
  sshForwardOpen: (url: string) => `Open ${url}`,
  sshForwardLoading: "Loading SSH port forwarding…",
  sshForwardLoadError: "Unable to read SSH port forwarding.",
  sshForwardStartError:
    "Unable to start port forwarding. Check the entered ports and the SSH connection.",
  sshForwardStopError: "Unable to stop port forwarding.",
  sshForwardIgnored: (ports: string[]) =>
    ports.length === 1
      ? `Ignored port: ${ports[0]}.`
      : `Ignored ports: ${ports.join(", ")}.`,
  sshForwardOpenError: "Unable to open the local URL.",
};

export const sshForwardStringsFr: typeof sshForwardStringsEn = {
  sshForwardPorts: "Ports",
  sshForwardCount: (count: number) => `Ports · ${count}`,
  sshForwardTitle: "Redirections de ports SSH",
  sshForwardDescription: (address: string) =>
    `Redirigez les ports distants de ${address} vers cette machine.`,
  sshForwardInput: "Ports distants",
  sshForwardPlaceholder: "2928 8088:8095",
  sshForwardHint:
    "Séparez les ports par des espaces. Les plages fonctionnent dans les deux sens.",
  sshForwardStart: "Démarrer les redirections",
  sshForwardStop: "Tout arrêter",
  sshForwardEmpty: "Aucune redirection de port active.",
  sshForwardLocalChanged:
    "Le même port local était indisponible ; Soreno en a choisi un de libre.",
  sshForwardOpen: (url: string) => `Ouvrir ${url}`,
  sshForwardLoading: "Chargement des redirections de ports SSH…",
  sshForwardLoadError: "Impossible de lire les redirections de ports SSH.",
  sshForwardStartError:
    "Impossible de démarrer les redirections. Vérifiez les ports saisis et la connexion SSH.",
  sshForwardStopError: "Impossible d’arrêter les redirections de ports.",
  sshForwardIgnored: (ports: string[]) =>
    ports.length === 1
      ? `Port ignoré : ${ports[0]}.`
      : `Ports ignorés : ${ports.join(", ")}.`,
  sshForwardOpenError: "Impossible d’ouvrir l’URL locale.",
};
