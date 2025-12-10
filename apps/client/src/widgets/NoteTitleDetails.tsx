import { type ComponentChild } from "preact";

import { formatDateTime } from "../utils/formatters";
import { useNoteContext, useStaticTooltip } from "./react/hooks";
import { joinElements } from "./react/react_utils";
import { useNoteMetadata } from "./ribbon/NoteInfoTab";
import { Trans } from "react-i18next";
import { useRef } from "preact/hooks";

export default function NoteTitleDetails() {
    const { note, noteContext } = useNoteContext();
    const { metadata } = useNoteMetadata(note);
    const isHiddenNote = note?.noteId.startsWith("_");
    const isDefaultView = noteContext?.viewScope?.viewMode === "default";

    const items: ComponentChild[] = [
        (isDefaultView && !isHiddenNote && metadata?.dateCreated &&
            <TextWithValue
                i18nKey="note_title.created_on"
                value={formatDateTime(metadata.dateCreated, "medium", "none")}
                valueTooltip={formatDateTime(metadata.dateCreated, "full", "long")}
            />),
        (isDefaultView && !isHiddenNote && metadata?.dateModified &&
            <TextWithValue
                i18nKey="note_title.last_modified"
                value={formatDateTime(metadata.dateModified, "medium", "none")}
                valueTooltip={formatDateTime(metadata.dateModified, "full", "long")}
            />)
    ].filter(item => !!item);

    return (
        <div className="title-details">
            {joinElements(items, " • ")}
        </div>
    );
}

function TextWithValue({ i18nKey, value, valueTooltip }: {
    i18nKey: string;
    value: string;
    valueTooltip: string;
}) {
    const listItemRef = useRef<HTMLLIElement>(null);
    useStaticTooltip(listItemRef, {
        selector: "span.value",
        title: valueTooltip,
        popperConfig: { placement: "bottom" }
    });

    return (
        <li ref={listItemRef}>
            <Trans
                i18nKey={i18nKey}
                components={{
                    Value: <span className="value">{value}</span> as React.ReactElement
                }}
            />
        </li>
    );
}
