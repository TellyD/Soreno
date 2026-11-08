import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  createNoteType,
  deleteNoteType,
  reorderNoteTypes as persistNoteTypeOrder,
  updateNoteType,
} from "../data/noteTypesApi";
import { noteTypeView, type LibraryView } from "../domain/library";
import type { Note } from "../domain/notes";
import {
  orderNoteTypesByIds,
  type NoteType,
  type NoteTypeId,
} from "../domain/noteTypes";
import { sameItems } from "../domain/sameItems";
import { notifyError } from "../notifications";

type NoteTypeErrorMessages = {
  create: string;
  delete: string;
  deleteLast: string;
  deleteUsed: string;
  reorder: string;
  save: string;
};

type UseNoteTypesOptions = {
  getCurrentNotes: () => Note[];
  setActiveView: Dispatch<SetStateAction<LibraryView>>;
  messages: NoteTypeErrorMessages;
};

export function useNoteTypes({
  getCurrentNotes,
  messages,
  setActiveView,
}: UseNoteTypesOptions) {
  const [noteTypes, setNoteTypes] = useState<NoteType[]>([]);
  const generation = useRef(0);

  function invalidatePendingMutations() {
    generation.current += 1;
  }

  async function handleCreateNoteType(
    name: string,
    icon: string,
    color: string,
  ): Promise<NoteType> {
    const currentGeneration = generation.current;
    try {
      const createdType = await createNoteType(name, icon, color);
      if (generation.current !== currentGeneration) return createdType;

      setNoteTypes((currentTypes) =>
        sortNoteTypes([...currentTypes, createdType]),
      );
      setActiveView(noteTypeView(createdType.id));
      return createdType;
    } catch (error) {
      if (generation.current === currentGeneration) {
        notifyError(messages.create);
      }
      throw error;
    }
  }

  async function handleUpdateNoteType(
    id: NoteTypeId,
    name: string,
    icon: string,
    color: string,
  ): Promise<NoteType> {
    const currentGeneration = generation.current;
    try {
      const updatedType = await updateNoteType(id, name, icon, color);
      if (generation.current !== currentGeneration) return updatedType;

      setNoteTypes((currentTypes) =>
        sortNoteTypes(
          currentTypes.map((noteType) =>
            noteType.id === updatedType.id ? updatedType : noteType,
          ),
        ),
      );
      return updatedType;
    } catch (error) {
      if (generation.current === currentGeneration) notifyError(messages.save);
      throw error;
    }
  }

  async function handleDeleteNoteType(id: NoteTypeId) {
    const validationMessage = getCurrentNotes().some((note) => note.kind === id)
      ? messages.deleteUsed
      : noteTypes.length <= 1
        ? messages.deleteLast
        : null;

    if (validationMessage) {
      notifyError(validationMessage);
      throw new Error(validationMessage);
    }

    const currentGeneration = generation.current;
    try {
      await deleteNoteType(id);
      if (generation.current !== currentGeneration) return;

      setNoteTypes((currentTypes) =>
        currentTypes.filter((noteType) => noteType.id !== id),
      );
      setActiveView((currentView) =>
        currentView === noteTypeView(id) ? "all" : currentView,
      );
    } catch (error) {
      if (generation.current === currentGeneration) {
        notifyError(messages.delete);
      }
      throw error;
    }
  }

  async function handleReorderNoteTypes(ids: NoteTypeId[]) {
    const currentGeneration = generation.current;
    const previousTypes = noteTypes;
    const currentIds = noteTypes.map((noteType) => noteType.id);

    if (sameItems(ids, currentIds)) {
      return;
    }

    const nextTypes = orderNoteTypesByIds(noteTypes, ids);

    if (!nextTypes) {
      return;
    }

    try {
      setNoteTypes(nextTypes);
      const persistedTypes = await persistNoteTypeOrder(ids);
      if (generation.current !== currentGeneration) return;

      setNoteTypes(sortNoteTypes(persistedTypes));
    } catch (error) {
      if (generation.current === currentGeneration) {
        setNoteTypes(previousTypes);
        notifyError(messages.reorder);
      }
      throw error;
    }
  }

  return {
    invalidatePendingMutations,
    handleCreateNoteType,
    handleDeleteNoteType,
    handleReorderNoteTypes,
    handleUpdateNoteType,
    noteTypes,
    setNoteTypes,
  };
}

function sortNoteTypes(noteTypes: NoteType[]): NoteType[] {
  return [...noteTypes].sort((left, right) => {
    const order = left.sortOrder - right.sortOrder;

    return (
      order ||
      left.name.localeCompare(right.name, "fr-FR", {
        numeric: true,
        sensitivity: "base",
      })
    );
  });
}
