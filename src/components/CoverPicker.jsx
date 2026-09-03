import { useEffect, useState } from "react";
import { t } from "../utils/i18n.js";
import { usePhotoPicker } from "../native/usePhotoPicker.js";

/**
 * The book cover field, for both Add Book and Edit Book.
 *
 * A photo taken on the phone is the normal case — an admin standing in front of
 * a shelf has the book, not a URL for it — so the picker is the primary action
 * and the URL box stays underneath for the times someone does have a link. In
 * the store builds that tap opens the camera directly, which is the whole
 * reason the wording above was ever true. Either one wins on its own; picking a file clears the URL, and typing a
 * URL clears the file, because two sources for one field is how a screen ends
 * up showing one cover and saving another.
 *
 * The file is held, not uploaded: the surrounding form owns when a write
 * happens, so an abandoned Add Book leaves nothing behind in Storage.
 */
export default function CoverPicker({ coverUrl, file, onFile, onUrlChange }) {
  const [filePreview, setFilePreview] = useState(null);

  // An object URL is a live handle into the picked file — it has to be revoked
  // when the file changes or the screen goes away, or the blob stays in memory.
  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(picked) {
    onUrlChange("");
    onFile(picked);
  }

  const photoPicker = usePhotoPicker({ kind: "cover", onPick: pick });

  function clear() {
    onFile(null);
    onUrlChange("");
  }

  const preview = filePreview || coverUrl || "";

  return (
    <div>
      <p className="text-[13px] text-ink-500 mb-2">{t.bookPhoto}</p>

      <input {...photoPicker.inputProps} />

      {preview ? (
        <div className="relative rounded-2xl h-52 bg-ink-100 overflow-hidden">
          <img src={preview} alt="" className="w-full h-full object-cover" />
          <div className="absolute bottom-3 right-3 flex gap-2">
            <button
              type="button"
              onClick={photoPicker.open}
              className="px-3 py-1.5 rounded-xl bg-surface/90 text-[13px] font-medium text-ink-700 shadow"
            >
              {t.changePhoto}
            </button>
            <button
              type="button"
              onClick={clear}
              className="px-3 py-1.5 rounded-xl bg-bad/90 text-[13px] font-medium text-white shadow"
            >
              {t.removePhoto}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={photoPicker.open}
          className="w-full h-52 rounded-2xl bg-brand-50 border-2 border-dashed border-brand-200
                     flex flex-col items-center justify-center gap-2
                     text-brand-500 hover:bg-brand-100 transition active:scale-[0.99]"
        >
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.12" />
            <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-[14px] font-medium">{t.addPhoto}</span>
          <span className="text-[12px] text-brand-400">{t.pickPhotoHint}</span>
        </button>
      )}

      <input
        value={file ? "" : coverUrl}
        onChange={(e) => { onFile(null); onUrlChange(e.target.value); }}
        placeholder={t.orPasteUrl}
        disabled={Boolean(file)}
        className="input mt-2 text-[13px] disabled:opacity-50"
      />
    </div>
  );
}
