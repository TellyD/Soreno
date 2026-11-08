import type {
  ForgeCheck,
  ForgeFilter,
  ForgeKind,
  ForgeMergeBlocker,
  ForgeMergeMethod,
  ForgeReviewer,
  ForgeState,
  ForgeStateError,
} from "../../domain/forge";

export const forgeStringsEn = {
  forgeRequests: (kind: ForgeKind | null) =>
    kind === "gitlab" ? "Merge requests" : "Pull requests",
  forgeFilterLabel: "Filter",
  forgeFilters: {
    open: "Open",
    mine: "Mine",
    review: "Review requested",
    closed: "Closed / merged",
  } satisfies Record<ForgeFilter, string>,
  forgeSearch: "Search",
  forgeSearchHide: "Hide search",
  forgeSearchPlaceholder: "Search (Enter)",
  refreshForge: "Refresh",
  forgeLoading: "Reading…",
  forgeListReadError: (kind: ForgeKind | null): string =>
    kind === "gitlab"
      ? "Unable to read the merge requests."
      : "Unable to read the pull requests.",
  forgeEmpty: (kind: ForgeKind | null): string =>
    kind === "gitlab" ? "No merge requests." : "No pull requests.",
  forgeChoose: (kind: ForgeKind | null): string =>
    kind === "gitlab"
      ? "Select a merge request to view its details."
      : "Select a pull request to view its details.",
  forgeStates: {
    open: "Open",
    closed: "Closed",
    merged: "Merged",
  } satisfies Record<ForgeState, string>,
  forgeDraft: "Draft",
  forgeCurrentBranch: "Current branch",
  forgeChecks: {
    success: "Checks passed",
    failure: "Checks failed",
    pending: "Checks pending",
  },
  forgeReview: {
    approved: "Approved",
    changesRequested: "Changes requested",
    reviewRequired: "Review required",
  },
  forgeConflicts: "Conflicts",
  forgeReviewers: "Reviewers",
  forgeLabels: "Labels",
  forgeReviewerStates: {
    requested: "requested",
    approved: "approved",
    changesRequested: "changes requested",
    commented: "commented",
  } satisfies Record<ForgeReviewer["state"], string>,
  forgeDetailTabs: "Details",
  forgeTabs: {
    description: "Description",
    checks: "Checks",
    commits: "Commits",
    files: "Files",
  },
  forgeNoDescription: "No description.",
  forgeNoChecks: "No checks.",
  forgeNoCommits: "No commits.",
  forgeNoFiles: "No changed files.",
  forgeChangesLoading: "Reading changes…",
  forgeCheckStatus: {
    success: "Success",
    failure: "Failure",
    pending: "Pending",
    skipped: "Skipped",
    neutral: "Neutral",
  } satisfies Record<ForgeCheck["status"], string>,
  forgeMerge: "Merge",
  forgeMergeTitle: (number: number) => `Merge #${number}`,
  forgeMergeDescription: (
    source: string,
    target: string,
    deleteSource: boolean,
  ) =>
    `${source} will be merged into ${target}. ${deleteSource ? "The source branch will be deleted." : "The source branch will be kept."}`,
  forgeMergeUnverified: (checks: "failure" | "pending"): string =>
    checks === "failure"
      ? "The latest checks failed: these changes are not verified. Run them again before merging if you can."
      : "Checks are still running: these changes are not verified yet.",
  forgeMergeUnverifiedConfirm: "Merge unverified changes",
  forgeMergeMethod: "Method",
  forgeMergeMethods: {
    merge: "Merge commit",
    squash: "Squash and merge",
    rebase: "Rebase and merge",
  } satisfies Record<ForgeMergeMethod, string>,
  forgeMergeBlocked: (reasons: string) => `Cannot merge: ${reasons}.`,
  forgeBlockers: {
    draft: "draft",
    conflicts: "conflicts",
    checks: "checks not passing",
    approvals: "approvals missing",
    behind: "branch behind its target",
    unknown: "mergeability still being computed",
    blocked: "blocked by a repository rule",
  } satisfies Record<ForgeMergeBlocker, string>,
  forgeCheckoutWorktree: "Check out in a new worktree",
  forgeCheckoutHere: "Check out in this worktree",
  forgeCheckoutDirty: "Checking out here requires a worktree without changes.",
  forgeOpenBrowser: "Open in browser",
  forgeClose: "Close",
  forgeReopen: "Reopen",
  forgeReady: "Mark as ready",
  forgeRateLimitedNotice:
    "API rate limit reached: the last known state is shown.",
  forgeNetworkNotice: "Network unavailable: the last known state is shown.",
  forgeStateErrors: (
    kind: ForgeKind | null,
  ): Record<ForgeStateError, { title: string; description: string }> => {
    const name = kind === "gitlab" ? "GitLab" : "GitHub";
    const cli = kind === "gitlab" ? "glab" : "gh";
    return {
      noRemote: {
        title: "No remote",
        description: "Add an upstream or origin remote to list its requests.",
      },
      unrecognizedRemote: {
        title: "Unrecognized remote",
        description: "The remote URL does not name a repository.",
      },
      unsupportedForge: {
        title: "Unsupported forge",
        description: "Only github.com and gitlab.com are supported.",
      },
      cliMissing: {
        title: `${cli} not found`,
        description: `Install the ${name} CLI (${cli}) in the project environment, then sign in.`,
      },
      unauthenticated: {
        title: `Not signed in to ${name}`,
        description: `Sign in with ${cli} in a terminal to list requests.`,
      },
      forbidden: {
        title: "Access denied",
        description: `Your ${name} account cannot access this repository.`,
      },
      network: {
        title: "Network unavailable",
        description: `${name} cannot be reached.`,
      },
      rateLimited: {
        title: "Rate limit reached",
        description: `The ${name} API refuses requests for now. Try again later.`,
      },
    };
  },
  forgeLogin: (kind: ForgeKind) =>
    `Sign in to ${kind === "gitlab" ? "GitLab" : "GitHub"}`,
  forgeLoginSessionName: (kind: ForgeKind) =>
    `${kind === "gitlab" ? "GitLab" : "GitHub"} sign-in`,
};

export const forgeStringsFr: typeof forgeStringsEn = {
  forgeRequests: (kind: ForgeKind | null) =>
    kind === "gitlab" ? "Merge requests" : "Pull requests",
  forgeFilterLabel: "Filtre",
  forgeFilters: {
    open: "Ouvertes",
    mine: "Les miennes",
    review: "Revue demandée",
    closed: "Fermées / mergées",
  },
  forgeSearch: "Rechercher",
  forgeSearchHide: "Masquer la recherche",
  forgeSearchPlaceholder: "Rechercher (Entrée)",
  refreshForge: "Actualiser",
  forgeLoading: "Lecture…",
  forgeListReadError: (kind: ForgeKind | null) =>
    kind === "gitlab"
      ? "Lecture des merge requests impossible."
      : "Lecture des pull requests impossible.",
  forgeEmpty: (kind: ForgeKind | null) =>
    kind === "gitlab" ? "Aucune merge request." : "Aucune pull request.",
  forgeChoose: (kind: ForgeKind | null) =>
    kind === "gitlab"
      ? "Sélectionnez une merge request pour voir son détail."
      : "Sélectionnez une pull request pour voir son détail.",
  forgeStates: {
    open: "Ouverte",
    closed: "Fermée",
    merged: "Mergée",
  },
  forgeDraft: "Brouillon",
  forgeCurrentBranch: "Branche courante",
  forgeChecks: {
    success: "Checks réussis",
    failure: "Checks en échec",
    pending: "Checks en cours",
  },
  forgeReview: {
    approved: "Approuvée",
    changesRequested: "Modifications demandées",
    reviewRequired: "Revue requise",
  },
  forgeConflicts: "Conflits",
  forgeReviewers: "Reviewers",
  forgeLabels: "Labels",
  forgeReviewerStates: {
    requested: "demandée",
    approved: "approuvée",
    changesRequested: "modifications demandées",
    commented: "a commenté",
  },
  forgeDetailTabs: "Détail",
  forgeTabs: {
    description: "Description",
    checks: "Checks",
    commits: "Commits",
    files: "Fichiers",
  },
  forgeNoDescription: "Aucune description.",
  forgeNoChecks: "Aucun check.",
  forgeNoCommits: "Aucun commit.",
  forgeNoFiles: "Aucun fichier modifié.",
  forgeChangesLoading: "Lecture des changements…",
  forgeCheckStatus: {
    success: "Réussi",
    failure: "Échec",
    pending: "En cours",
    skipped: "Ignoré",
    neutral: "Neutre",
  },
  forgeMerge: "Merger",
  forgeMergeTitle: (number: number) => `Merger #${number}`,
  forgeMergeDescription: (
    source: string,
    target: string,
    deleteSource: boolean,
  ) =>
    `${source} sera mergée dans ${target}. ${deleteSource ? "La branche source sera supprimée." : "La branche source sera conservée."}`,
  forgeMergeUnverified: (checks: "failure" | "pending") =>
    checks === "failure"
      ? "Les derniers checks ont échoué : ces changements ne sont pas vérifiés. Relancez-les avant de merger si possible."
      : "Les checks sont encore en cours : ces changements ne sont pas encore vérifiés.",
  forgeMergeUnverifiedConfirm: "Merger sans vérification",
  forgeMergeMethod: "Méthode",
  forgeMergeMethods: {
    merge: "Commit de merge",
    squash: "Squash and merge",
    rebase: "Rebase and merge",
  },
  forgeMergeBlocked: (reasons: string) => `Merge impossible : ${reasons}.`,
  forgeBlockers: {
    draft: "brouillon",
    conflicts: "conflits",
    checks: "checks non réussis",
    approvals: "approbations manquantes",
    behind: "branche en retard sur la cible",
    unknown: "mergeabilité en cours de calcul",
    blocked: "bloquée par une règle du dépôt",
  },
  forgeCheckoutWorktree: "Checkout dans un nouveau worktree",
  forgeCheckoutHere: "Checkout dans ce worktree",
  forgeCheckoutDirty:
    "Le checkout ici exige un worktree sans modifications en cours.",
  forgeOpenBrowser: "Ouvrir dans le navigateur",
  forgeClose: "Fermer",
  forgeReopen: "Rouvrir",
  forgeReady: "Marquer comme prête",
  forgeRateLimitedNotice:
    "Limite de l’API atteinte : le dernier état connu est affiché.",
  forgeNetworkNotice:
    "Réseau indisponible : le dernier état connu est affiché.",
  forgeStateErrors: (kind: ForgeKind | null) => {
    const name = kind === "gitlab" ? "GitLab" : "GitHub";
    const cli = kind === "gitlab" ? "glab" : "gh";
    return {
      noRemote: {
        title: "Aucun remote",
        description:
          "Ajoutez un remote upstream ou origin pour lister ses demandes.",
      },
      unrecognizedRemote: {
        title: "Remote non reconnu",
        description: "L’URL du remote ne désigne pas un dépôt.",
      },
      unsupportedForge: {
        title: "Forge non prise en charge",
        description: "Seuls github.com et gitlab.com sont pris en charge.",
      },
      cliMissing: {
        title: `${cli} introuvable`,
        description: `Installez la CLI ${name} (${cli}) dans l’environnement du projet, puis connectez-vous.`,
      },
      unauthenticated: {
        title: `Non connecté à ${name}`,
        description: `Connectez-vous avec ${cli} dans un terminal pour lister les demandes.`,
      },
      forbidden: {
        title: "Accès refusé",
        description: `Votre compte ${name} n’a pas accès à ce dépôt.`,
      },
      network: {
        title: "Réseau indisponible",
        description: `${name} est injoignable.`,
      },
      rateLimited: {
        title: "Limite de l’API atteinte",
        description: `L’API ${name} refuse les requêtes pour l’instant. Réessayez plus tard.`,
      },
    };
  },
  forgeLogin: (kind: ForgeKind) =>
    `Se connecter à ${kind === "gitlab" ? "GitLab" : "GitHub"}`,
  forgeLoginSessionName: (kind: ForgeKind) =>
    `Connexion ${kind === "gitlab" ? "GitLab" : "GitHub"}`,
};
