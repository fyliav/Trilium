import "./BreadcrumbBadges.css";

import clsx from "clsx";
import { ComponentChildren, MouseEventHandler } from "preact";
import { useRef } from "preact/hooks";

import { t } from "../services/i18n";
import { BacklinksList, useBacklinkCount } from "./FloatingButtonsDefinitions";
import Dropdown, { DropdownProps } from "./react/Dropdown";
import { useIsNoteReadOnly, useNoteContext, useStaticTooltip } from "./react/hooks";
import Icon from "./react/Icon";
import { useShareInfo } from "./shared_info";

export default function BreadcrumbBadges() {
    return (
        <div className="breadcrumb-badges">
            <ReadOnlyBadge />
            <ShareBadge />
            <BacklinksBadge />
        </div>
    );
}

function ReadOnlyBadge() {
    const { note, noteContext } = useNoteContext();
    const { isReadOnly, enableEditing } = useIsNoteReadOnly(note, noteContext);
    const isExplicitReadOnly = note?.isLabelTruthy("readOnly");
    const isTemporarilyEditable = noteContext?.viewScope?.readOnlyTemporarilyDisabled;

    if (isTemporarilyEditable) {
        return <Badge
            icon="bx bx-lock-open-alt"
            text={t("breadcrumb_badges.read_only_temporarily_disabled")}
            tooltip={t("breadcrumb_badges.read_only_temporarily_disabled_description")}
            className="temporarily-editable-badge"
            onClick={() => enableEditing(false)}
        />;
    } else if (isReadOnly) {
        return <Badge
            icon="bx bx-lock-alt"
            text={isExplicitReadOnly ? t("breadcrumb_badges.read_only_explicit") : t("breadcrumb_badges.read_only_auto")}
            tooltip={isExplicitReadOnly ? t("breadcrumb_badges.read_only_explicit_description") : t("breadcrumb_badges.read_only_auto_description")}
            className="read-only-badge"
            onClick={() => enableEditing()}
        />;
    }
}

function ShareBadge() {
    const { note } = useNoteContext();
    const { isSharedExternally, link, linkHref } = useShareInfo(note);

    return (link &&
        <Badge
            icon={isSharedExternally ? "bx bx-world" : "bx bx-link"}
            text={isSharedExternally ? t("breadcrumb_badges.shared_publicly") : t("breadcrumb_badges.shared_locally")}
            tooltip={isSharedExternally ?
                t("breadcrumb_badges.shared_publicly_description", { link }) :
                t("breadcrumb_badges.shared_locally_description", { link })
            }
            className="share-badge"
            href={linkHref}
        />
    );
}

function BacklinksBadge() {
    const { note, viewScope } = useNoteContext();
    const count = useBacklinkCount(note, viewScope?.viewMode === "default");
    return (note && count > 0 &&
        <BadgeWithDropdown
            className="backlinks-badge backlinks-widget"
            icon="bx bx-revision"
            text={t("breadcrumb_badges.backlinks", { count })}
            tooltip={t("breadcrumb_badges.backlinks_description", { count })}
            dropdownOptions={{
                dropdownContainerClassName: "backlinks-items"
            }}
        >
            <BacklinksList note={note} />
        </BadgeWithDropdown>
    );
}

interface BadgeProps {
    text: string;
    icon?: string;
    className: string;
    tooltip?: string;
    onClick?: MouseEventHandler<HTMLDivElement>;
    href?: string;
}

function Badge({ icon, className, text, tooltip, onClick, href }: BadgeProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    useStaticTooltip(containerRef, {
        placement: "bottom",
        fallbackPlacements: [ "bottom" ],
        animation: false,
        html: true,
        title: tooltip
    });

    const content = <>
        {icon && <><Icon icon={icon} />&nbsp;</>}
        <span class="text">{text}</span>
    </>;

    return (
        <div
            ref={containerRef}
            className={clsx("breadcrumb-badge", className, { "clickable": !!onClick })}
            onClick={onClick}
        >
            {href ? <a href={href}>{content}</a> : <span>{content}</span>}
        </div>
    );
}

function BadgeWithDropdown({ children, tooltip, className, dropdownOptions, ...props }: BadgeProps & {
    children: ComponentChildren,
    dropdownOptions?: Partial<DropdownProps>
}) {
    return (
        <Dropdown
            className={`dropdown-${className}`}
            text={<Badge className={className} {...props} />}
            noDropdownListStyle
            noSelectButtonStyle
            hideToggleArrow
            title={tooltip}
            titlePosition="bottom"
            dropdownOptions={{ popperConfig: { placement: "bottom", strategy: "fixed" } }}
            {...dropdownOptions}
        >{children}</Dropdown>
    );
}
