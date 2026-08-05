import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import BookStatusBadge from "../../components/BookStatusBadge.jsx";
import Modal from "../../components/Modal.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getCommunity, listUsersByCommunity, listPostsByCommunity, listBooks,
  createJoinRequest, createNotification, getActiveBorrowingForUser,
} from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";
import { clampText, isAddress, isPhone, LIMITS } from "../../utils/validators.js";

const TABS = ["posts", "books", "members"];

export default function CommunityProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, updateProfile } = useAuth();

  const [community, setCommunity]   = useState(null);
  const [members, setMembers]       = useState([]);
  const [posts, setPosts]           = useState([]);
  const [books, setBooks]           = useState([]);
  const [tab, setTab]               = useState("posts");
  const [headerLoading, setHeaderLoading] = useState(true); // only blocks the header
  const [contentLoading, setContentLoading] = useState(true);

  // Join modal
  const [joinOpen, setJoinOpen]     = useState(false);
  const [bookForm, setBookForm]     = useState({ name: "", author: "", coverUrl: "" });
  // Contacts are collected here rather than on the book screens: joining is the
  // moment a user becomes reachable, and every handoff afterwards needs them.
  const [contactForm, setContactForm] = useState({ phone: "", address: "" });
  const [joinError, setJoinError]   = useState("");
  const [joining, setJoining]       = useState(false);
  const [joinDone, setJoinDone]     = useState(false);

  useEffect(() => {
    setHeaderLoading(true);
    setContentLoading(true);

    // Step 1 — load community doc first so the page opens instantly
    getCommunity(id).then((c) => {
      setCommunity(c);
      setHeaderLoading(false);

      // Step 2 — load the rest in the background; errors are swallowed gracefully.
      //
      // The shelf and the noticeboard belong to the community and are readable
      // only from inside it, so a visitor gets the header and the member list
      // and nothing else. Skipping the two queries rather than letting them be
      // refused keeps a perfectly ordinary page view out of the error log.
      const isMember = user?.communityId === id;
      Promise.allSettled([
        listUsersByCommunity(id),
        isMember ? listBooks({ communityId: id }) : Promise.resolve({ items: [] }),
        isMember ? listPostsByCommunity(id) : Promise.resolve([]),
      ]).then(([m, b, p]) => {
        if (m.status === "fulfilled") setMembers(m.value);
        if (b.status === "fulfilled") setBooks(b.value.items);
        if (p.status === "fulfilled") setPosts(p.value);
        setContentLoading(false);
      });
    }).catch(() => setHeaderLoading(false));
  }, [id, user?.communityId]);

  // Seed the contact fields from whatever the profile already knows, so a user
  // who filled them in at registration just confirms them.
  useEffect(() => {
    setContactForm({ phone: user?.phone || "", address: user?.address || "" });
  }, [user?.phone, user?.address]);

  const isMember  = user?.communityId === id;
  const isOwner   = community?.ownerId === user?.id;
  const isPrivate = community?.isPrivate;
  // Non-members can't see content of private communities
  const canSeeContent = !isPrivate || isMember || isOwner;

  async function handleJoin(e) {
    e.preventDefault();
    setJoinError("");
    if (!bookForm.name.trim()) { setJoinError("Кітап атауын жазыңыз"); return; }

    // Contacts gate — a member with no phone or address cannot hand a book over.
    const phone = contactForm.phone.trim();
    const address = clampText(contactForm.address, LIMITS.ADDRESS_MAX);
    if (!phone) { setJoinError(t.phoneRequiredError); return; }
    if (!isPhone(phone)) { setJoinError(t.phoneInvalidError); return; }
    if (!isAddress(address)) { setJoinError(t.addressRequiredError); return; }

    const active = await getActiveBorrowingForUser(user.id);
    if (active) { setJoinError("Алдымен алған кітабыңызды қайтарыңыз."); return; }
    setJoining(true);
    try {
      // Save first: the admin approving this request is agreeing to a member
      // other people can actually reach.
      if (phone !== (user.phone || "") || address !== (user.address || "")) {
        await updateProfile({ phone: phone.slice(0, 20), address });
      }

      const req = await createJoinRequest({
        userId: user.id,
        userNickname: user.nickname,
        communityId: id,
        bookName: bookForm.name,
        bookAuthor: bookForm.author,
        bookCoverUrl: bookForm.coverUrl,
      });

      // Notify the admin about the request
      await createNotification({
        recipientId: community.ownerId,
        title: "Қоғамдастыққа кіруге ұсыныс",
        body: `@${user.nickname} өтініш берді. Кітап: «${bookForm.name}»`,
        read: false,
        type: "join-request",
        communityId: id,
        requestId: req.id,
      });

      // Notify the USER themselves — so they can track and cancel the request
      await createNotification({
        recipientId: user.id,
        title: "Өтінішіңіз жіберілді",
        body: `«${community.name}» қоғамдастығына қосылу өтінішіңіз администраторға жіберілді. Жауап күтіңіз.`,
        read: false,
        type: "join-request-sent",
        communityId: id,
        communityName: community.name,
        requestId: req.id,
        requestStatus: "pending",
      });

      setJoinDone(true);
    } catch (err) {
      setJoinError(err?.message || "Қате");
    } finally {
      setJoining(false);
    }
  }

  if (headerLoading) {
    return (
      <MobileShell>
        <div className="flex items-center gap-3 px-4 mb-4">
          <button onClick={() => navigate(-1)} className="icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-4 pt-4 flex items-center gap-5 animate-pulse">
          <div className="w-20 h-20 rounded-full bg-ink-100 shrink-0" />
          <div className="flex-1 grid grid-cols-3 gap-2">
            <div className="h-8 rounded-lg bg-ink-100" />
            <div className="h-8 rounded-lg bg-ink-100" />
            <div className="h-8 rounded-lg bg-ink-100" />
          </div>
        </div>
      </MobileShell>
    );
  }

  if (!community) {
    return (
      <MobileShell>
        <p className="px-6 py-12 text-center text-ink-500">Қоғамдастық табылмады.</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell>
      {/* Back */}
      <div className="flex items-center gap-2 px-4 mb-2">
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <p className="font-semibold text-[16px] truncate">{community.name}</p>
        {isPrivate && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-400 shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </div>

      {/* ── Instagram-style header ── */}
      <div className="px-4 pt-2">
        <div className="flex items-center gap-5">
          <Avatar src={community.photoURL} name={community.name} size={80} />
          {/* Stats */}
          <div className="flex-1 grid grid-cols-3 text-center">
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : members.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">мүше</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : books.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">кітап</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : posts.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">жазба</p>
            </div>
          </div>
        </div>

        {/* Name + nickname + privacy badge */}
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <p className="font-bold text-[16px]">{community.name}</p>
            {isPrivate ? (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">Жабық</span>
            ) : (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ok/10 text-ok">Ашық</span>
            )}
          </div>
          <p className="text-[13px] text-ink-500">@{community.nickname}</p>
        </div>

        {/* Action button */}
        <div className="mt-3">
          {isOwner ? (
            <div className="w-full py-2 rounded-xl bg-ink-100 text-center text-[14px] font-semibold text-ink-600">
              Сіз — Администратор
            </div>
          ) : isMember ? (
            <button
              onClick={() => navigate(`/community/${id}/leave`)}
              className="w-full py-2 rounded-xl bg-badSoft text-bad text-[14px] font-semibold active:scale-[0.99] transition"
            >
              {t.exitCommunity}
            </button>
          ) : joinDone ? (
            <div className="w-full py-2 rounded-xl bg-ok/10 text-center text-[14px] font-semibold text-ok">
              ✓ Өтініш жіберілді
            </div>
          ) : (
            <button
              onClick={() => setJoinOpen(true)}
              className="w-full py-2 rounded-xl bg-brand-500 text-white text-[14px] font-semibold active:scale-[0.99] transition"
            >
              Қосылу
            </button>
          )}
        </div>
      </div>

      {/* ── Privacy gate ── */}
      {!canSeeContent ? (
        <div className="flex flex-col items-center px-8 mt-12 text-center gap-4">
          <div className="w-20 h-20 rounded-full bg-ink-100 flex items-center justify-center">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" className="text-ink-400">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <p className="font-semibold text-[16px]">Бұл жабық қоғамдастық</p>
          <p className="text-[14px] text-ink-500 leading-relaxed">
            Мүшелерді, кітаптарды және жазбаларды көру үшін қосылу өтінішін жіберіңіз.
          </p>
        </div>
      ) : (
        <>
          {/* ── Tabs ── */}
          <div className="px-4 mt-5 flex gap-1 border-b border-ink-100">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "flex-1 py-2.5 text-[13px] font-semibold transition border-b-2 -mb-px " +
                  (tab === t
                    ? "border-brand-500 text-brand-600"
                    : "border-transparent text-ink-400")
                }
              >
                {t === "posts" ? "Жазбалар" : t === "books" ? "Кітаптар" : "Мүшелер"}
              </button>
            ))}
          </div>

          <div className="px-4 mt-3 pb-4">
            {contentLoading && (
              <div className="space-y-3 mt-2">
                {[1,2,3].map(i => (
                  <div key={i} className="h-16 rounded-2xl bg-ink-100 animate-pulse" />
                ))}
              </div>
            )}

            {/* Posts tab */}
            {!contentLoading && tab === "posts" && (
              posts.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">Жазба жоқ.</p>
              ) : (
                <div className="space-y-3">
                  {posts.map((p) => (
                    <div key={p.id} className="card p-4">
                      <h4 className="font-semibold text-[15px]">{p.title}</h4>
                      <p className="text-[14px] text-ink-700 mt-1 whitespace-pre-wrap">{p.body}</p>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* Books tab */}
            {!contentLoading && tab === "books" && (
              books.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">Кітап жоқ.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {books.map((b) => (
                    <li key={b.id}>
                      <Link
                        to={`/books/${b.id}`}
                        className="flex items-center gap-3 py-3 active:bg-ink-100/40 transition rounded-xl px-1"
                      >
                        {b.coverUrl ? (
                          <img src={b.coverUrl} alt={b.name} className="w-10 h-14 rounded-lg object-cover bg-ink-100 shrink-0" />
                        ) : (
                          <div className="w-10 h-14 rounded-lg bg-ink-100 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-[15px] truncate">{b.name}</p>
                          <p className="text-[13px] text-ink-500 truncate">{b.author}</p>
                          <div className="mt-1"><BookStatusBadge status={b.status} /></div>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            )}

            {/* Members tab */}
            {!contentLoading && tab === "members" && (
              members.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">Мүше жоқ.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {members.map((m) => (
                    <li key={m.id}>
                      <Link
                        to={`/users/${m.id}`}
                        className="flex items-center gap-3 py-3 active:bg-ink-100/40 transition rounded-xl px-1"
                      >
                        <Avatar src={m.photoURL} name={`${m.firstName} ${m.lastName}`} size={40} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-[15px] truncate">{m.firstName} {m.lastName}</p>
                            {m.id === community.ownerId && (
                              <span className="shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-brand-50 text-brand-700">Админ</span>
                            )}
                          </div>
                          <p className="text-[13px] text-ink-500">@{m.nickname}</p>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        </>
      )}

      {/* ── Join modal ── */}
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Қосылу өтінішi" scrollable>
        {joinDone ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-16 h-16 rounded-full bg-ok/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="font-semibold text-[16px]">Өтініш жіберілді!</p>
            <p className="text-[14px] text-ink-500 text-center">Администратор жауап берген соң хабарлама аласыз.</p>
            <button onClick={() => setJoinOpen(false)} className="btn-primary">Жабу</button>
          </div>
        ) : (
          <form onSubmit={handleJoin} className="space-y-3">
            <p className="text-[13px] text-ink-600 leading-relaxed">
              Қоғамдастыққа кіру үшін бір кітап қосуыңыз қажет. Қандай кітапты әкелесіз?
            </p>
            <input
              value={bookForm.name}
              onChange={(e) => setBookForm({ ...bookForm, name: e.target.value })}
              placeholder="Кітаптың атауы *"
              className="input"
            />
            <input
              value={bookForm.author}
              onChange={(e) => setBookForm({ ...bookForm, author: e.target.value })}
              placeholder="Автор"
              className="input"
            />
            <input
              value={bookForm.coverUrl}
              onChange={(e) => setBookForm({ ...bookForm, coverUrl: e.target.value })}
              placeholder="Мұқаба URL (міндетті емес)"
              className="input"
            />

            <div className="pt-2">
              <p className="text-[14px] font-semibold">{t.contactsRequiredTitle}</p>
              <p className="text-[13px] text-ink-500 leading-relaxed mt-1">
                {t.contactsRequiredNote}
              </p>
            </div>
            <input
              type="tel"
              value={contactForm.phone}
              onChange={(e) =>
                setContactForm({ ...contactForm, phone: e.target.value.replace(/[^\d+\-() ]/g, "") })
              }
              placeholder={`${t.phone} *`}
              autoComplete="tel"
              className="input"
            />
            <input
              value={contactForm.address}
              onChange={(e) => setContactForm({ ...contactForm, address: e.target.value })}
              placeholder={`${t.address} * — ${t.addressPlaceholder}`}
              autoComplete="street-address"
              className="input"
            />

            {joinError && <p className="text-bad text-[13px]">{joinError}</p>}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setJoinOpen(false)}
                className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-ink-100 text-ink-700"
              >
                Болдырмау
              </button>
              <button
                type="submit"
                disabled={joining}
                className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-brand-500 text-white disabled:opacity-60"
              >
                {joining ? "…" : "Жіберу"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </MobileShell>
  );
}
