import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import Loading from "../../components/Loading.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { joinCoReading, listUsersByCommunity, watchCoReaders } from "../../firebase/firestore.js";
import { COREAD_AVATAR_COUNT } from "../../firebase/schema.js";
import { coReadAvatarSrc } from "../../utils/icons.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { t } from "../../utils/i18n.js";

/**
 * The way into a reading room, in two steps.
 *
 * Who is in there, and then who you want to be while you are. Two steps rather
 * than two screens: the second is meaningless without having decided to join,
 * and a picker reached by its own URL is a picker somebody can land on with
 * nothing to apply it to.
 *
 * The people list is the community, not the room — you go in to read *with*
 * somebody, so the list has to show the people who are not in yet as well as
 * the ones who are. Whoever is already reading is marked and sorted to the
 * front, with the minutes they have behind them.
 */
export default function ReadTogether() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { community } = useCommunity();

  const [step, setStep] = useState(1);        // 1 = people, 2 = avatar
  const [search, setSearch] = useState("");
  const [avatar, setAvatar] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const membersQuery = useQuery({
    queryKey: qk.chats.candidates(community?.id),
    enabled: !!community?.id,
    staleTime: 60_000,
    queryFn: () => listUsersByCommunity(community.id),
  });

  // Who is actually in the room, live. The same subscription the room itself
  // uses, so the count on this screen and the circle on the next cannot
  // disagree about who is present.
  const [readers, setReaders] = useState([]);
  useEffect(() => {
    if (!community?.id) return undefined;
    return watchCoReaders(community.id, {
      onRows: setReaders,
      onError: (err) => logger.error("readTogether.watch", err?.message, { code: err?.code }),
    });
  }, [community?.id]);

  const readingIds = useMemo(
    () => new Map(readers.map((r) => [r.userId ?? r.id, r])),
    [readers]
  );

  const people = useMemo(() => {
    const rows = (membersQuery.data ?? []).filter((u) => u.id !== user?.id);
    const term = search.trim().toLowerCase();
    const matched = term
      ? rows.filter((u) =>
          `${u.firstName ?? ""} ${u.lastName ?? ""} ${u.nickname ?? ""}`.toLowerCase().includes(term))
      : rows;
    // Readers first, then by how much they have read — the room is the subject,
    // so the people in it come before the people who might join.
    return [...matched].sort((a, b) => {
      const ra = readingIds.has(a.id), rb = readingIds.has(b.id);
      if (ra !== rb) return ra ? -1 : 1;
      return (b.readingSeconds ?? 0) - (a.readingSeconds ?? 0);
    });
  }, [membersQuery.data, search, readingIds, user?.id]);

  async function join() {
    if (busy || !avatar || !community?.id || !user?.id) return;
    setBusy(true);
    setError("");
    try {
      await joinCoReading({
        userId: user.id,
        communityId: community.id,
        avatar,
        name: peerName(user),
        nickname: user.nickname ?? "",
        photoURL: user.photoURL ?? "",
        minutes: Math.floor((user.readingSeconds ?? 0) / 60),
      });
      navigate("/reading/together/room", { replace: true });
    } catch (err) {
      logger.error("readTogether.join", err?.message, { code: err?.code });
      setError(writeError(err));
      setBusy(false);
    }
  }

  const header = (
    <div className="flex items-center gap-2 px-1 pb-2">
      <button
        onClick={() => (step === 2 ? setStep(1) : navigate(-1))}
        aria-label={t.back}
        className="icon-btn shrink-0"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <SearchBar value={search} onChange={setSearch} placeholder={t.coReadSearch} showFilter={false} />
      </div>
    </div>
  );

  if (!community?.id) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.coReadNeedCommunity}</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell
      withNav={false}
      header={header}
      bottomBar={
        <>
          {/* Above the button, not at the end of the page. A refusal used to be
              printed below thirty avatars, where it was a full screen of
              scrolling away from the thing that caused it — so a join the
              server turned down looked exactly like a button that did nothing.
              An error belongs next to the control that produced it. */}
          {error ? (
            <p className="mb-2 text-bad text-[13px] text-center px-2">{error}</p>
          ) : null}
          <button
            onClick={() => (step === 1 ? setStep(2) : join())}
            // Step two cannot be finished without a choice, and the button says
            // so by being unusable rather than by complaining after the tap.
            disabled={busy || (step === 2 && !avatar)}
            className="btn-primary disabled:opacity-50"
          >
            {busy ? "…" : t.coReadJoin}
          </button>
        </>
      }
    >
      {step === 1 ? (
        <>
          <div className="px-4 flex items-center justify-between gap-3">
            <h2 className="text-[19px] font-bold">{t.coReadPeople(people.length)}</h2>
            <button
              onClick={() => navigate(`/community/${community.id}/invite`)}
              className="shrink-0 rounded-full bg-brand-500 text-white text-[13px] font-semibold px-3.5 py-2 active:scale-95 transition"
            >
              + {t.invite}
            </button>
          </div>

          {membersQuery.isLoading ? (
            <Loading />
          ) : (
            <ul className="grid grid-cols-3 gap-y-5 px-4 mt-4">
              {people.map((person) => {
                const here = readingIds.get(person.id);
                const minutes = here?.minutes ?? Math.floor((person.readingSeconds ?? 0) / 60);
                return (
                  <li key={person.id} className="flex flex-col items-center min-w-0">
                    <button
                      onClick={() => navigate(`/users/${person.id}`)}
                      className="relative active:scale-95 transition"
                    >
                      <Avatar src={person.photoURL} name={peerName(person)} size={72} />
                      {/* The minutes badge straddles the picture's lower edge,
                          as in the design: it belongs to the face, and a line
                          of text under the name would read as another name. */}
                      <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-surface border border-ink-100 px-2 py-0.5 text-[11px] font-medium tabular-nums">
                        {minutes} {t.minutesShort}
                      </span>
                      {here ? (
                        <span className="absolute top-0 right-0 w-4 h-4 rounded-full bg-ok ring-2 ring-base" />
                      ) : null}
                    </button>
                    <p className="mt-3.5 text-[15px] font-medium truncate max-w-full">
                      {person.firstName || peerName(person)}
                    </p>
                    {person.nickname ? (
                      <p className="text-[11px] text-ink-500 truncate max-w-full">@{person.nickname}</p>
                    ) : null}
                  </li>
                );
              })}
              {people.length === 0 ? (
                <li className="col-span-3 py-10 text-center text-ink-500 text-[14px]">{t.noResults}</li>
              ) : null}
            </ul>
          )}
        </>
      ) : (
        <>
          <h2 className="px-4 text-[17px] font-semibold">{t.coReadPickAvatar}</h2>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-6 px-6 mt-5">
            {Array.from({ length: COREAD_AVATAR_COUNT }, (_, i) => `av${i + 1}`).map((key) => (
              <li key={key} className="flex justify-center">
                <button
                  onClick={() => setAvatar(key)}
                  aria-pressed={avatar === key}
                  className={
                    "rounded-full p-1.5 transition active:scale-95 " +
                    (avatar === key ? "ring-[3px] ring-brand-500" : "ring-0")
                  }
                >
                  <img
                    src={coReadAvatarSrc(key)}
                    alt=""
                    aria-hidden="true"
                    width={112}
                    height={112}
                    style={{ width: 112, height: 112 }}
                    // No disc behind it. The artwork brings its own shape and its
                  // own background — a grey circle under a picture that is
                  // already a rounded illustration reads as a placeholder that
                  // failed to load, and it clips the ones that overflow a
                  // circle on purpose.
                  className="select-none"
                    draggable={false}
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

    </MobileShell>
  );
}
