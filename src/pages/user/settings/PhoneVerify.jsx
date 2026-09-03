import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import {
  abandonVerification,
  forgetPendingVerification,
  hasVerifiedPhone,
  newVerificationToken,
  readPendingVerification,
  simulateBotConfirmation,
  startPhoneVerification,
  verificationAvailable,
  verificationLink,
  verificationPayload,
  watchVerification,
} from "../../../firebase/phoneVerify.js";
import { isFirebaseConfigured } from "../../../firebase/config.js";
import { toE164 } from "../../../utils/validators.js";
import { t } from "../../../utils/i18n.js";
import { logger } from "../../../utils/logger.js";
import { writeError } from "../../../utils/writeError.js";
import { externalLink } from "../../../native/browser.js";

/**
 * Proving a phone number, by starting our Telegram bot.
 *
 * One number, one button, and then a wait. The reader types the number they
 * want on their profile and taps through to Telegram, where the bot asks for
 * their contact card; everything that decides the outcome happens over there.
 * So the second half of this screen is *waiting*, and it is a real state rather
 * than a spinner over a guess: it is subscribed to the attempt document, and
 * the bot resolving it is what ends the wait. Nothing here can decide the
 * answer, which is the point — see firebase/phoneVerify.js.
 *
 * ── Why the button is a link ─────────────────────────────────────────────────
 * `window.open` after an `await` is not a user gesture any more, and mobile
 * Safari blocks it — which was a verification flow that did nothing at all on
 * an iPhone. So the token is minted as soon as the number looks valid, the
 * anchor carries the real `t.me` href before anyone taps it, and writing the
 * attempt happens alongside the navigation rather than in front of it.
 *
 * ── And why it goes through `externalLink` ───────────────────────────────────
 * This whole flow is built on leaving the app and coming back, which a WebView
 * does not do by itself: an ordinary anchor would navigate the app's one view
 * to t.me and there would be nothing to come back to. `externalLink` hands the
 * URL to the OS instead, so Telegram — the *app*, which is the only thing that
 * can send a contact card — opens beside this screen and leaves it waiting
 * exactly where the reader left it.
 *
 * Reached from the two places a number has to be real — joining a community and
 * changing the number afterwards — and `?next=` is where to go once it is done,
 * so the join flow gets its applicant back to the same modal.
 */
export default function PhoneVerify() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, refresh } = useAuth();

  const next = params.get("next") || "/settings/profile";
  const changing = hasVerifiedPhone(user);
  const available = verificationAvailable();

  const [phone, setPhone]     = useState(user?.phone || "");
  const [pending, setPending] = useState(null);   // { token, payload, link, phone }
  const [status, setStatus]   = useState("");     // "" | "waiting" | "verified" | "mismatch" | "expired"
  const [mismatch, setMismatch] = useState(null);
  const [busy, setBusy]       = useState("");
  const [error, setError]     = useState("");

  const startingRef = useRef(false);
  // The live subscription, wherever it was opened from — resuming on mount and
  // starting a new attempt both go through `follow`, so there is one of these
  // and one place that closes it.
  const unsubscribeRef = useRef(() => {});

  const e164 = toE164(phone);

  /**
   * The token for the attempt this tap will open, minted before the tap so the
   * link is a real link. Tied to the number: change the number and the pending
   * token changes with it, so a stale one can never be redeemed for a claim
   * nobody made.
   */
  const token = useMemo(() => (e164 ? newVerificationToken() : null), [e164]);
  const link = token ? verificationLink(token) : null;

  /** Subscribe to an attempt and let the bot's answer drive the screen. */
  const follow = useCallback((forToken) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = watchVerification(forToken, {
      onResolved: async (attempt) => {
        if (attempt.status === "verified") {
          forgetPendingVerification();
          // The bot wrote the profile; the context is still holding the old one.
          await refresh();
          setStatus("verified");
          return;
        }
        if (attempt.status === "mismatch") {
          setMismatch(attempt.verifiedPhone || null);
          setStatus("mismatch");
          return;
        }
        forgetPendingVerification();
        setStatus("expired");
      },
    });
  }, [refresh]);

  // An attempt survives leaving the app — which this flow *requires*, since the
  // reader has to switch to Telegram and come back. Picking it up again on
  // mount is what makes the return trip land in the waiting state rather than
  // on an empty form.
  useEffect(() => {
    const saved = readPendingVerification();
    if (!saved?.token) return;
    setPending({
      ...saved,
      payload: verificationPayload(saved.token),
      link: verificationLink(saved.token),
    });
    setPhone(saved.phone || "");
    setStatus("waiting");
    follow(saved.token);
  }, [follow]);

  // The one place a live subscription is closed: leaving the screen. `follow`
  // replaces it, `startOver` closes it, and this catches everything else.
  useEffect(() => () => unsubscribeRef.current?.(), []);

  /**
   * Open the attempt. Deliberately *not* awaited before the browser follows the
   * anchor: the navigation to Telegram is the user's tap, and holding it back
   * behind a round trip is what got it blocked. If the write fails the screen
   * says so, and the bot would answer an unknown token with the same advice.
   */
  function handleStart(event) {
    if (startingRef.current) return;
    if (!e164) { event.preventDefault(); setError(t.phoneInvalidError); return; }
    if (changing && e164 === user.phone) { event.preventDefault(); setError(t.phoneSameAsCurrent); return; }
    if (!available || !link) { event.preventDefault(); setError(t.phoneChannelUnavailable); return; }

    startingRef.current = true;
    setError("");
    setMismatch(null);
    setPending({ token, payload: verificationPayload(token), link, phone: e164 });
    setStatus("waiting");

    startPhoneVerification({ userId: user.id, phone: e164, token })
      .then(() => follow(token))
      .catch((err) => {
        logger.error("phoneVerify.start", err?.message, { code: err?.code });
        setError(writeError(err));
        setStatus("");
        setPending(null);
      })
      .finally(() => { startingRef.current = false; });
  }

  async function startOver() {
    if (pending?.token) await abandonVerification(pending.token);
    unsubscribeRef.current?.();
    setPending(null);
    setStatus("");
    setMismatch(null);
    setError("");
  }

  /** Development only: no bot exists in mock mode, so this plays its part. */
  async function fakeBot() {
    if (!pending?.token) return;
    setBusy("mock");
    try {
      await simulateBotConfirmation(pending.token);
    } catch (err) {
      setError(err?.message || t.error);
    } finally {
      setBusy("");
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (status === "verified") {
    return (
      <SettingsPage title={t.phoneVerifyTitle}>
        <div className="flex flex-col items-center px-6 pt-14 pb-10 gap-6 text-center">
          <div className="w-24 h-24 rounded-full bg-okSoft flex items-center justify-center">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">{t.phoneVerifiedTitle}</h2>
            <p className="text-[15px] text-ink-700">{pending?.phone || user?.phone}</p>
            <p className="text-[13px] text-ink-500 leading-relaxed">{t.phoneVerifiedNote}</p>
          </div>
          <button onClick={() => navigate(next, { replace: true })} className="btn-primary">
            {t.continue}
          </button>
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t.phoneVerifyTitle}>
      <div className="px-5 pt-4 space-y-4">
        <p className="text-[13px] text-ink-500 leading-relaxed">
          {changing ? t.phoneChangeIntro : t.phoneVerifyIntro}
        </p>

        {status === "waiting" && pending ? (
          <Waiting pending={pending} onStartOver={startOver} onFakeBot={fakeBot} busy={busy} />
        ) : (
          <>
            {changing ? (
              <div className="rounded-2xl bg-ink-100/60 px-4 py-3">
                <p className="text-[12px] text-ink-500">{t.phoneCurrent}</p>
                <p className="text-[15px] font-medium mt-0.5">{user.phone}</p>
              </div>
            ) : null}

            {status === "mismatch" ? (
              <div className="rounded-2xl bg-badSoft px-4 py-3">
                <p className="text-[13px] text-bad leading-relaxed">
                  {t.phoneMismatchError(mismatch || "—")}
                </p>
              </div>
            ) : null}
            {status === "expired" ? (
              <div className="rounded-2xl bg-warnSoft px-4 py-3">
                <p className="text-[13px] text-ink-900 leading-relaxed">{t.phoneVerifyExpired}</p>
              </div>
            ) : null}

            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.phone}</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^\d+\-() ]/g, ""))}
                placeholder="+7 (777) 123-45-67"
                maxLength={20}
                className="input"
              />
            </label>
            <p className="text-[12px] text-ink-500 leading-snug">{t.phoneTelegramNote}</p>

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            {/* An anchor, not a button: see the note at the top of the file. */}
            <a
              href={link || "#"}
              {...externalLink(link, handleStart)}
              aria-disabled={!available || !e164}
              className={
                "w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] " +
                "flex items-center justify-center gap-2 text-white " +
                (available && e164
                  ? "bg-[#2AABEE] hover:bg-[#1E96D4]"
                  : "bg-[#2AABEE]/40 pointer-events-none")
              }
            >
              <TelegramIcon />
              {t.phoneVerifyTelegram}
            </a>

            {!available ? (
              <p className="text-[12px] text-warn leading-snug">{t.phoneChannelUnavailable}</p>
            ) : null}
          </>
        )}
      </div>
    </SettingsPage>
  );
}

function TelegramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.94 4.3 18.9 19.1c-.23 1.02-.84 1.27-1.7.79l-4.7-3.46-2.27 2.18c-.25.25-.46.46-.94.46l.34-4.78 8.7-7.86c.38-.34-.08-.53-.59-.19L6.28 13.02l-4.63-1.45c-1-.31-1.02-1 .21-1.48L20.64 2.8c.84-.31 1.57.19 1.3 1.5Z" />
    </svg>
  );
}

/**
 * The wait.
 *
 * Everything visible here is a way back into the conversation the reader is
 * meant to be having somewhere else — the link again, and the exact payload the
 * bot expects, because a deep link that opened Telegram without it (a desktop
 * client, an old build) leaves them with nothing to send.
 */
function Waiting({ pending, onStartOver, onFakeBot, busy }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-brand-500 animate-pulse" />
          <p className="text-[13px] font-semibold text-brand-700">{t.phoneWaitingTitle}</p>
        </div>
        <p className="text-[12px] text-brand-600 leading-relaxed mt-1">{t.phoneWaitingTelegram}</p>
        <p className="text-[13px] font-medium mt-2">{pending.phone}</p>
      </div>

      {pending.link ? (
        <a
          href={pending.link}
          {...externalLink(pending.link)}
          className="w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] flex items-center justify-center gap-2 text-white bg-[#2AABEE]"
        >
          <TelegramIcon />
          {t.phoneOpenTelegram}
        </a>
      ) : null}

      <div className="rounded-2xl bg-ink-100/60 px-4 py-3">
        <p className="text-[12px] text-ink-500">{t.phoneManualHint}</p>
        <p className="font-mono text-[15px] font-semibold mt-1 break-all">{pending.payload}</p>
      </div>

      <p className="text-[12px] text-ink-500 leading-snug">{t.phoneVerifyTtlNote}</p>

      {/* No bot exists without a Firebase project, so development gets a button
          that does what the webhook would — and only there. */}
      {!isFirebaseConfigured ? (
        <button onClick={onFakeBot} disabled={!!busy} className="btn-secondary">
          {busy === "mock" ? "…" : t.phoneSimulateBot}
        </button>
      ) : null}

      <button onClick={onStartOver} className="btn-secondary">
        {t.phoneStartOver}
      </button>
    </div>
  );
}
