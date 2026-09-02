import { useState } from "react";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { MEETUP_GENDERS } from "../../../firebase/schema.js";
import GenderFigure from "../../../components/GenderFigure.jsx";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../utils/i18n.js";

/**
 * Жыныс — the one profile field that decides who can invite this reader to sit
 * down and read somewhere real.
 *
 * It is asked for the first time inside the offline meet-up flow, because that
 * is where it first means something; it is *changed* here, because a matching
 * rule buried in a bottom sheet is a setting nobody can find twice. Nothing else
 * in the app reads the field — it is not on a profile, not in search, and not
 * shown to anybody. See utils/meetups.js for the whole of what it does.
 *
 * Saving is the tap itself. There is no Save button because there is nothing to
 * compose: one of two values, written straight through, with the row that was
 * chosen marked the moment the write lands.
 */
export default function GenderSettings() {
  const { user, updateProfile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose(value) {
    if (busy || value === user?.gender) return;
    setBusy(true);
    setError("");
    try {
      await updateProfile({ gender: value });
    } catch (err) {
      logger.error("settings.gender", err?.message, { code: err?.code });
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage title={t.gender}>
      <div className="px-5 pt-2">
        <p className="text-[13px] text-ink-500">{t.genderSettingsNote}</p>

        <div className="mt-4 divide-y divide-ink-100">
          {MEETUP_GENDERS.map((value) => {
            const selected = user?.gender === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => choose(value)}
                disabled={busy}
                className="w-full flex items-center gap-3 py-3.5 text-left transition active:opacity-60 disabled:opacity-50"
              >
                {/* The same figure the picker in the meet-up flow shows, at row
                    size. A settings list of two words would make the reader
                    match this screen to that one from memory; the artwork is
                    what says they are the same question. */}
                <GenderFigure value={value} size={40} />
                <span className="flex-1 text-[15px] text-ink-900">
                  {value === "male" ? t.meetupMale : t.meetupFemale}
                </span>
                {selected ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                    <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <span className="w-5" />
                )}
              </button>
            );
          })}
        </div>

        {error ? <p className="text-bad text-[13px] mt-3">{error}</p> : null}
      </div>
    </SettingsPage>
  );
}
