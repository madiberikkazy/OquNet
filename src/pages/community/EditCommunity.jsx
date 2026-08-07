import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import SettingsPage from "../../components/SettingsPage.jsx";
import Avatar from "../../components/Avatar.jsx";
import { ToggleRow } from "../../components/SettingsList.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  getCommunity, updateCommunity, getCommunityByNickname, getUsernameEntry,
  syncPostVisibility,
} from "../../firebase/firestore.js";
import { uploadImage } from "../../firebase/storage.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";
import { clampText, LIMITS } from "../../utils/validators.js";

// Community nicknames are their own namespace and allow a dot — "aiu.oqyrman"
// is the shape the create flow suggests — so they are not held to the user
// nickname rule, which deliberately does not.
const COMMUNITY_NICK_RE = /^[a-z0-9_.]{2,24}$/;

/**
 * Edit community — the admin-side counterpart of CommunityProfile.
 *
 * Only the owner gets here: the security rules refuse a write from anybody
 * else, so a screen that let a member fill the form in would be building a
 * request the server was always going to reject.
 */
export default function EditCommunity() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { community: myCommunity, setCommunity } = useCommunity();
  const fileRef = useRef(null);

  const [community, setLocalCommunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    name: "", nickname: "", isPrivate: false, notificationsEnabled: true,
  });
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { type: "ok" | "err", text }

  useEffect(() => {
    let cancelled = false;
    getCommunity(id)
      .then((c) => {
        if (cancelled) return;
        setLocalCommunity(c);
        if (c) {
          setForm({
            name: c.name || "",
            nickname: c.nickname || "",
            isPrivate: Boolean(c.isPrivate),
            notificationsEnabled: c.notificationsEnabled !== false,
          });
        }
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const isOwner = Boolean(community && user && community.ownerId === user.id);

  // Someone who cannot save should not be looking at the form at all.
  useEffect(() => {
    if (!loading && community && !isOwner) {
      navigate(`/community/${id}`, { replace: true });
    }
  }, [loading, community, isOwner, id, navigate]);

  function updateForm(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function onPickPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function save() {
    if (saving || !community) return;

    const name = clampText(form.name, LIMITS.NAME_MAX);
    const nickname = form.nickname.trim().toLowerCase();
    if (!name || !nickname) { setMsg({ type: "err", text: t.fillAllFields }); return; }
    if (!COMMUNITY_NICK_RE.test(nickname)) {
      setMsg({ type: "err", text: t.communityNicknameInvalid });
      return;
    }

    setSaving(true);
    setMsg(null);
    try {
      // A rename has to clear both namespaces — a community may not take a name
      // a member already answers to, and the two indexes are separate. Matching
      // this community itself is not a clash.
      if (nickname !== community.nickname) {
        const [userMatch, communityMatch] = await Promise.all([
          getUsernameEntry(nickname),
          getCommunityByNickname(nickname),
        ]);
        if (userMatch || (communityMatch && communityMatch.id !== community.id)) {
          setMsg({ type: "err", text: t.communityNicknameTaken });
          return;
        }
      }

      let photoURL = community.photoURL || "";
      if (photoFile) {
        photoURL = await uploadImage(photoFile, `communities/${nickname}_${Date.now()}`);
      }

      const patch = {
        name,
        nickname,
        isPrivate: form.isPrivate,
        notificationsEnabled: form.notificationsEnabled,
        photoURL,
      };
      await updateCommunity(community.id, patch);

      // The privacy flag is denormalised onto every post of this community —
      // that is what the Home discovery feed queries. Going private has to pull
      // the old notices out of everyone else's feed, and going public has to put
      // them in; neither happens by editing the community alone.
      if (Boolean(form.isPrivate) !== Boolean(community.isPrivate)) {
        await syncPostVisibility(community.id, !form.isPrivate).catch((err) => {
          logger.warn("community.syncPostVisibility", err?.message, { communityId: community.id });
        });
      }

      const updated = { ...community, ...patch };
      setLocalCommunity(updated);
      setPhotoFile(null);
      setPhotoPreview(null);
      // Keep the app-wide copy in step — the profile header, the settings row
      // and the leave screen all read it.
      if (myCommunity?.id === community.id) setCommunity(updated);

      setMsg({ type: "ok", text: t.communitySaved });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      logger.error("community.edit", err?.message, { communityId: id });
      setMsg({ type: "err", text: err?.message || t.error });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SettingsPage title={t.editCommunity} backTo={`/community/${id}`}>
        <p className="px-5 pt-6 text-[14px] text-ink-500">{t.loading}</p>
      </SettingsPage>
    );
  }

  if (!community) {
    return (
      <SettingsPage title={t.editCommunity} backTo="/profile">
        <p className="px-5 pt-6 text-[14px] text-ink-500">{t.noResults}</p>
      </SettingsPage>
    );
  }

  const avatarSrc = photoPreview || community.photoURL || null;

  return (
    <SettingsPage title={t.editCommunity} backTo={`/community/${id}`}>
      <div className="px-5 pt-4">
        {/* Photo */}
        <div className="flex flex-col items-center mb-6">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-full focus:outline-none focus:ring-2 focus:ring-brand-200"
            aria-label={t.communityPhoto}
          >
            <Avatar src={avatarSrc} name={form.name || community.name} size={96} />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="mt-2 text-[13px] font-semibold text-brand-500"
          >
            {t.changePhoto}
          </button>
        </div>

        {/* Name + nickname */}
        <label className="block mb-3">
          <span className="text-[12px] text-ink-500 mb-1 block">{t.communityName}</span>
          <input
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            maxLength={LIMITS.NAME_MAX}
            className="input"
          />
        </label>

        <label className="block mb-5">
          <span className="text-[12px] text-ink-500 mb-1 block">{t.communityNickname}</span>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-300 text-[15px] select-none">@</span>
            <input
              value={form.nickname}
              onChange={(e) => updateForm("nickname", e.target.value.replace(/\s/g, "").toLowerCase())}
              maxLength={24}
              className="input pl-8"
            />
          </div>
        </label>

        {/* Visibility */}
        <p className="text-[12px] text-ink-500 mb-2">{t.communityVisibility}</p>
        <VisibilityOption
          selected={!form.isPrivate}
          onClick={() => updateForm("isPrivate", false)}
          title={t.publicCommunity}
          note={t.publicCommunityNote}
          icon={
            <>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
              <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" stroke="currentColor" strokeWidth="1.8" />
            </>
          }
        />
        <VisibilityOption
          selected={form.isPrivate}
          onClick={() => updateForm("isPrivate", true)}
          title={t.privateCommunity}
          note={t.privateCommunityNote}
          icon={
            <>
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </>
          }
        />

        {/* Member notifications */}
        <div className="mt-2 border-t border-ink-100">
          <ToggleRow
            label={t.memberNotifications}
            checked={form.notificationsEnabled}
            onChange={(v) => updateForm("notificationsEnabled", v)}
          />
        </div>

        {msg ? (
          <p className={"text-[13px] mb-2 " + (msg.type === "ok" ? "text-ok" : "text-bad")}>
            {msg.text}
          </p>
        ) : null}

        <button onClick={save} disabled={saving} className="btn-primary mt-2">
          {saving ? "…" : t.save}
        </button>
      </div>
    </SettingsPage>
  );
}

function VisibilityOption({ selected, onClick, title, note, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "w-full flex items-center gap-4 p-4 rounded-2xl border-2 transition mb-3 text-left " +
        (selected ? "border-brand-500 bg-brand-50" : "border-ink-100 bg-surface")
      }
    >
      <span
        className={
          "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 " +
          (selected ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-500")
        }
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">{icon}</svg>
      </span>
      <span className="flex-1">
        <span className="block font-semibold text-[15px]">{title}</span>
        <span className="block text-[13px] text-ink-500 mt-0.5">{note}</span>
      </span>
      {selected ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-brand-500 shrink-0">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}
