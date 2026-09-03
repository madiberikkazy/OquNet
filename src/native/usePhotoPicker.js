import { useCallback, useRef } from "react";
import { hasNativePicker, pickPhoto } from "./photo.js";

/**
 * One way to ask for a photo, for the five screens that ask for one.
 *
 * Register, Settings, CreateCommunity, EditCommunity and CoverPicker all did
 * the same thing: a hidden `<input type="file">`, a button that clicks it, and
 * a change handler that pulls `files[0]` out and resets the input. Adding the
 * native picker to each of them separately would have been five copies of the
 * same branch, and five places for it to drift — so the branch lives here and
 * the screens keep only the part that differs, which is what they do with the
 * File once they have it.
 *
 *   const { open, inputProps } = usePhotoPicker({ kind: "avatar", onPick });
 *   <button onClick={open}>…</button>
 *   <input {...inputProps} />
 *
 * `onPick` is handed a File on both paths — see native/photo.js for why the
 * native picker goes to the trouble of producing one — so nothing downstream
 * changes, including the resize-and-upload pipeline in firebase/storage.js.
 *
 * The hidden input is rendered on native too. It is never reached (`open` does
 * not touch it there) and it costs nothing, and the alternative is every one of
 * those five screens carrying a conditional around a piece of its own markup.
 */
export function usePhotoPicker({ kind = "cover", onPick } = {}) {
  const inputRef = useRef(null);

  const open = useCallback(async () => {
    if (hasNativePicker) {
      const file = await pickPhoto({ kind });
      // null is a dismissed picker, which is not an event: the screen should
      // look exactly as it did before the sheet opened.
      if (file) onPick?.(file);
      return;
    }
    inputRef.current?.click();
  }, [kind, onPick]);

  const onChange = useCallback((event) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file still fires a change event — without
    // this, choosing the same photo twice in a row does nothing the second time.
    event.target.value = "";
    if (file) onPick?.(file);
  }, [onPick]);

  return {
    open,
    inputRef,
    inputProps: { ref: inputRef, type: "file", accept: "image/*", className: "hidden", onChange },
  };
}
