import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import BookCard from "../../components/BookCard.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getUserById, getCommunity, listBooksHeldBy, listBooksOwnedBy,
} from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";

export default function UserProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: viewer } = useAuth();
  const [u, setU] = useState(null);
  const [community, setCommunity] = useState(null);
  // Two different questions about the same member, and the answers overlap only
  // while their books are still on their own shelf: what they own, and what is
  // physically with them right now.
  const [ownedBooks, setOwnedBooks] = useState([]);
  const [heldBooks, setHeldBooks] = useState([]);

  useEffect(() => {
    (async () => {
      const user = await getUserById(id); setU(user);
      setOwnedBooks([]);
      setHeldBooks([]);
      if (!user?.communityId) return;
      setCommunity(await getCommunity(user.communityId));

      // Who somebody is is public; what is on their shelf is their community's
      // business. Asking anyway would just be a denied query, so don't ask.
      if (viewer?.communityId !== user.communityId) return;
      // One indexed query per question. This used to ask for a single page of
      // the community's books and sift it here, so a member whose books all sat
      // past the first thirty appeared to own nothing at all.
      const [owned, held] = await Promise.all([
        listBooksOwnedBy({ communityId: user.communityId, userId: user.id }),
        listBooksHeldBy({ communityId: user.communityId, userId: user.id }),
      ]);
      setOwnedBooks(owned);
      setHeldBooks(held);
    })();
  }, [id, viewer?.communityId]);

  if (!u) return <MobileShell><p className="px-6 py-12 text-center text-ink-500">Загрузка...</p></MobileShell>;

  return (
    <MobileShell>
      <SearchBar value="" onChange={() => {}} onBack={() => navigate(-1)} showFilter={false} />
      <div className="flex flex-col items-center pt-4">
        <Avatar src={u.photoURL} name={`${u.firstName} ${u.lastName}`} size={92} />
        <h2 className="font-bold text-xl mt-3">{u.firstName} {u.lastName}</h2>
        <p className="text-ink-500 text-[14px]">@{u.nickname}</p>
        {community ? <p className="text-[13px] text-ink-500 mt-1">из {community.name}</p> : null}
      </div>

      <section className="px-4 mt-5">
        <h3 className="section-title mb-2">{t.ownerLabel}: книги участника</h3>
        {ownedBooks.length === 0 ? (
          <p className="text-[13px] text-ink-500">Книг не добавил.</p>
        ) : (
          <ul>{ownedBooks.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>
        )}
      </section>

      <section className="px-4 mt-5">
        <h3 className="section-title mb-2">{t.ownedBooks}</h3>
        {heldBooks.length === 0 ? (
          <p className="text-[13px] text-ink-500">Сейчас книг нет.</p>
        ) : (
          <ul>{heldBooks.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>
        )}
      </section>
    </MobileShell>
  );
}
