import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import {
  getBook, getUserById, getActiveBorrowingForUser,
  transferBookHolder, createNotification,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { invalidateHolderCaches } from "../../lib/bookCaches.js";

function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function fmt(d) { return new Date(d).toISOString().slice(0, 10); }

export default function RequestBook() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [book, setBook] = useState(null);
  const [owner, setOwner] = useState(null);
  const [returnDate, setReturnDate] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const b = await getBook(id); setBook(b);
      if (b?.ownerId) setOwner(await getUserById(b.ownerId));
      const maxDays = b?.maxDays || 14;
      setReturnDate(fmt(addDays(Date.now(), Math.min(7, maxDays))));
    })();
  }, [id]);

  async function onSubmit(e) {
    e.preventDefault(); setError("");
    const active = await getActiveBorrowingForUser(user.id);
    if (active) { setError("Вы уже читаете другую книгу. Верните её перед запросом новой."); return; }
    if (book.ownerId === user.id) { setError("Это ваша книга."); return; }
    const maxDate = addDays(Date.now(), book.maxDays || 14);
    if (new Date(returnDate) > maxDate) { setError(`Максимальный срок — ${book.maxDays || 14} дней`); return; }

    setSubmitting(true);
    try {
      // Holder moves to the borrower; the owner stays whoever it already was.
      const { ownerId } = await transferBookHolder({
        bookId: book.id,
        toUserId: user.id,
        borrowing: {
          bookName: book.name,
          communityId: book.communityId,
          startDate: Date.now(),
          returnDate: new Date(returnDate).getTime(),
        },
      });
      await createNotification({
        recipientId: ownerId, title: "Запрос на книгу",
        body: `${user.firstName} ${user.lastName} запросил вашу книгу «${book.name}» до ${returnDate}`,
        read: false, type: "borrow-request", bookId: book.id,
      });
      invalidateHolderCaches(book.id);
      navigate(`/books/${book.id}`, { replace: true });
    } catch (err) { setError(err?.message || "Ошибка"); }
    finally { setSubmitting(false); }
  }

  if (!book) return <MobileShell><p className="px-6 py-12 text-ink-500 text-center">Загрузка...</p></MobileShell>;

  return (
    <MobileShell withNav={false}>
      <SearchBar value="" onChange={() => {}} onBack={() => navigate(-1)} placeholder="Search..." />

      <div className="px-5 pt-4">
        <h1 className="text-xl font-bold">Запросить книгу</h1>
        <p className="text-[14px] text-ink-500 mt-1">«{book.name}» — {book.author}</p>
      </div>

      <form onSubmit={onSubmit} className="px-5 pt-5 space-y-4">
        <label className="block">
          <span className="text-[13px] text-ink-500 mb-1 block">Когда вы вернёте книгу?</span>
          <input
            type="date" value={returnDate}
            min={fmt(Date.now())} max={fmt(addDays(Date.now(), book.maxDays || 14))}
            onChange={(e) => setReturnDate(e.target.value)} className="input"
          />
          <p className="text-[12px] text-ink-500 mt-1">Максимум {book.maxDays || 14} дней с сегодняшнего дня</p>
        </label>

        {owner ? (
          <div className="card p-4">
            <h3 className="section-title mb-2">Контакты владельца</h3>
            <p className="text-[14px]">{owner.firstName} {owner.lastName} (@{owner.nickname})</p>
            {owner.email ? <p className="text-[14px] text-ink-700">{owner.email}</p> : null}
          </div>
        ) : null}

        {error ? <p className="text-bad text-[13px]">{error}</p> : null}

        <button disabled={submitting} className="btn-primary">
          {submitting ? "..." : "Отправить запрос"}
        </button>
      </form>
    </MobileShell>
  );
}
