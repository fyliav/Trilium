import { ConvertToAttachmentResponse } from "@triliumnext/commons";
import { useContext } from "preact/hooks";

import appContext, { CommandNames } from "../../components/app_context";
import NoteContext from "../../components/note_context";
import FNote from "../../entities/fnote";
import branches from "../../services/branches";
import dialog from "../../services/dialog";
import { t } from "../../services/i18n";
import server from "../../services/server";
import toast from "../../services/toast";
import { isElectron as getIsElectron, isMac as getIsMac } from "../../services/utils";
import ws from "../../services/ws";
import ActionButton from "../react/ActionButton";
import Dropdown from "../react/Dropdown";
import { FormDropdownDivider, FormDropdownSubmenu, FormListItem } from "../react/FormList";
import { useIsNoteReadOnly, useNoteContext, useNoteLabel, useNoteProperty, useTriliumOption } from "../react/hooks";
import { ParentComponent } from "../react/react_utils";
import { isExperimentalFeatureEnabled } from "../../services/experimental_features";

const isNewLayout = isExperimentalFeatureEnabled("new-layout");

export default function NoteActions() {
    const { note, noteContext } = useNoteContext();
    return (
        <div className="ribbon-button-container" style={{ contain: "none" }}>
            {note && !isNewLayout && <RevisionsButton note={note} />}
            {note && note.type !== "launcher" && <NoteContextMenu note={note as FNote} noteContext={noteContext} />}
        </div>
    );
}

function RevisionsButton({ note }: { note: FNote }) {
    const isEnabled = !["launcher", "doc"].includes(note?.type ?? "");

    return (isEnabled &&
        <ActionButton
            icon="bx bx-history"
            text={t("revisions_button.note_revisions")}
            triggerCommand="showRevisions"
            titlePosition="bottom"
        />
    );
}

function NoteContextMenu({ note, noteContext }: { note: FNote, noteContext?: NoteContext }) {
    const parentComponent = useContext(ParentComponent);
    const noteType = useNoteProperty(note, "type") ?? "";
    const [viewType] = useNoteLabel(note, "viewType");
    const canBeConvertedToAttachment = note?.isEligibleForConversionToAttachment();
    const isSearchable = ["text", "code", "book", "mindMap", "doc"].includes(noteType);
    const isInOptionsOrHelp = note?.noteId.startsWith("_options") || note?.noteId.startsWith("_help");
    const isPrintable = ["text", "code"].includes(noteType) || (noteType === "book" && ["presentation", "list", "table"].includes(viewType ?? ""));
    const isElectron = getIsElectron();
    const isMac = getIsMac();
    const hasSource = ["text", "code", "relationMap", "mermaid", "canvas", "mindMap", "aiChat"].includes(noteType);
    const isSearchOrBook = ["search", "book"].includes(noteType);
    const [syncServerHost] = useTriliumOption("syncServerHost");
    const { isReadOnly, enableEditing } = useIsNoteReadOnly(note, noteContext);

    return (
        <Dropdown
            buttonClassName={ isNewLayout ? "bx bx-dots-horizontal-rounded" : "bx bx-dots-vertical-rounded" }
            className="note-actions"
            hideToggleArrow
            noSelectButtonStyle
            iconAction>

            {isReadOnly && <>
                <CommandItem icon="bx bx-pencil" text={t("read-only-info.edit-note")}
                    command={() => enableEditing()} />
                <FormDropdownDivider />
            </>}

            {canBeConvertedToAttachment && <ConvertToAttachment note={note} />}
            {note.type === "render" && <CommandItem command="renderActiveNote" icon="bx bx-extension" text={t("note_actions.re_render_note")} />}
            <CommandItem command="findInText" icon="bx bx-search" disabled={!isSearchable} text={t("note_actions.search_in_note")} />
            <CommandItem command="printActiveNote" icon="bx bx-printer" disabled={!isPrintable} text={t("note_actions.print_note")} />
            {isElectron && <CommandItem command="exportAsPdf" icon="bx bxs-file-pdf" disabled={!isPrintable} text={t("note_actions.print_pdf")} />}
            <FormDropdownDivider />

            <CommandItem icon="bx bx-import" text={t("note_actions.import_files")}
                disabled={isInOptionsOrHelp || note.type === "search"}
                command={() => parentComponent?.triggerCommand("showImportDialog", { noteId: note.noteId })} />
            <CommandItem icon="bx bx-export" text={t("note_actions.export_note")}
                disabled={isInOptionsOrHelp || note.noteId === "_backendLog"}
                command={() => noteContext?.notePath && parentComponent?.triggerCommand("showExportDialog", {
                    notePath: noteContext.notePath,
                    defaultType: "single"
                })} />
            <FormDropdownDivider />

            <CommandItem command="openNoteExternally" icon="bx bx-file-find" disabled={isSearchOrBook || !isElectron} text={t("note_actions.open_note_externally")} title={t("note_actions.open_note_externally_title")} />
            <CommandItem command="openNoteCustom" icon="bx bx-customize" disabled={isSearchOrBook || isMac || !isElectron} text={t("note_actions.open_note_custom")} />
            <CommandItem command="showNoteSource" icon="bx bx-code" disabled={!hasSource} text={t("note_actions.note_source")} />
            {(syncServerHost && isElectron) &&
                <CommandItem command="openNoteOnServer" icon="bx bx-world" disabled={!syncServerHost} text={t("note_actions.open_note_on_server")} />
            }
            <FormDropdownDivider />

            <CommandItem command="showRevisions" icon="bx bx-history" text={t("note_actions.view_revisions")} />
            <CommandItem command="forceSaveRevision" icon="bx bx-save" disabled={isInOptionsOrHelp} text={t("note_actions.save_revision")} />
            <CommandItem icon="bx bx-trash destructive-action-icon" text={t("note_actions.delete_note")} destructive
                disabled={isInOptionsOrHelp}
                command={() => branches.deleteNotes([note.getParentBranches()[0].branchId])}
            />
            <FormDropdownDivider />

            <CommandItem command="showAttachments" icon="bx bx-paperclip" disabled={isInOptionsOrHelp} text={t("note_actions.note_attachments")} />
            {glob.isDev && <DevelopmentActions note={note} noteContext={noteContext} />}
        </Dropdown>
    );
}

function DevelopmentActions({ note, noteContext }: { note: FNote, noteContext?: NoteContext }) {
    return (
        <FormDropdownSubmenu title="Development Actions" icon="bx bx-wrench" dropStart>
            <FormListItem
                icon="bx bx-printer"
                onClick={() => window.open(`/?print=#root/${note.noteId}`, "_blank")}
            >Open print page</FormListItem>
            <FormListItem
                icon="bx bx-error"
                disabled={note.type !== "text"}
                onClick={() => {
                    noteContext?.getTextEditor(editor => {
                        editor.editing.view.change(() => {
                            throw new Error("Editor crashed.");
                        });
                    });
                }}>Crash editor</FormListItem>
        </FormDropdownSubmenu>
    );
}

function CommandItem({ icon, text, title, command, disabled }: { icon: string, text: string, title?: string, command: CommandNames | (() => void), disabled?: boolean, destructive?: boolean }) {
    return <FormListItem
        icon={icon}
        title={title}
        triggerCommand={typeof command === "string" ? command : undefined}
        onClick={typeof command === "function" ? command : undefined}
        disabled={disabled}
    >{text}</FormListItem>;
}

function ConvertToAttachment({ note }: { note: FNote }) {
    return (
        <FormListItem
            icon="bx bx-paperclip"
            onClick={async () => {
                if (!note || !(await dialog.confirm(t("note_actions.convert_into_attachment_prompt", { title: note.title })))) {
                    return;
                }

                const { attachment: newAttachment } = await server.post<ConvertToAttachmentResponse>(`notes/${note.noteId}/convert-to-attachment`);

                if (!newAttachment) {
                    toast.showMessage(t("note_actions.convert_into_attachment_failed", { title: note.title }));
                    return;
                }

                toast.showMessage(t("note_actions.convert_into_attachment_successful", { title: newAttachment.title }));
                await ws.waitForMaxKnownEntityChangeId();
                await appContext.tabManager.getActiveContext()?.setNote(newAttachment.ownerId, {
                    viewScope: {
                        viewMode: "attachments",
                        attachmentId: newAttachment.attachmentId
                    }
                });
            }}
        >{t("note_actions.convert_into_attachment")}</FormListItem>
    );
}
