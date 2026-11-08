import type { AgentConversationAttachmentRefusal } from "../../domain/agentConversationAttachments";

// OMP names a tool `__proto__` as easily as `bash`: only the table's own keys count.
export const label = (table: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;

export const agentConversationStringsEn = {
  label: (name: string) => `Conversation · ${name}`,
  emptyTitle: "What should OMP do?",
  emptyBody:
    "OMP works in this project’s folder with your models and settings.",
  updateAvailable: (version: string) => `OMP ${version} is available.`,
  update: "Update OMP",
  updating: "Updating OMP…",
  updateError: (message: string) => `OMP update failed: ${message}`,
  updated: (version: string) => `OMP ${version} is installed.`,
  showChangelog: "See what’s new",
  placeholder: "Message OMP…",
  placeholderBusy: "Steer the current step…",
  send: "Send",
  stop: "Stop",
  stopHint: "Stop the current step (Esc)",
  stopBackground: "Stop background jobs (Esc)",
  background: "Background jobs running…",
  starting: "Starting OMP…",
  working: "Working…",
  compacting: "Summarizing earlier messages…",
  elapsed: (seconds: number) =>
    seconds < 60
      ? `${seconds} s`
      : `${Math.floor(seconds / 60)} min ${seconds % 60} s`,
  idle: "This conversation is not running.",
  stopped: "This conversation is stopped.",
  start: "Start OMP",
  resume: "Resume the conversation",
  crashed: (code: number | null) =>
    code === null
      ? "OMP stopped unexpectedly."
      : `OMP stopped unexpectedly (code ${code}).`,
  connectionLost: "The connection to the remote machine was lost.",
  queued: "Waiting for the current step",
  removeQueued: "Cancel this message",
  restoreIncomplete: "Some queued messages or images could not be restored.",
  reasoning: "Reasoning",
  aborted: "Stopped.",
  retry: (attempt: number, maxAttempts: number, message: string) =>
    `Retrying (${attempt}/${maxAttempts})${message ? ` after: ${message}` : ""}…`,
  compacted: (before: number | null, after: number | null) =>
    `Earlier messages were summarized so the conversation can continue${
      before === null
        ? ""
        : after === null
          ? ` (${Math.round(before / 1000)}k tokens before)`
          : ` (${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens)`
    }.`,
  goalStatuses: {
    active: "active",
    paused: "paused",
    "budget-limited": "budget reached",
    complete: "complete",
    dropped: "dropped",
  } as Record<string, string>,
  goal: (objective: string, status: string) => `Goal (${status}): ${objective}`,
  noGoal: "No goal for this session.",
  goalIndicator: (status: string) => `Goal: ${status}`,
  commandAttachments: (command: string) =>
    `${command} takes no attachments: remove them or send them in another message.`,
  btw: "Side question",
  btwHistory: "Side questions",
  btwEmpty: "No side questions yet. Type /btw and a question to ask one.",
  btwOpenHistory: "All side questions",
  btwOpen: (question: string) => `Open “${question}”`,
  btwStop: "Stop the side question",
  btwClose: "Close the side questions",
  btwFollowUp: "Follow up…",
  btwWaiting: "Thinking…",
  btwStatus: {
    cancelled: "Stopped.",
    interrupted: "Interrupted: OMP stopped meanwhile.",
    error: "Failed.",
  } as Record<string, string>,
  btwTurns: (count: number) =>
    count === 1 ? "1 question" : `${count} questions`,
  messageActions: "Message actions",
  copy: "Copy",
  copied: "Copied",
  copyFailed: (message: string) => `Unable to copy: ${message}`,
  toolName: (tool: string) =>
    label(
      {
        bash: "Command",
        eval: "Code",
        read: "Read",
        edit: "Edit",
        write: "Write",
        grep: "Search",
        find: "Find files",
        search: "Search",
        ls: "List",
        task: "Agents",
        wait: "Waiting for agents",
        todo: "Tasks",
        ask: "Question",
        web_search: "Web search",
        fetch: "Web page",
        browser: "Browser",
      },
      tool,
    ),
  toolPreparing: "Preparing a tool…",
  subagents: "Agents",
  subagentMeta: (
    status: string,
    tools: number,
    tokens: number,
    ms: number | null,
  ) =>
    [
      (
        { completed: "Done", failed: "Failed", aborted: "Stopped" } as Record<
          string,
          string
        >
      )[status],
      tools ? `${tools} tool${tools === 1 ? "" : "s"}` : null,
      tokens ? `${(tokens / 1000).toFixed(1)}k tokens` : null,
      ms !== null
        ? ms < 60_000
          ? `${Math.round(ms / 1000)} s`
          : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  stopSubagent: (name: string) => `Stop ${name}`,
  todos: "Tasks",
  todosClose: "Hide the finished tasks",
  todoStatus: {
    pending: "To do",
    in_progress: "In progress",
    completed: "Done",
    abandoned: "Dropped",
    blocked: "Blocked",
  },
  toolAwaiting: "Waiting for your approval",
  toolAnswering: "Waiting for your answer",
  toolStatus: {
    pending: "Waiting",
    running: "Running",
    done: "Done",
    error: "Failed",
  },
  duration: (ms: number) =>
    ms < 10_000
      ? `${(ms / 1000).toFixed(1)} s`
      : ms < 60_000
        ? `${Math.round(ms / 1000)} s`
        : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`,
  moreLines: (count: number) => `… ${count} more line${count === 1 ? "" : "s"}`,
  approvalTitle: (tool: string) =>
    tool === "bash"
      ? "OMP wants to run this command"
      : tool === "edit"
        ? "OMP wants to edit a file"
        : tool === "write"
          ? "OMP wants to write a file"
          : `OMP wants to use ${tool}`,
  approvalChoice: (option: string) =>
    label({ Approve: "Allow", Deny: "Deny" }, option),
  enterKey: "Enter",
  escapeKey: "Esc",
  dialogsWaiting: (count: number) =>
    count === 1 ? "1 more request" : `${count} more requests`,
  dialogConfirm: "Yes",
  dialogDecline: "No",
  dialogSubmit: "Send",
  dialogCancel: "Dismiss",
  askTitle: "OMP has questions",
  askSubmit: "Answer",
  askCustom: (question: string) => `Other answer to: ${question}`,
  askCustomPlaceholder: "Other answer…",
  askRecommended: "Recommended",
  attach: "Attach files",
  attachments: "Attachments",
  previewAttachment: (name: string) => `Preview ${name}`,
  removeAttachment: (name: string) => `Remove ${name}`,
  mentionFiles: "Project files",
  commands: "Commands",
  dropFiles: "Drop files to attach them",
  attachmentRefused: (refusal: AgentConversationAttachmentRefusal) =>
    refusal.reason === "count"
      ? "At most 16 attachments per message."
      : refusal.reason === "size"
        ? `${refusal.name}: images are limited to 20 MB per message.`
        : `${refusal.name}: this model does not read images.`,
  attachmentTooLarge: (name: string) => `${name}: files are limited to 32 MiB.`,
  attachmentSending: (name: string) => `Attaching ${name}…`,
  cancelAttachment: (name: string) => `Cancel ${name}`,
  image: (index: number) => `Image #${index}`,
  model: "Model",
  modelSearch: "Search models",
  noModel: "No matching model",
  thinking: "Reasoning",
  thinkingLevels: {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Very high",
    max: "Maximum",
  } as Record<string, string>,
  context: (percent: number) => `Context ${Math.round(percent)}%`,
  contextTitle: (
    tokens: number,
    window: number,
    total: number,
    cost: number | null,
  ) =>
    `${tokens.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens in the context. ${total.toLocaleString("en-US")} tokens used by this conversation${cost ? ` (about $${cost.toFixed(2)})` : ""}.`,
  moreActions: "More actions",
  newConversation: "New conversation",
  resumeConversation: "Resume a conversation…",
  hideTools: "Hide tools and reasoning",
  resumeTitle: "Resume a conversation",
  resumeSearch: "Search conversations",
  resumeLoading: "Loading conversations…",
  resumeEmpty: "No earlier OMP conversation in this project.",
  resumeNoMatch: "No conversation matches this search.",
  resumeUntitled: "Untitled conversation",
  resumeCurrent: "Current",
  resumeMore: "Load older conversations",
  resumeCancelled:
    "OMP did not open this conversation: it was started in another folder.",
};

export const agentConversationStringsFr: typeof agentConversationStringsEn = {
  label: (name: string) => `Conversation · ${name}`,
  emptyTitle: "Que doit faire OMP ?",
  emptyBody:
    "OMP travaille dans le dossier de ce projet avec vos modèles et vos réglages.",
  updateAvailable: (version: string) => `OMP ${version} est disponible.`,
  update: "Mettre à jour OMP",
  updating: "Mise à jour d’OMP…",
  updateError: (message: string) =>
    `Échec de la mise à jour d’OMP : ${message}`,
  updated: (version: string) => `OMP ${version} est installé.`,
  showChangelog: "Voir les nouveautés",
  placeholder: "Message pour OMP…",
  placeholderBusy: "Réorienter l’étape en cours…",
  send: "Envoyer",
  stop: "Arrêter",
  stopHint: "Arrêter l’étape en cours (Échap)",
  stopBackground: "Arrêter les tâches en arrière-plan (Échap)",
  background: "Tâches en arrière-plan…",
  starting: "Démarrage d’OMP…",
  working: "Au travail…",
  compacting: "Résumé des messages précédents…",
  elapsed: (seconds: number) =>
    seconds < 60
      ? `${seconds} s`
      : `${Math.floor(seconds / 60)} min ${seconds % 60} s`,
  idle: "Cette conversation n’est pas démarrée.",
  stopped: "Cette conversation est arrêtée.",
  start: "Démarrer OMP",
  resume: "Reprendre la conversation",
  crashed: (code: number | null) =>
    code === null
      ? "OMP s’est arrêté de façon inattendue."
      : `OMP s’est arrêté de façon inattendue (code ${code}).`,
  connectionLost: "La connexion à la machine distante a été perdue.",
  queued: "En attente de l’étape en cours",
  removeQueued: "Annuler ce message",
  restoreIncomplete:
    "Certains messages en attente ou leurs images n’ont pas pu être restitués.",
  reasoning: "Raisonnement",
  aborted: "Arrêté.",
  retry: (attempt: number, maxAttempts: number, message: string) =>
    `Nouvelle tentative (${attempt}/${maxAttempts})${message ? ` après : ${message}` : ""}…`,
  compacted: (before: number | null, after: number | null) =>
    `Les messages précédents ont été résumés pour poursuivre la conversation${
      before === null
        ? ""
        : after === null
          ? ` (${Math.round(before / 1000)} k jetons avant)`
          : ` (${Math.round(before / 1000)} k → ${Math.round(after / 1000)} k jetons)`
    }.`,
  goalStatuses: {
    active: "actif",
    paused: "en pause",
    "budget-limited": "budget atteint",
    complete: "atteint",
    dropped: "abandonné",
  } as Record<string, string>,
  goal: (objective: string, status: string) =>
    `Goal (${status}) : ${objective}`,
  noGoal: "Aucun goal pour cette session.",
  goalIndicator: (status: string) => `Goal : ${status}`,
  commandAttachments: (command: string) =>
    `${command} ne prend pas de pièce jointe : retirez-les ou envoyez-les dans un autre message.`,
  btw: "Question annexe",
  btwHistory: "Questions annexes",
  btwEmpty:
    "Aucune question annexe pour l’instant. Tapez /btw suivi d’une question pour en poser une.",
  btwOpenHistory: "Toutes les questions annexes",
  btwOpen: (question: string) => `Ouvrir « ${question} »`,
  btwStop: "Arrêter la question annexe",
  btwClose: "Fermer les questions annexes",
  btwFollowUp: "Poser une suite…",
  btwWaiting: "Réflexion…",
  btwStatus: {
    cancelled: "Arrêtée.",
    interrupted: "Interrompue : OMP s’est arrêté entre-temps.",
    error: "Échec.",
  } as Record<string, string>,
  btwTurns: (count: number) =>
    count === 1 ? "1 question" : `${count} questions`,
  messageActions: "Actions du message",
  copy: "Copier",
  copied: "Copié",
  copyFailed: (message: string) => `Copie impossible : ${message}`,
  toolName: (tool: string) =>
    label(
      {
        bash: "Commande",
        eval: "Code",
        read: "Lecture",
        edit: "Modification",
        write: "Écriture",
        grep: "Recherche",
        find: "Recherche de fichiers",
        search: "Recherche",
        ls: "Liste",
        task: "Agents",
        wait: "Attente des agents",
        todo: "Tâches",
        ask: "Question",
        web_search: "Recherche web",
        fetch: "Page web",
        browser: "Navigateur",
      },
      tool,
    ),
  toolPreparing: "Préparation d’un outil…",
  subagents: "Agents",
  subagentMeta: (
    status: string,
    tools: number,
    tokens: number,
    ms: number | null,
  ) =>
    [
      (
        {
          completed: "Terminé",
          failed: "Échec",
          aborted: "Arrêté",
        } as Record<string, string>
      )[status],
      tools ? `${tools} outil${tools === 1 ? "" : "s"}` : null,
      tokens
        ? `${(tokens / 1000).toFixed(1).replace(".", ",")} k jetons`
        : null,
      ms !== null
        ? ms < 60_000
          ? `${Math.round(ms / 1000)} s`
          : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  stopSubagent: (name: string) => `Arrêter ${name}`,
  todos: "Tâches",
  todosClose: "Masquer les tâches terminées",
  todoStatus: {
    pending: "À faire",
    in_progress: "En cours",
    completed: "Terminée",
    abandoned: "Abandonnée",
    blocked: "Bloquée",
  },
  toolAwaiting: "Attend votre accord",
  toolAnswering: "Attend votre réponse",
  toolStatus: {
    pending: "En attente",
    running: "En cours",
    done: "Terminé",
    error: "Échec",
  },
  duration: (ms: number) =>
    ms < 10_000
      ? `${(ms / 1000).toFixed(1).replace(".", ",")} s`
      : ms < 60_000
        ? `${Math.round(ms / 1000)} s`
        : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`,
  moreLines: (count: number) =>
    `… ${count} ligne${count === 1 ? "" : "s"} de plus`,
  approvalTitle: (tool: string) =>
    tool === "bash"
      ? "OMP veut lancer cette commande"
      : tool === "edit"
        ? "OMP veut modifier un fichier"
        : tool === "write"
          ? "OMP veut écrire un fichier"
          : `OMP veut utiliser ${tool}`,
  approvalChoice: (option: string) =>
    label({ Approve: "Autoriser", Deny: "Refuser" }, option),
  enterKey: "Entrée",
  escapeKey: "Échap",
  dialogsWaiting: (count: number) =>
    count === 1 ? "1 autre demande" : `${count} autres demandes`,
  dialogConfirm: "Oui",
  dialogDecline: "Non",
  dialogSubmit: "Envoyer",
  dialogCancel: "Ignorer",
  askTitle: "OMP vous pose des questions",
  askSubmit: "Répondre",
  askCustom: (question: string) => `Autre réponse à : ${question}`,
  askCustomPlaceholder: "Autre réponse…",
  askRecommended: "Recommandé",
  attach: "Joindre des fichiers",
  attachments: "Pièces jointes",
  previewAttachment: (name: string) => `Aperçu de ${name}`,
  removeAttachment: (name: string) => `Retirer ${name}`,
  mentionFiles: "Fichiers du projet",
  commands: "Commandes",
  dropFiles: "Déposez des fichiers pour les joindre",
  attachmentRefused: (refusal: AgentConversationAttachmentRefusal) =>
    refusal.reason === "count"
      ? "16 pièces jointes au plus par message."
      : refusal.reason === "size"
        ? `${refusal.name} : images limitées à 20 Mo par message.`
        : `${refusal.name} : ce modèle ne lit pas les images.`,
  attachmentTooLarge: (name: string) =>
    `${name} : chaque fichier est limité à 32 Mio.`,
  attachmentSending: (name: string) => `Envoi de ${name}…`,
  cancelAttachment: (name: string) => `Annuler ${name}`,
  image: (index: number) => `Image #${index}`,
  model: "Modèle",
  modelSearch: "Rechercher un modèle",
  noModel: "Aucun modèle correspondant",
  thinking: "Raisonnement",
  thinkingLevels: {
    off: "Désactivé",
    minimal: "Minimal",
    low: "Faible",
    medium: "Moyen",
    high: "Élevé",
    xhigh: "Très élevé",
    max: "Maximal",
  },
  context: (percent: number) => `Contexte ${Math.round(percent)} %`,
  contextTitle: (
    tokens: number,
    window: number,
    total: number,
    cost: number | null,
  ) =>
    `${tokens.toLocaleString("fr-FR")} jetons sur ${window.toLocaleString("fr-FR")} dans le contexte. ${total.toLocaleString("fr-FR")} jetons utilisés par cette conversation${cost ? ` (environ ${cost.toFixed(2).replace(".", ",")} $)` : ""}.`,
  moreActions: "Plus d’actions",
  newConversation: "Nouvelle conversation",
  resumeConversation: "Reprendre une conversation…",
  hideTools: "Masquer les outils et le raisonnement",
  resumeTitle: "Reprendre une conversation",
  resumeSearch: "Rechercher une conversation",
  resumeLoading: "Chargement des conversations…",
  resumeEmpty: "Aucune conversation OMP antérieure dans ce projet.",
  resumeNoMatch: "Aucune conversation ne correspond à cette recherche.",
  resumeUntitled: "Conversation sans titre",
  resumeCurrent: "Actuelle",
  resumeMore: "Charger les conversations plus anciennes",
  resumeCancelled:
    "OMP n’a pas ouvert cette conversation : elle a été commencée dans un autre dossier.",
};
