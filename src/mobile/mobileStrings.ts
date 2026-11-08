import type { InstallGuide } from "./installHint";

const fr = {
  appName: "Soreno",
  loading: "Chargement…",
  empty:
    "Aucune session en cours. Lancez un agent depuis Soreno sur un serveur appairé ; il apparaîtra ici.",
  unreadTitle: "Terminées · non lues",
  hostOnline: "En ligne",
  hostOffline: "Injoignable",
  hostConnecting: "Connexion…",
  hostUnpaired: "Appareil retiré",
  hostOfflineBody:
    "Ce serveur n’est pas relié au relais Soreno pour l’instant. Ses sessions s’ouvriront dès son retour.",
  hostUnpairedBody:
    "Ce téléphone a été retiré des appareils de ce serveur dans Soreno. Oubliez-le ici, ou appairez ce téléphone de nouveau.",
  serverActions: (host: string) => `Actions pour ${host}`,
  forgetServer: "Oublier ce serveur",
  forgetConfirm: (host: string) =>
    `Oublier ${host} ? Il faudra appairer ce téléphone de nouveau pour suivre ses sessions.`,
  noServersTitle: "Aucun serveur appairé",
  noServersBody:
    "Dans Soreno sur l’ordinateur, ouvrez Mobile sur un projet SSH et touchez Appairer un téléphone, puis scannez le QR code avec l’appareil photo ou le bouton ci-dessous.",
  storeFailedTitle: "Stockage indisponible",
  storeFailedBody:
    "Ce navigateur refuse de garder les serveurs appairés, par exemple en navigation privée.",
  oldBrowserTitle: "Navigateur trop ancien",
  oldBrowserBody:
    "Ce navigateur ne sait pas chiffrer la connexion avec vos serveurs. Mettez à jour le téléphone ou utilisez un navigateur récent (Safari 17, Chrome 133, Firefox 130 ou plus).",
  scanQr: "Scanner un QR code",
  scanHint: "Visez le QR code affiché par Soreno sur l’ordinateur.",
  scanForeign: "Ce QR code n’est pas un code d’appairage de Soreno.",
  cameraDenied:
    "Accès à la caméra refusé. Autorisez la caméra pour ce site dans les réglages du navigateur, ou scannez le QR code avec l’appareil photo.",
  cameraUnavailable: "Aucune caméra utilisable sur cet appareil.",
  cancel: "Annuler",
  pairingProgress: "Appairage en cours…",
  pairingExpiredTitle: "Code expiré ou déjà utilisé",
  pairingExpiredBody:
    "Un QR code d’appairage ne sert qu’une fois, pendant 10 minutes. Dans Soreno sur l’ordinateur, touchez de nouveau Appairer un téléphone.",
  pairingThrottledTitle: "Trop de tentatives",
  pairingThrottledBody:
    "Ce serveur limite les essais d’appairage. Patientez quelques secondes, puis réessayez.",
  pairingOfflineTitle: "Serveur hors ligne",
  pairingOfflineBody:
    "Ce serveur n’est pas relié au relais Soreno. Vérifiez dans Soreno que l’accès mobile est actif, puis réessayez.",
  pairingFailedTitle: "Appairage impossible",
  pairingFailedBody:
    "La connexion au serveur a échoué. Réessayez dans un instant.",
  pairingInvalidTitle: "Lien d’appairage incomplet",
  pairingInvalidBody:
    "Scannez de nouveau le QR code affiché par Soreno sur l’ordinateur.",
  pairedTitle: (host: string) => `Téléphone appairé à ${host}`,
  pairedIosInstall:
    "Pour l’installer : Partager → Sur l’écran d’accueil, puis ouvrez l’app et scannez de nouveau un QR code depuis Soreno (Appairer un téléphone).",
  showSessions: "Voir les sessions",
  backToServers: "Retour",
  sessionCount: (count: number) =>
    count <= 1 ? `${count} session` : `${count} sessions`,
  installTitle: {
    installedIos: "Soreno est déjà installée",
    installedAndroid: "Soreno est déjà installée",
    android: "Ajouter Soreno à l’écran d’accueil",
    ios: "Ajouter Soreno à l’écran d’accueil",
    other: "Ajouter Soreno à l’écran d’accueil",
  },
  installSteps: {
    installedIos: [
      "Pour remettre son icône : balayez l’écran d’accueil vers la gauche jusqu’à la dernière page, la Bibliothèque d’apps, appuyez longuement sur Soreno, puis touchez « Ajouter à l’écran d’accueil ».",
    ],
    installedAndroid: [
      "Pour remettre son icône : balayez vers le haut depuis l’écran d’accueil, appuyez longuement sur Soreno, puis faites-la glisser sur l’écran d’accueil.",
    ],
    android: [
      "Copiez l’adresse ci-dessous et ouvrez-la dans Chrome (une page ouverte depuis le QR code ne peut pas être installée).",
      "Dans Chrome, touchez ⋮, puis « Installer l’application » ou « Ajouter à l’écran d’accueil ».",
      "Rien de tel dans le menu ? Soreno est sans doute déjà installée : cherchez-la dans la liste des applis, appuyez longuement dessus et glissez-la sur l’écran d’accueil.",
    ],
    ios: [
      "Copiez l’adresse ci-dessous et ouvrez-la dans Safari.",
      "Touchez Partager, puis « Sur l’écran d’accueil ».",
      "Ouvrez l’app depuis l’écran d’accueil et scannez de nouveau un QR code depuis Soreno (Appairer un téléphone) : elle ne voit pas les serveurs appairés dans Safari.",
    ],
    other: [
      "Ouvrez l’adresse ci-dessous dans le navigateur du téléphone, puis ajoutez-la à l’écran d’accueil depuis son menu.",
    ],
  } satisfies Record<InstallGuide, string[]>,
  copyAddress: "Copier l’adresse",
  addressCopied: "Adresse copiée",
  installDismiss: "Fermer",
  moreActions: "Plus d’actions",
  installApp: "Ajouter à l’écran d’accueil",
  reload: "Actualiser",
  hideTools: "Masquer les outils",
  showTools: "Afficher les outils",
  stateAwaiting: "Réponse attendue",
  stateWorking: "En cours",
  stateUnread: "Terminé · non lu",
  stateActive: "Active",
  attached: "Client connecté",
  retry: "Réessayer",
  back: "Retour aux sessions",
  connecting: "Connexion…",
  reconnecting: "Connexion perdue, nouvel essai…",
  loadingConversation: "Chargement de la conversation…",
  ended: "Session terminée.",
  gone: "Cette session n’existe plus.",
  unpaired: "Ce téléphone n’est plus autorisé sur ce serveur.",
  scrollBottom: "Revenir en bas",
  messagePlaceholder: "Message",
  messageLabel: "Message à envoyer",
  send: "Envoyer",
  attachImage: "Joindre une image",
  attachingImage: "Envoi de l’image…",
  imageUnsupported: "Ce fichier n’est pas une image lisible.",
  imageTooLarge: "Image trop lourde, même réduite (4 Mo au plus).",
  imageFailed: "L’image n’a pas pu être envoyée au serveur.",
  conversationLabel: "Conversation",
  conversationScroller: "Historique de la conversation",
  noConversationTitle: "Pas de conversation pour cette session",
  noConversationBody:
    "Cette session n’a pas d’historique d’agent lisible ici. Son terminal n’est visible que dans Soreno sur l’ordinateur.",
  noConversationShort: "Sans conversation",
  deletedConversationTitle: "Conversation supprimée",
  deletedConversationBody:
    "L’historique de cette conversation a été supprimé alors que l’agent tourne encore. Son terminal n’est visible que dans Soreno sur l’ordinateur.",
  deletedConversationShort: "Conversation supprimée",
  conversationEmpty: "Aucun message pour l’instant.",
  conversationTruncated: "Les messages plus anciens ne sont pas affichés.",
  agentWorking: "Réflexion…",
  awaitingReply: "Réponse attendue : répondez depuis Soreno sur l’ordinateur",
  textTruncated: "Message tronqué",
  noOutput: "Aucune sortie",
  toolFailed: "Échec",
  images: (count: number) => (count <= 1 ? "1 image" : `${count} images`),
  toolActions: {
    read: "a lu",
    edit: "a modifié",
    write: "a écrit",
    run: "a lancé",
    search: "a cherché",
    web: "a consulté",
    agent: "a délégué",
    ask: "a demandé",
  },
  toolOther: (name: string) => `a utilisé ${name}`,
};

export type MobileStrings = typeof fr;

const en: MobileStrings = {
  appName: "Soreno",
  loading: "Loading…",
  empty:
    "No session running. Start an agent from Soreno on a paired server; it will show up here.",
  unreadTitle: "Finished · unread",
  hostOnline: "Online",
  hostOffline: "Unreachable",
  hostConnecting: "Connecting…",
  hostUnpaired: "Device removed",
  hostOfflineBody:
    "This server is not linked to the Soreno relay right now. Its sessions will open again once it is back.",
  hostUnpairedBody:
    "This phone was removed from this server’s devices in Soreno. Forget it here, or pair this phone again.",
  serverActions: (host: string) => `Actions for ${host}`,
  forgetServer: "Forget this server",
  forgetConfirm: (host: string) =>
    `Forget ${host}? This phone will have to be paired again to follow its sessions.`,
  noServersTitle: "No paired server",
  noServersBody:
    "In Soreno on the computer, open Mobile on an SSH project and tap Pair a phone, then scan the QR code with the camera or the button below.",
  storeFailedTitle: "Storage unavailable",
  storeFailedBody:
    "This browser refuses to keep the paired servers, for instance in private browsing.",
  oldBrowserTitle: "Browser too old",
  oldBrowserBody:
    "This browser cannot encrypt the connection with your servers. Update the phone or use a recent browser (Safari 17, Chrome 133, Firefox 130 or later).",
  scanQr: "Scan a QR code",
  scanHint: "Aim at the QR code shown by Soreno on the computer.",
  scanForeign: "This QR code is not a Soreno pairing code.",
  cameraDenied:
    "Camera access denied. Allow the camera for this site in the browser settings, or scan the QR code with the camera app.",
  cameraUnavailable: "No usable camera on this device.",
  cancel: "Cancel",
  pairingProgress: "Pairing…",
  pairingExpiredTitle: "Code expired or already used",
  pairingExpiredBody:
    "A pairing QR code works once, for 10 minutes. In Soreno on the computer, tap Pair a phone again.",
  pairingThrottledTitle: "Too many attempts",
  pairingThrottledBody:
    "This server limits pairing attempts. Wait a few seconds, then try again.",
  pairingOfflineTitle: "Server offline",
  pairingOfflineBody:
    "This server is not linked to the Soreno relay. Check in Soreno that mobile access is on, then try again.",
  pairingFailedTitle: "Pairing failed",
  pairingFailedBody:
    "The connection to the server failed. Try again in a moment.",
  pairingInvalidTitle: "Incomplete pairing link",
  pairingInvalidBody: "Scan the QR code shown by Soreno on the computer again.",
  pairedTitle: (host: string) => `Phone paired with ${host}`,
  pairedIosInstall:
    "To install it: Share → Add to Home Screen, then open the app and scan a QR code from Soreno again (Pair a phone).",
  showSessions: "Show sessions",
  backToServers: "Back",
  sessionCount: (count: number) =>
    count === 1 ? "1 session" : `${count} sessions`,
  installTitle: {
    installedIos: "Soreno is already installed",
    installedAndroid: "Soreno is already installed",
    android: "Add Soreno to the home screen",
    ios: "Add Soreno to the home screen",
    other: "Add Soreno to the home screen",
  },
  installSteps: {
    installedIos: [
      "To put its icon back: swipe left on the home screen to the last page, the App Library, touch and hold Soreno, then tap “Add to Home Screen”.",
    ],
    installedAndroid: [
      "To put its icon back: swipe up from the home screen, touch and hold Soreno, then drag it onto the home screen.",
    ],
    android: [
      "Copy the address below and open it in Chrome (a page opened from the QR code cannot be installed).",
      "In Chrome, tap ⋮, then “Install app” or “Add to Home screen”.",
      "Nothing like that in the menu? Soreno is probably installed already: find it in the app list, touch and hold it, and drag it onto the home screen.",
    ],
    ios: [
      "Copy the address below and open it in Safari.",
      "Tap Share, then “Add to Home Screen”.",
      "Open the app from the home screen and scan a QR code from Soreno again (Pair a phone): it does not see the servers paired in Safari.",
    ],
    other: [
      "Open the address below in the phone’s browser, then add it to the home screen from its menu.",
    ],
  },
  copyAddress: "Copy the address",
  addressCopied: "Address copied",
  installDismiss: "Close",
  moreActions: "More actions",
  installApp: "Add to home screen",
  reload: "Refresh",
  hideTools: "Hide tools",
  showTools: "Show tools",
  stateAwaiting: "Reply expected",
  stateWorking: "Working",
  stateUnread: "Finished · unread",
  stateActive: "Active",
  attached: "Client attached",
  retry: "Try again",
  back: "Back to sessions",
  connecting: "Connecting…",
  reconnecting: "Connection lost, retrying…",
  loadingConversation: "Loading the conversation…",
  ended: "Session ended.",
  gone: "This session no longer exists.",
  unpaired: "This phone is no longer allowed on this server.",
  scrollBottom: "Back to bottom",
  messagePlaceholder: "Message",
  messageLabel: "Message to send",
  send: "Send",
  attachImage: "Attach an image",
  attachingImage: "Sending the image…",
  imageUnsupported: "This file is not a readable image.",
  imageTooLarge: "Image too large, even reduced (4 MB at most).",
  imageFailed: "The image could not be sent to the server.",
  conversationLabel: "Conversation",
  conversationScroller: "Conversation history",
  noConversationTitle: "No conversation for this session",
  noConversationBody:
    "This session has no agent history readable here. Its terminal is only visible in Soreno on the computer.",
  noConversationShort: "No conversation",
  deletedConversationTitle: "Conversation deleted",
  deletedConversationBody:
    "This conversation’s history was deleted while the agent is still running. Its terminal is only visible in Soreno on the computer.",
  deletedConversationShort: "Conversation deleted",
  conversationEmpty: "No messages yet.",
  conversationTruncated: "Older messages are not shown.",
  agentWorking: "Thinking…",
  awaitingReply: "Reply expected: answer from Soreno on the computer",
  textTruncated: "Message truncated",
  noOutput: "No output",
  toolFailed: "Failed",
  images: (count: number) => (count === 1 ? "1 image" : `${count} images`),
  toolActions: {
    read: "read",
    edit: "edited",
    write: "wrote",
    run: "ran",
    search: "searched",
    web: "fetched",
    agent: "delegated",
    ask: "asked",
  },
  toolOther: (name: string) => `used ${name}`,
};

export function mobileLocale(language: string | undefined): "fr" | "en" {
  if (!language) return "fr";
  return language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const mobileStrings = { fr, en };
