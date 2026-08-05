import { useEffect, useRef, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Fab from "../../components/Fab.jsx";
import { listBooks, deleteBook } from "../../firebase/firestore.js";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { debounce } from "../../utils/performanceHelpers.js";
import { cacheService } from "../../utils/cacheService.js";
import { t } from "../../utils/i18n.js";

const FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 90'><rect width='60' height='90' fill='#dde5ee'/></svg>`);

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

export default function AdminBooks() {
  const { community } = useCommunity();
  const navigate = useNavigate();
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [menuFor, setMenuFor] = useState(null);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    function onOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuFor(null);
    }
    if (menuFor) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuFor]);

  // Load books with caching
  const load = useMemo(() => debounce(async () => {
    if (!community?.id) return;

    setLoading(true);
    try {
      const cacheKey = `adminBooks:${community.id}:${search}`;

      // Check cache first
      const cached = cacheService.get(cacheKey);
      if (cached) {
        setBooks(cached);
        setLoading(false);
        return;
      }

      // `search` is a query constraint now, not a filter over the page that
      // came back, so this really is the first 100 matches rather than the
      // matches among the first 100 books.
      const { items } = await listBooks({
        communityId: community.id,
        search,
        pageSize: 100, // Load more for admin view
      });

      // Cache the results
      cacheService.set(cacheKey, items, CACHE_TTL);
      setBooks(items);
    } catch (error) {
      console.error("Failed to load books:", error);
    } finally {
      setLoading(false);
    }
  }, 300), [community?.id]);

  useEffect(() => {
    load();
  }, [community?.id, search, load]);

  async function onDelete(id) {
    if (!confirm("Удалить эту книгу?")) return;
    await deleteBook(id);
    setMenuFor(null);
    // Clear cache and reload
    cacheService.clearPattern(`adminBooks:${community.id}`);
    load();
  }

  if (!community) {
    return <MobileShell><p className="px-6 py-12 text-center text-ink-500">Создайте сообщество, чтобы добавлять книги.</p></MobileShell>;
  }

  return (
    <MobileShell>
      <SearchBar value={search} onChange={setSearch} />
      {loading && books.length === 0 ? (
        <p className="text-ink-400 px-6 py-12 text-center">{t?.loading || "Загрузка..."}</p>
      ) : books.length === 0 ? (
        <p className="text-ink-500 px-6 py-12 text-center">Книг пока нет.</p>
      ) : (
        <ul className="mt-2">
          {books.map((b) => (
            <li key={b.id} className="flex gap-3 px-4 py-3 border-b border-ink-100">
              <img src={b.coverUrl || FALLBACK} alt="" className="w-12 h-16 rounded-md object-cover" />
              <Link to={`/books/${b.id}`} className="flex-1 min-w-0">
                <h4 className="font-semibold text-[15px] truncate">{b.name}</h4>
                <p className="text-[13px] text-ink-500 truncate">{b.author}</p>
              </Link>
              <div className="relative" ref={menuFor === b.id ? menuRef : null}>
                <button onClick={() => setMenuFor(menuFor === b.id ? null : b.id)} className="icon-btn" aria-label="More">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                  </svg>
                </button>
                {menuFor === b.id ? (
                  <div className="absolute right-0 top-12 bg-surface shadow-soft border border-ink-100 rounded-xl py-1 z-10 w-40">
                    <Link to={`/books/${b.id}`} className="block px-4 py-2.5 text-[14px] hover:bg-ink-100 transition" onClick={() => setMenuFor(null)}>
                      Открыть
                    </Link>
                    <button
                      onClick={() => { setMenuFor(null); navigate(`/books/${b.id}/edit`); }}
                      className="block w-full text-left px-4 py-2.5 text-[14px] hover:bg-ink-100 transition"
                    >
                      Редактировать
                    </button>
                    <div className="h-px bg-ink-100 my-1" />
                    <button
                      onClick={() => onDelete(b.id)}
                      className="block w-full text-left px-4 py-2.5 text-[14px] text-bad hover:bg-badSoft transition"
                    >
                      Удалить
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Fab to="/books/add" />
    </MobileShell>
  );
}
