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
  // Read the whole period off the table rather than reaching for `.days` with a
  // `??` fallback: all-time's window *is* null, so a nullish fallback quietly
  // turned it back into a week and the third tab showed the first tab's numbers.
  const days = (PERIODS.find((p) => p.key === period) ?? PERIODS[0]).days;

  const rows = useMemo(
    () => rankMembersByReading(members, { days }),
    [members, days]
  );

  // The podium takes the first three *places*, not the first three rows: a tie
  // for first puts two people on the top step, which is what the ranking says.
  const podium = rows.filter((r) => r.place <= 3);
  const rest = rows.filter((r) => r.place > 3);

  if (!rows.length) {
    return <p className="text-center text-ink-400 text-[14px] py-10">{t.noMembers}</p>;
  }

  // Second, first, third — the middle step is the tallest, so first sits in the
  // centre and the eye lands there before it reads any name.
  const ordered = [
    podium.find((r) => r.place === 2),
    podium.find((r) => r.place === 1),
    podium.find((r) => r.place === 3),
  ];

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

      {/* Podium */}
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

      {/* Everyone below the podium, in order. The top three are not repeated
          here — they are already the tallest thing on the screen. */}
      {rest.length > 0 ? (
        <ul className="mt-6 space-y-2">
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
      ) : null}
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
