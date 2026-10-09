"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { initial, primaryName, secondaryName } from "@/lib/names";
import type { StaffRole } from "@/modules/tenancy";
import { saveStaffAction, setStaffActiveAction, type StaffState } from "./actions";

export interface StaffCard {
  id: string;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  /** "01712-345678" in the reader's digits. */
  phoneLabel: string;
  /** "01712-345678", for the edit form. */
  localPhone: string;
  isActive: boolean;
  roles: StaffRole[];
  since: string;
}

const ROLE_ICON: Record<StaffRole, string> = { admin: "🛡", president: "⭐", secretary: "📋", cashier: "💰", field_collector: "🚲" };

/** Everyone who signs in, with add, edit and switch-off. */
export function StaffBoard({ staff, me, roles }: { staff: StaffCard[]; me: string; roles: StaffRole[] }) {
  const t = useTranslations("settings");
  const tRoles = useTranslations("roles");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [editing, setEditing] = useState<StaffCard | "new" | null>(null);
  const [opened, setOpened] = useState(0);
  const [toggle, toggleAction, toggling] = useActionState<StaffState, FormData>(setStaffActiveAction, {});
  const [toast, setToast] = useState<string | null>(null);
  const [seenToggle, setSeenToggle] = useState(toggle);
  const [busyId, setBusyId] = useState<string | null>(null);

  const nameOf = (id: string) => {
    const s = staff.find((x) => x.id === id);
    return s ? primaryName(s, locale) : "";
  };
  if (seenToggle !== toggle) {
    setSeenToggle(toggle);
    if (toggle.done) setToast(t(`staff.${toggle.done.kind}`, { name: nameOf(toggle.done.userId) }));
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const active = staff.filter((s) => s.isActive).length;
  const open = (who: StaffCard | "new") => {
    setEditing(who);
    setOpened((n) => n + 1);
  };

  return (
    <section className="settings-card staff-card" aria-labelledby="staff-title">
      <header className="card-head staff-head">
        <div>
          <h2 id="staff-title">👥 {t("staff.title")}</h2>
          <p>
            {t("staff.subtitle")}{" "}
            <span className="staff-count">{t("staff.count", { active, inactive: staff.length - active })}</span>
          </p>
        </div>
        <button type="button" className="btn primary small" onClick={() => open("new")}>
          ＋ {t("staff.add")}
        </button>
      </header>

      {toast && (
        <p className="celebrate small staff-toast" role="status">
          ✓ {toast}
        </p>
      )}
      {toggle.errors?.form && !toggling && (
        <p className="form-error" role="alert" key={toggle.attempt}>
          {t(`errors.${toggle.errors.form}`)}
        </p>
      )}

      <ul className="staff-grid">
        {staff.map((s, i) => {
          const second = secondaryName(s, locale);
          const isMe = s.id === me;
          return (
            <li
              key={s.id}
              className={`staff-person${s.isActive ? "" : " off"}${isMe ? " me" : ""}`}
              style={{ "--h": (i * 67 + 150) % 360, animationDelay: `${i * 50}ms` } as React.CSSProperties}
            >
              <div className="staff-top">
                <span className="staff-avatar" aria-hidden="true">
                  {initial(s, locale)}
                </span>
                <div className="staff-name">
                  <strong>
                    {primaryName(s, locale)}
                    {isMe && <span className="you-badge">{t("staff.you")}</span>}
                  </strong>
                  {second && <span className="muted">{second}</span>}
                  <span className="staff-phone">📱 {s.phoneLabel}</span>
                </div>
                <span className={`status-pill${s.isActive ? " on" : ""}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {s.isActive ? t("staff.active") : t("staff.inactive")}
                </span>
              </div>
              <ul className="role-chips" aria-label={t("staff.roles")}>
                {s.roles.map((r) => (
                  <li key={r} className={`role-chip role-${r}`} title={t(`roleInfo.${r}`)}>
                    <span aria-hidden="true">{ROLE_ICON[r]}</span> {tRoles(r)}
                  </li>
                ))}
              </ul>
              <div className="staff-actions">
                <button type="button" className="btn ghost small" onClick={() => open(s)}>
                  ✎ {t("staff.edit")}
                </button>
                {!isMe && (
                  <form
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      const data = new FormData(ev.currentTarget);
                      setBusyId(s.id);
                      startTransition(() => toggleAction(data));
                    }}
                  >
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="active" value={String(!s.isActive)} />
                    <button className={`btn small ${s.isActive ? "ghost danger-ghost" : "ghost"}`} disabled={toggling}>
                      {toggling && busyId === s.id && <span className="spinner dark" aria-hidden="true" />}
                      {s.isActive ? `⏻ ${t("staff.deactivate")}` : `↺ ${t("staff.reactivate")}`}
                    </button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {editing && (
        <StaffDialog
          key={opened}
          person={editing === "new" ? null : editing}
          roles={roles}
          onClose={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            setToast(message);
          }}
        />
      )}
    </section>
  );
}

function StaffDialog({
  person,
  roles,
  onClose,
  onDone,
}: {
  person: StaffCard | null;
  roles: StaffRole[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations("settings");
  const tRoles = useTranslations("roles");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const ref = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<StaffState, FormData>(saveStaffAction, {});
  const [picked, setPicked] = useState<StaffRole[]>(person?.roles ?? []);
  const [name, setName] = useState({ nameEn: person?.nameEn ?? "", nameBn: person?.nameBn ?? "" });
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  useEffect(() => {
    if (!state.done) return;
    const who = primaryName({ nameEn: name.nameEn.trim() || null, nameBn: name.nameBn.trim() || null }, locale);
    onDone(t(`staff.${state.done.kind}`, { name: who }));
    // Only a new result closes the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const e = state.errors ?? {};
  const err = (k: "nameEn" | "nameBn" | "phone" | "roles") => (e[k] && !edited.has(k) ? t(`errors.${e[k]}`) : undefined);
  const touch = (k: string) => setEdited((prev) => new Set(prev).add(k).add(k === "nameBn" ? "nameEn" : k));
  const title = person ? t("staff.formEdit", { name: primaryName(person, locale) }) : t("staff.formAdd");

  return (
    <dialog
      ref={ref}
      className="staff-dialog"
      aria-labelledby="staff-dialog-title"
      onClose={onClose}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) ev.currentTarget.close();
      }}
    >
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          const data = new FormData(ev.currentTarget);
          startTransition(() => action(data));
        }}
      >
        <header className="dialog-head">
          <span className="dialog-icon" aria-hidden="true">
            {person ? "✎" : "＋"}
          </span>
          <h3 id="staff-dialog-title">{title}</h3>
          <button type="button" className="dialog-x" aria-label={t("staff.cancel")} onClick={() => ref.current?.close()}>
            ×
          </button>
        </header>
        {person && <input type="hidden" name="id" value={person.id} />}
        {(e.form === "server" || e.form === "forbidden" || e.form === "not_found") && (
          <p className="form-error" role="alert">
            {t(`errors.${e.form}`)}
          </p>
        )}

        <div className="grid-2">
          <div className={`field${err("nameEn") ? " has-error" : ""}`}>
            <label htmlFor="st-nameEn">{t("staff.nameEn")}</label>
            <input
              id="st-nameEn"
              name="nameEn"
              value={name.nameEn}
              onChange={(ev) => {
                setName((n) => ({ ...n, nameEn: ev.target.value }));
                touch("nameEn");
              }}
              autoComplete="off"
              autoFocus
              aria-invalid={!!err("nameEn") || undefined}
            />
            {err("nameEn") && <small className="field-error">{err("nameEn")}</small>}
          </div>
          <div className={`field${err("nameBn") ? " has-error" : ""}`}>
            <label htmlFor="st-nameBn">{t("staff.nameBn")}</label>
            <input
              id="st-nameBn"
              name="nameBn"
              lang="bn"
              value={name.nameBn}
              onChange={(ev) => {
                setName((n) => ({ ...n, nameBn: ev.target.value }));
                touch("nameBn");
              }}
              autoComplete="off"
              aria-invalid={!!err("nameBn") || undefined}
            />
            {err("nameBn") && <small className="field-error">{err("nameBn")}</small>}
          </div>
        </div>

        <div className={`field${err("phone") ? " has-error" : ""}`}>
          <label htmlFor="st-phone">{t("staff.phone")}</label>
          <div className={`phone-input${err("phone") ? " is-invalid" : ""}`}>
            <span aria-hidden="true">+88</span>
            <input
              id="st-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={person?.localPhone}
              placeholder="017XX-XXXXXX"
              onChange={() => touch("phone")}
              aria-invalid={!!err("phone") || undefined}
            />
          </div>
          {err("phone") ? <small className="field-error">{err("phone")}</small> : <small>{t("staff.phoneHint")}</small>}
        </div>

        <fieldset className={`field role-picker${err("roles") ? " has-error" : ""}`}>
          <legend className="label">{t("staff.roles")}</legend>
          <div className="role-options">
            {roles.map((r) => {
              const on = picked.includes(r);
              return (
                <label key={r} className={`role-option role-${r}${on ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    name="roles"
                    value={r}
                    checked={on}
                    onChange={() => {
                      setPicked((p) => (on ? p.filter((x) => x !== r) : [...p, r]));
                      touch("roles");
                    }}
                  />
                  <span className="role-option-icon" aria-hidden="true">
                    {ROLE_ICON[r]}
                  </span>
                  <span className="role-option-text">
                    <strong>{tRoles(r)}</strong>
                    <small>{t(`roleInfo.${r}`)}</small>
                  </span>
                  <span className="role-check" aria-hidden="true">
                    ✓
                  </span>
                </label>
              );
            })}
          </div>
          {err("roles") ? <small className="field-error">{err("roles")}</small> : <small>{t("staff.rolesHint")}</small>}
        </fieldset>

        <footer className="dialog-foot">
          <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>
            {t("staff.cancel")}
          </button>
          <button className="btn primary" disabled={pending}>
            {pending ? (
              <>
                <span className="spinner" aria-hidden="true" /> {t("staff.saving")}
              </>
            ) : (
              t("staff.save")
            )}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
