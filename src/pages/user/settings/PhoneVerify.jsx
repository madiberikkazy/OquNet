import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import {
  CHANNELS,
  abandonVerification,
  channelAvailable,
  forgetPendingVerification,
  hasVerifiedPhone,
  readPendingVerification,
  simulateBotConfirmation,
  startPhoneVerification,
  verificationLink,
  verificationPayload,
  watchVerification,
} from "../../../firebase/phoneVerify.js";
import { isFirebaseConfigured } from "../../../firebase/config.js";
import { toE164 } from "../../../utils/validators.js";
import { t } from "../../../utils/i18n.js";
import { logger } from "../../../utils/logger.js";
import { writeError } from "../../../utils/writeError.js";

/**
 * Proving a phone number, by messaging a bot.
 *
 * Two steps and no code to type. The reader enters the number they want on
 * their profile, picks WhatsApp or Telegram, and the app hands them a link that
 * opens that app with the message already written. Everything after that
 * happens somewhere else: they press send, the bot sees which number the
 * message came from, and — if it is the number they claimed — writes it to the
 * profile with the Admin SDK.
 *
 * So the third step of this screen is *waiting*, and it is a real state rather
 * than a spinner over a guess: it is subscribed to the attempt document, and
 * the bot resolving it is what ends the wait. Nothing here polls the profile,
 * and nothing here can decide the answer.
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

  const [phone, setPhone]     = useState(user?.phone || "");
  const [pending, setPending] = useState(null);   // { token, payload, link, channel, phone }
  const [status, setStatus]   = useState("");     // "", "waiting", "verified", "mismatch", "expired"
  const [mismatch, setMismatch] = useState(null); // the number the message came from
  const [busy, setBusy]       = useState("");
  const [error, setError]     = useState("");

  // Guards a double tap: opening an attempt writes a document and mints a token.
  const startingRef = useRef(false);
  // The live subscription, wherever it was opened from — resuming on mount and
  // starting a new attempt both go through `follow`, so there is one of these
  // and one place that closes it.
  const unsubscribeRef = useRef(() => {});

  /** Subscribe to an attempt and let the bot's answer drive the screen. */
  const follow = useCallback((token) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = watchVerification(token, {
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
        // Cancelled elsewhere, or the window closed.
        forgetPendingVerification();
        setStatus("expired");
      },
    });
  }, [refresh]);

  // An attempt survives leaving the app — which this flow *requires*, since the
  // reader has to switch to WhatsApp or Telegram and come back. Picking it up
  // again on mount is what makes the return trip land back in the waiting state
  // rather than on an empty form.
  useEffect(() => {
    const saved = readPendingVerification();
    if (!saved?.token) return undefined;
    setPending({ ...saved, payload: verificationPayload(saved.token),
      link: verificationLink({ channel: saved.channel, token: saved.token }) });
    setPhone(saved.phone || "");
    setStatus("waiting");
    follow(saved.token);
    return undefined; // closing it is the unmount effect's job, below
  }, [follow]);

  async function start(channel) {
    if (startingRef.current) return;
    const e164 = toE164(phone);
    if (!e164) { setError(t.phoneInvalidError); return; }
    if (changing && e164 === user.phone) { setError(t.phoneSameAsCurrent); return; }
    if (!channelAvailable(channel)) { setError(t.phoneChannelUnavailable); return; }

    startingRef.current = true;
    setBusy(channel);
    setError("");
    try {
      const started = await startPhoneVerification({ userId: user.id, phone: e164, channel });
      setPending({ ...started, channel, phone: e164 });
      setStatus("waiting");
      setMismatch(null);
      // Opened rather than navigated to: this tab has to stay alive to hear the
      // answer. A same-tab navigation would tear the subscription down at
      // exactly the moment it starts to matter.
      if (started.link) window.open(started.link, "_blank", "noopener,noreferrer");
      follow(started.token);
    } catch (err) {
      logger.error("phoneVerify.start", err?.message, { code: err?.code });
      setError(writeError(err));
    } finally {
      startingRef.current = false;
      setBusy("");
    }
  }

  // The one place a live subscription is closed: leaving the screen. `follow`
  // replaces it, `startOver` closes it, and this catches everything else.
  useEffect(() => () => unsubscribeRef.current?.(), []);

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
          <Waiting
            pending={pending}
            onStartOver={startOver}
            onFakeBot={fakeBot}
            busy={busy}
          />
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
            <p className="text-[12px] text-ink-500 leading-snug">{t.phoneChannelNote}</p>

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            <div className="space-y-2">
              <ChannelButton
                channel={CHANNELS.WHATSAPP}
                label={t.phoneVerifyWhatsApp}
                busy={busy === CHANNELS.WHATSAPP}
                disabled={!phone.trim() || !!busy}
                onClick={() => start(CHANNELS.WHATSAPP)}
              />
              <ChannelButton
                channel={CHANNELS.TELEGRAM}
                label={t.phoneVerifyTelegram}
                busy={busy === CHANNELS.TELEGRAM}
                disabled={!phone.trim() || !!busy}
                onClick={() => start(CHANNELS.TELEGRAM)}
              />
            </div>
          </>
        )}
      </div>
    </SettingsPage>
  );
}

/**
 * One channel, offered or explained.
 *
 * A channel whose bot is not configured is shown greyed with a reason rather
 * than hidden: "there used to be two buttons and now there is one" is a bug
 * report nobody can act on, and half the time the reason is a missing
 * environment variable in a deploy.
 */
function ChannelButton({ channel, label, busy, disabled, onClick }) {
  const available = channelAvailable(channel);
  const brand =
    channel === CHANNELS.WHATSAPP
      ? "bg-[#25D366] hover:bg-[#1FBF5A] text-white"
      : "bg-[#2AABEE] hover:bg-[#1E96D4] text-white";

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || !available}
        className={
          "w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] " +
          "disabled:opacity-50 flex items-center justify-center gap-2 " + brand
        }
      >
        <ChannelIcon channel={channel} />
        {busy ? "…" : label}
      </button>
      {!available ? (
        <p className="text-[12px] text-ink-500 mt-1">{t.phoneChannelUnavailable}</p>
      ) : null}
    </div>
  );
}

function ChannelIcon({ channel }) {
  if (channel === CHANNELS.WHATSAPP) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.44.13-.15.17-.25.25-.41.09-.17.04-.31-.02-.44-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.47c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.07.14-1.18-.06-.1-.22-.16-.47-.28Z" />
      </svg>
    );
  }
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
 * meant to be having somewhere else — the link again, and the exact text the
 * bot expects, because a deep link that opened the app without the message (an
 * old WhatsApp build, a desktop client) leaves them with nothing to send.
 */
function Waiting({ pending, onStartOver, onFakeBot, busy }) {
  const isWhatsApp = pending.channel === CHANNELS.WHATSAPP;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-brand-500 animate-pulse" />
          <p className="text-[13px] font-semibold text-brand-700">{t.phoneWaitingTitle}</p>
        </div>
        <p className="text-[12px] text-brand-600 leading-relaxed mt-1">
          {isWhatsApp ? t.phoneWaitingWhatsApp : t.phoneWaitingTelegram}
        </p>
        <p className="text-[13px] font-medium mt-2">{pending.phone}</p>
      </div>

      {pending.link ? (
        <a
          href={pending.link}
          target="_blank"
          rel="noopener noreferrer"
          className={
            "w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] " +
            "flex items-center justify-center gap-2 text-white " +
            (isWhatsApp ? "bg-[#25D366]" : "bg-[#2AABEE]")
          }
        >
          <ChannelIcon channel={pending.channel} />
          {isWhatsApp ? t.phoneOpenWhatsApp : t.phoneOpenTelegram}
        </a>
      ) : null}

      {/* The fallback for a link that opened the app without the text. */}
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
