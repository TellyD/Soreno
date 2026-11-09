import { Eye, FileCode2, LoaderCircle, TextWrap } from "lucide-react";
import {
  isMarkdownProjectFile,
  projectFileName,
} from "../../domain/projectFiles";
import { useStoredPreference } from "../../hooks/useStoredPreference";
import { MarkdownContent } from "../MarkdownContent";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { LoadingState } from "../ui/LoadingState";
import { useGitStrings } from "./gitStrings";
import {
  ProjectCodeEditor,
  type FileReveal,
  type OpenDocument,
} from "./ProjectCodeEditor";

const parseWrap = (stored: string | null) => stored !== "false";

export function ProjectFileEditorPane({
  closeLocked,
  dirty,
  document,
  fileLoading,
  markdownPreview,
  reveal,
  saving,
  searchRequested,
  onChange,
  onRevealed,
  onSave,
  onSearchOpened,
  onToggleMarkdownPreview,
}: {
  closeLocked: boolean;
  dirty: boolean;
  document: OpenDocument | null;
  fileLoading: boolean;
  markdownPreview: boolean;
  reveal: FileReveal | null;
  saving: boolean;
  searchRequested: boolean;
  onChange: (value: string) => void;
  onRevealed: (id: number) => void;
  onSave: () => void;
  onSearchOpened: () => void;
  onToggleMarkdownPreview: () => void;
}) {
  const s = useGitStrings();
  const selectedPath = document?.path ?? null;
  const separator = selectedPath?.lastIndexOf("/") ?? -1;
  const parentPath = selectedPath?.slice(0, separator + 1) ?? "";
  const fileName = selectedPath ? projectFileName(selectedPath) : "";
  const markdownFile =
    !!document && !document.mediaType && isMarkdownProjectFile(document.path);
  const showMarkdownPreview = markdownFile && markdownPreview;
  const [wrap, setWrap] = useStoredPreference(
    "soreno:file-wrap",
    "soreno:file-wrap-change",
    parseWrap,
  );

  return (
    <section
      className="project-file-editor"
      aria-label={selectedPath ?? s.explorer}
    >
      {document ? (
        <>
          <header className="project-file-editor-toolbar">
            <div className="project-file-editor-path" title={document.path}>
              {parentPath ? <span>{parentPath}</span> : null}
              <strong>{fileName}</strong>
            </div>
            {saving ? (
              <span className="project-file-unsaved" role="status">
                <LoaderCircle
                  size={12}
                  className="app-loading-spinner"
                  aria-hidden="true"
                />
                {s.savingFile}
              </span>
            ) : dirty ? (
              <span className="project-file-unsaved" role="status">
                {s.unsavedFile}
              </span>
            ) : null}
            {document.mediaType || showMarkdownPreview ? null : (
              <IconButton
                size="small"
                aria-label={s.wrapLines}
                aria-pressed={wrap}
                selected={wrap}
                title={s.wrapLines}
                onClick={() => setWrap(!wrap)}
              >
                <TextWrap />
              </IconButton>
            )}
            {markdownFile ? (
              <IconButton
                size="small"
                aria-label={s.markdownPreview}
                aria-pressed={markdownPreview}
                selected={markdownPreview}
                title={s.markdownPreview}
                onClick={onToggleMarkdownPreview}
              >
                <Eye />
              </IconButton>
            ) : null}
          </header>
          {document.mediaType ? (
            <div className="project-file-image-preview">
              <img src={document.content} alt={fileName} />
            </div>
          ) : showMarkdownPreview ? (
            <div className="project-file-markdown-preview">
              <MarkdownContent
                className="project-file-markdown"
                content={document.value}
              />
            </div>
          ) : (
            <ProjectCodeEditor
              key={document.loadId}
              document={document}
              editable={!fileLoading && !closeLocked}
              reveal={reveal?.path === document.path ? reveal : null}
              wrap={wrap}
              searchRequested={searchRequested}
              onChange={onChange}
              onRevealed={onRevealed}
              onSave={onSave}
              onSearchOpened={onSearchOpened}
            />
          )}
        </>
      ) : fileLoading ? (
        <LoadingState className="git-panel-centered-status">
          {s.loadingFiles}
        </LoadingState>
      ) : (
        <EmptyState
          description={s.chooseProjectFile}
          fill
          icon={<FileCode2 />}
          title={s.explorer}
        />
      )}
    </section>
  );
}
