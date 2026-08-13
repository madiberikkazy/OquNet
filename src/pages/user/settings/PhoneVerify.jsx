import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import {
  PHONE_CODE_LENGTH,
  clearPhoneVerifier,
  confirmPhoneVerification,
  startPhoneVerification,
} from "../../../firebase/phoneAuth.js";
import { isFirebaseConfigured } from "../../../firebase/config.js";
import { toE164 } from "../../../utils/validators.js";
import { t } from "../../../utils/i18n.js";
import { logger } from "../../../utils/logger.js";

/** How long before the code can be asked for again. Long enough to arrive. */
const RESEND_AFTER_SECONDS = 60;

/**
 * Proving a phone number.
 *
 * Reached from the two places a number has to be real: joining a community —
 * where somebody is about to be given a stranger's address and expected to meet
 * them — and changing the number afterwards. `?next=` is where to go once it is
 * done, so the join flow can send someone here mid-application and get them
 * back to the same modal.
 *
 * It is asked exactly once. A member who has already proven a number is never
 * sent here again by joining somewhere else; only *changing* the number brings
 * them back, because a new number is a new claim.
 */
export default function PhoneVerify() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, refresh } = useAuth();

  const next = params.get("next") || "/settings/profile";
  const changing = Boolean(user?.phone && user?.phoneVerifiedAt);

  const [step, setStep]       = useState(1);          // 1 = number, 2 = code
  const [phone, setPhone]     = useState(user?.phone || "");
  const [digits, setDigits]   = useState(() => Array(PHONE_CODE_LENGTH).fill(""));
  const [session, setSession] = useState(null);        // { phone, verificationId }
  const [devCode, setDevCode] = useState("");          // mock mode only
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy]       = useState("");          // "send" | "confirm"
  const [error, setError]     = useState("");
  const [left, setLeft]       = useState(0);           // seconds until resend
  const [done, setDone]       = useState(false);

  // Both of these write, and `busy` is only visible to the next render — two
  // taps inside one await would send two codes, or spend one twice.
  const sendingRef = useRef(false);
  const confirmingRef = useRef(false);

  // The invisible widget is torn down when this screen goes away; leaving it
  // rendered means the next visit tries to render a second one into the same
  // element, which throws.
  useEffect(() => clearPhoneVerifier, []);

  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  async function sendCode() {
    if (sendingRef.current) return;
    const e164 = toE164(phone);
    if (!e164) { setError(t.phoneInvalidError); return; }
    if (changing && e164 === user.phone) { setError(t.phoneSameAsCurrent); return; }

    sendingRef.current = true;
    setBusy("send");
    setError("");
    try {
      const started = await startPhoneVerification({ phone: e164 });
      setSession({ phone: started.phone, verificationId: started.verificationId });
      setDevCode(started.devCode || "");
      setDigits(Array(PHONE_CODE_LENGTH).fill(""));
      setStep(2);
      setLeft(RESEND_AFTER_SECONDS);
    } catch (err) {
      setError(err?.message || t.error);
    } finally {
      sendingRef.current = false;
      setBusy("");
    }
  }

  async function confirm(e) {
    e?.preventDefault();
    if (confirmingRef.current || !session) return;
    const code = digits.join("");
    if (code.replace(/\D/g, "").length !== PHONE_CODE_LENGTH) {
      setError(t.phoneCodeMissing);
      return;
    }

    confirmingRef.current = true;
    setBusy("confirm");
    setError("");
    try {
      await confirmPhoneVerification({
        phone: session.phone,
        verificationId: session.verificationId,
        code,
        password: password || null,
      });
      // The profile carries the number now; every screen that shows it reads
      // from here, so the context has to catch up before we navigate.
      await refresh();
      setDone(true);
    } catch (err) {
      logger.error("phoneVerify.confirm", err?.message);
      const message = err?.message || t.error;
      // Firebase refuses to move a proven number on a session that has been
      // sitting: ask for the password once, then let them press again.
      if (message === t.phoneNeedsPassword) setNeedsPassword(true);
      setError(message);
      // A spent code cannot be retyped — send a new one.
      if (message === t.phoneCodeExpired) { setSession(null); setStep(1); }
    } finally {
      confirmingRef.current = false;
      setBusy("");
    }
  }

  function setDigit(index, value) {
    const cleaned = value.replace(/\D/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = cleaned;
      return next;
    });
    if (cleaned && index < PHONE_CODE_LENGTH - 1) {
      document.getElementById(`pdigit-${index + 1}`)?.focus();
    }
  }

  /** Paste the whole code — what people actually do with an SMS. */
  function onPaste(e) {
    const text = (e.clipboardData?.getData("text") || "").replace(/\D/g, "");
    if (!text) return;
    e.preventDefault();
    setDigits(Array.from({ length: PHONE_CODE_LENGTH }, (_, i) => text[i] || ""));
    document.getElementById(`pdigit-${Math.min(text.length, PHONE_CODE_LENGTH) - 1}`)?.focus();
  }

  function onKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      document.getElementById(`pdigit-${index - 1}`)?.focus();
    }
  }

  if (done) {
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
            <p className="text-[15px] text-ink-700">{session?.phone}</p>
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

        {step === 1 ? (
          <>
            {changing ? (
              <div className="rounded-2xl bg-ink-100/60 px-4 py-3">
                <p className="text-[12px] text-ink-500">{t.phoneCurrent}</p>
                <p className="text-[15px] font-medium mt-0.5">{user.phone}</p>
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
            <p className="text-[12px] text-ink-500 leading-snug">{t.phoneSmsNote}</p>

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            <button onClick={sendCode} disabled={busy === "send" || !phone.trim()} className="btn-primary">
              {busy === "send" ? "…" : t.phoneSendCode}
            </button>
          </>
        ) : (
          <form onSubmit={confirm} className="space-y-4">
            <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-3">
              <p className="text-[13px] font-semibold text-brand-700">{t.phoneCodeSentTitle}</p>
              <p className="text-[12px] text-brand-600 mt-0.5">{session?.phone}</p>
            </div>

            {/* Mock mode has no SMS to read, so it says the code out loud. This
                is only ever reachable with no Firebase project configured. */}
            {devCode && !isFirebaseConfigured ? (
              <p className="text-[12px] text-warn">{t.phoneDevCode}: {devCode}</p>
            ) : null}

            <div className="flex gap-2 justify-center" onPaste={onPaste}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  id={`pdigit-${i}`}
                  type="text"
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  maxLength={1}
                  value={d}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  aria-label={`${t.phoneCodeLabel} ${i + 1}`}
                  className="w-11 h-14 text-center text-xl font-bold rounded-xl bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-surface transition"
                />
              ))}
            </div>

            {/* Only asked for when Firebase has actually refused the change. */}
            {needsPassword ? (
              <label className="block">
                <span className="text-[12px] text-ink-500 mb-1 block">{t.password}</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                />
              </label>
            ) : null}

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            <button disabled={busy === "confirm"} className="btn-primary">
              {busy === "confirm" ? "…" : t.phoneConfirmCode}
            </button>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setStep(1); setError(""); setNeedsPassword(false); }}
                className="text-[13px] text-ink-500"
              >
                {t.phoneChangeNumber}
              </button>
              <button
                type="button"
                onClick={sendCode}
                disabled={left > 0 || busy === "send"}
                className="text-[13px] text-brand-500 font-medium disabled:text-ink-300"
              >
                {left > 0 ? t.phoneResendIn(left) : t.phoneResend}
              </button>
            </div>
          </form>
        )}

        {/* Firebase renders the invisible challenge into this element. It must
            exist before a code is asked for, and survive the step change. */}
        <div id="recaptcha-holder" />
      </div>
    </SettingsPage>
  );
}
