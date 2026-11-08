export type NoteTypeId = string;

export type NoteType = {
  id: NoteTypeId;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type NoteTypeNameValidationError = "duplicate" | "empty" | "too-long";

export const defaultNoteTypeId = "notes";
const maxNoteTypeNameLength = 40;

export function validateNoteTypeName(
  name: string,
  noteTypes: NoteType[],
  ignoredId?: NoteTypeId,
): NoteTypeNameValidationError | null {
  const trimmed = name.trim();

  if (!trimmed) {
    return "empty";
  }

  if (trimmed.length > maxNoteTypeNameLength) {
    return "too-long";
  }

  const normalizedName = trimmed.toLocaleLowerCase();
  const hasDuplicate = noteTypes.some((noteType) => {
    return (
      noteType.id !== ignoredId &&
      noteType.name.toLocaleLowerCase() === normalizedName
    );
  });

  return hasDuplicate ? "duplicate" : null;
}

export function findNoteType(
  noteTypes: NoteType[],
  id: NoteTypeId | null,
): NoteType | null {
  return noteTypes.find((noteType) => noteType.id === id) ?? null;
}

export function nextAvailableNoteTypeName(
  noteTypes: NoteType[],
  baseName: string,
  locale = "fr-FR",
): string {
  const existingNames = new Set(
    noteTypes.map((noteType) => noteType.name.toLocaleLowerCase(locale)),
  );

  if (!existingNames.has(baseName.toLocaleLowerCase(locale))) {
    return baseName;
  }

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const name = `${baseName} ${suffix}`;

    if (!existingNames.has(name.toLocaleLowerCase(locale))) {
      return name;
    }
  }

  return `${baseName} ${Date.now()}`;
}

export function getFallbackNoteType(noteTypes: NoteType[]): NoteType | null {
  return (
    [...noteTypes].sort((left, right) => left.sortOrder - right.sortOrder)[0] ??
    null
  );
}

export function moveNoteType(
  noteTypes: NoteType[],
  movedId: NoteTypeId,
  targetIndex: number,
): NoteType[] {
  const movedType = findNoteType(noteTypes, movedId);

  if (!movedType) {
    return noteTypes;
  }

  const remainingTypes = noteTypes.filter(
    (noteType) => noteType.id !== movedId,
  );
  const nextIndex = Math.max(0, Math.min(targetIndex, remainingTypes.length));

  return [
    ...remainingTypes.slice(0, nextIndex),
    movedType,
    ...remainingTypes.slice(nextIndex),
  ].map((noteType, sortOrder) => ({ ...noteType, sortOrder }));
}

export function orderNoteTypesByIds(
  noteTypes: NoteType[],
  ids: NoteTypeId[],
): NoteType[] | null {
  if (ids.length !== noteTypes.length) {
    return null;
  }

  const typesById = new Map(
    noteTypes.map((noteType) => [noteType.id, noteType]),
  );
  const seenIds = new Set<NoteTypeId>();
  const orderedTypes: NoteType[] = [];

  for (const id of ids) {
    const noteType = typesById.get(id);

    if (!noteType || seenIds.has(id)) {
      return null;
    }

    seenIds.add(id);
    orderedTypes.push(noteType);
  }

  return orderedTypes.map((noteType, sortOrder) => ({
    ...noteType,
    sortOrder,
  }));
}
