import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import { RANK_WINDOWS, rankMembersByReading } from "../utils/readingProgress.js";
import { t } from "../utils/i18n.js";

/**
 * Who has read the most, inside one community.
 *
 * Reading time is the score. Not books finished — a reader who picks up short
 * books would outrank one working through a long one, and the app already
 * measures the thing that actually happened: minutes with a book open. Minutes
 * are also the unit shown, rather than a points figure derived from them, so
 * the number on the board is the number on the reader's own profile.
 *
 * The whole thing is computed from the member list the page already loaded —
 * every reader's day map rides along on their profile document — so switching
 * period costs nothing and there is no query behind these tabs.
 */
const PERIODS = [
  { key: "week",  labelKey: "periodWeek",  days: RANK_WINDOWS.week },
  { key: "month", labelKey: "periodMonth", days: RANK_WINDOWS.month },
  { key: "all",   labelKey: "periodAllTime", days: RANK_WINDOWS.all },
];

/** Reading time as the board reports it: whole minutes. */
export function readingMinutes(seconds) {
  return Math.floor(Math.max(0, Number(seconds) || 0) / 60);
}

export default function Leaderboard({ members, currentUserId, ownerId, renderRowAction }) {
  const [period, setPeriod] = useState("week");
  const [query, setQuery] = useState("");
  // Read the whole period off the table rather than reaching for `.days` with a
  // `??` fallback: all-time's window *is* null, so a nullish fallback quietly
  // turned it back into a week and the third tab showed the first tab's numbers.
  const days = (PERIODS.find((p) => p.key === period) ?? PERIODS[0]).days;

  const rows = useMemo(
    () => rankMembersByReading(members, { days }),
    [members, days]
  );

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!needle) return rows;
    return rows.filter(({ member }) =>
      `${member.firstName || ""} ${member.lastName || ""} ${member.nickname || ""}`
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, needle]);

  // Only readers who actually read in this window get a step. Three members on
  // zero minutes are all genuinely tied for first, and crowning one of them —
  // "🏆 1 · 0 мин" — says the opposite of what the board is for. With nobody
  // reading yet there is no podium at all, just the roll.
  //
  // Taken by position, never by place: a tie puts two people on the same place,
  // and looking steps up by place number dropped everyone who shared one.
  const podium = needle ? [] : visible.filter((r) => r.seconds > 0).slice(0, 3);
  const podiumIds = new Set(podium.map((r) => r.member.id));
  // Everyone the podium did not take — which, when searching or when nobody has
  // read, is simply everyone. No member can fall between the two lists.
  const rest = visible.filter((r) => !podiumIds.has(r.member.id));

  if (!rows.length) {
    return <p className="text-center text-ink-400 text-[14px] py-10">{t.noMembers}</p>;
  }

  // Second, first, third — the middle step is the tallest, so first sits in the
  // centre and the eye lands there before it reads any name.
  const ordered = [podium[1], podium[0], podium[2]];

  return (
    <div>
      {/* Period switch */}
      <div className="flex gap-1 p-1 rounded-2xl bg-ink-100">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={
              "flex-1 py-2 rounded-xl text-[13px] font-semibold transition " +
              (period === p.key ? "bg-surface text-brand-600 shadow-sm" : "text-ink-500")
            }
          >
            {t[p.labelKey]}
          </button>
        ))}
      </div>

      {/* Find one person in a community that outgrew a single screen. It sits
          above the board rather than inside the roll because it filters both:
          a search narrows the standings, so the podium steps aside and the
          matches come back as a plain ranked list. */}
      <div className="relative mt-3">
        <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
          <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchMembers}
          className="w-full bg-ink-100 rounded-2xl pl-9 pr-9 py-2.5 text-[14px] placeholder-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        {query ? (
          <button
            onClick={() => setQuery("")}
            aria-label={t.cancel}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-ink-200 text-ink-600 flex items-center justify-center"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* Podium */}
      {podium.length > 0 ? (
      <div className="mt-5 flex items-end justify-center gap-3">
        {ordered.map((row, i) =>
          row ? (
            <PodiumStep
              key={row.member.id}
              row={row}
              isSelf={row.member.id === currentUserId}
              action={row.member.id === ownerId ? null : renderRowAction?.(row.member)}
            />
          ) : (
            <div key={`empty-${i}`} className="flex-1 max-w-[110px]" />
          )
        )}
      </div>
      ) : null}

      {/* Everyone the podium did not take, in order. */}
      {rest.length > 0 ? (
        <ul className={"space-y-2 " + (podium.length ? "mt-6" : "mt-4")}>
          {rest.map((row) => (
            <li key={row.member.id}>
              <Row
                row={row}
                isSelf={row.member.id === currentUserId}
                isOwner={row.member.id === ownerId}
                action={renderRowAction?.(row.member)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-ink-400 text-[14px] py-10">{t.noResults}</p>
      )}
    </div>
  );
}

const STEP = {
  1: { height: "h-[86px]", ring: "ring-brand-500", badge: "bg-brand-500", size: 72 },
  2: { height: "h-[64px]", ring: "ring-ink-300",   badge: "bg-ink-400",   size: 56 },
  3: { height: "h-[52px]", ring: "ring-warn",      badge: "bg-warn",      size: 56 },
};

function PodiumStep({ row, isSelf, action }) {
  const { member, place, seconds } = row;
  const style = STEP[place] ?? STEP[3];
  const name = `${member.firstName || ""} ${member.lastName || ""}`.trim() || `@${member.nickname}`;

  return (
    <div className="flex-1 max-w-[120px] flex flex-col items-center">
      {/* The crown belongs to the tallest step and nothing else. */}
      {place === 1 ? (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="text-warn mb-1">
          <path d="M4 18h16l1-9-5.5 3.5L12 5l-3.5 7.5L3 9l1 9Z" fill="currentColor" />
        </svg>
      ) : null}

      <Link
        to={`/users/${member.id}`}
        className="flex flex-col items-center active:opacity-70 transition"
      >
        <div className={"rounded-full ring-4 " + style.ring}>
          <Avatar src={member.photoURL} name={name} size={style.size} />
        </div>

        <span className={"-mt-3 w-7 h-7 rounded-full text-white text-[13px] font-bold flex items-center justify-center ring-2 ring-surface " + style.badge}>
          {place}
        </span>

        <p className="mt-1.5 text-[13px] font-semibold text-center leading-tight line-clamp-2">
          {name}{isSelf ? ` ${t.youMark}` : ""}
        </p>
        <p className="text-[12px] text-ink-500">
          {readingMinutes(seconds)} {t.minutesShort}
        </p>
      </Link>

      {/* Outside the link: an anchor may not contain a button, and the top
          three have to stay as manageable as everybody else. */}
      {action ? <div className="mt-1.5">{action}</div> : null}

      {/* The step itself — height is the whole point of a podium. */}
      <div className={"mt-2 w-full rounded-t-xl bg-ink-100 " + style.height} />
    </div>
  );
}

function Row({ row, isSelf, isOwner, action }) {
  const { member, place, seconds } = row;
  const name = `${member.firstName || ""} ${member.lastName || ""}`.trim() || `@${member.nickname}`;

  return (
    <div
      className={
        "flex items-center gap-3 rounded-2xl px-3 py-2.5 " +
        (isSelf ? "bg-brand-50" : "bg-ink-100/60")
      }
    >
      <span className="w-6 text-center text-[14px] font-bold text-ink-500 tabular-nums shrink-0">
        {place}
      </span>
      <Link to={`/users/${member.id}`} className="flex items-center gap-3 flex-1 min-w-0 active:opacity-70 transition">
        <Avatar src={member.photoURL} name={name} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-[14px] truncate">
              {name}{isSelf ? ` ${t.youMark}` : ""}
            </p>
            {isOwner ? (
              <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700">
                {t.adminBadge}
              </span>
            ) : null}
          </div>
          <p className="text-[12px] text-ink-500 truncate">@{member.nickname}</p>
        </div>
        <span className="text-[13px] font-semibold tabular-nums shrink-0">
          {readingMinutes(seconds)} {t.minutesShort}
        </span>
      </Link>
      {action}
    </div>
  );
}
