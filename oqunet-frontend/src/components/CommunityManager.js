// src/components/CommunityManager.js - ONE COMMUNITY ONLY
import React, { useState, useEffect, useCallback } from 'react';
import API, { formatApiError, setCurrentUser, clearToken } from '../api';
import ImageUpload from './ImageUpload';

const GENRES = [
  'Роман', 'Әңгіме', 'Поэзия', 'Фантастика', 'Фэнтези',
  'Детектив', 'Триллер', 'Махаббат романы', 'Тарихи шығарма',
  'Ғылыми-көпшілік', 'Өмірбаян', 'Психология', 'Балалар әдебиеті',
  'Өзін-өзі дамыту', 'Діни әдебиет'
];

const CommunityManager = ({ onUserUpdate, onBack }) => {
  const [myCommunity, setMyCommunity] = useState(null);
  const [members, setMembers] = useState([]);
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [newCommunity, setNewCommunity] = useState({
    name: '', description: '', access_code: ''
  });

  const [newBook, setNewBook] = useState({
    title: '', author: '', borrow_days: 14, genre: '', image_url: ''
  });

  const [bookErrors, setBookErrors] = useState({});

  const fetchMyCommunity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await API.get('/communities');
      const communities = res.data.communities || [];
      
      if (communities.length > 0) {
        setMyCommunity(communities[0]); // User can only have one
      } else {
        setMyCommunity(null);
      }
    } catch (err) {
      console.error('Error fetching community:', err);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCommunityDetails = useCallback(async () => {
    if (!myCommunity) return;

    try {
      const [membersRes, booksRes] = await Promise.all([
        API.get(`/communities/${myCommunity.id}/members`),
        API.get(`/books/community/${myCommunity.id}`)
      ]);

      setMembers(membersRes.data.members || []);
      setBooks(booksRes.data.books || []);
    } catch (err) {
      console.error('Error fetching community details:', err);
      alert(formatApiError(err));
    }
  }, [myCommunity]);

  useEffect(() => {
    fetchMyCommunity();
  }, [fetchMyCommunity]);

  useEffect(() => {
    if (myCommunity) {
      fetchCommunityDetails();
    }
  }, [myCommunity, fetchCommunityDetails]);

  const handleCreateCommunity = async (e) => {
    e.preventDefault();

    if (!newCommunity.name || !newCommunity.access_code) {
      alert('Атауы және кіру коды міндетті');
      return;
    }

    if (newCommunity.access_code.length < 4) {
      alert('Кіру коды кем дегенде 4 таңба болуы керек');
      return;
    }

    try {
      const res = await API.post('/communities/create', newCommunity);
      alert(res.data.message);
      
      if (res.data.user) {
        setCurrentUser(res.data.user);
        onUserUpdate(res.data.user);
      }

      setNewCommunity({ name: '', description: '', access_code: '' });
      setShowCreateForm(false);
      await fetchMyCommunity();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const validateBook = () => {
    const errors = {};
    if (!newBook.title.trim()) errors.title = 'Кітап атауы міндетті';
    if (!newBook.borrow_days || newBook.borrow_days < 1) errors.borrow_days = 'Мерзім кем дегенде 1 күн';
    if (!newBook.image_url) errors.image_url = 'Кітап суреті міндетті';
    setBookErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAddBook = async () => {
    if (!myCommunity) {
      alert('Қоғамдастық жоқ');
      return;
    }

    if (!validateBook()) {
      alert('Барлық міндетті өрістерді толтырыңыз');
      return;
    }

    try {
      await API.post('/books/add', {
        ...newBook,
        community_id: myCommunity.id
      });
      alert('Кітап қосылды');
      setNewBook({ title: '', author: '', borrow_days: 14, genre: '', image_url: '' });
      setBookErrors({});
      await fetchCommunityDetails();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const handleDeleteBook = async (bookId) => {
    if (!window.confirm('Кітапты өшіргіңіз келе ме?')) return;

    try {
      await API.delete(`/books/delete/${bookId}`);
      alert('Кітап өшірілді');
      await fetchCommunityDetails();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const handleRemoveMember = async (memberId) => {
    if (!window.confirm('Мүшені қоғамдастықтан шығарғыңыз келе ме?')) return;

    try {
      await API.delete(`/communities/${myCommunity.id}/members/${memberId}`);
      alert('Мүше шығарылды');
      await fetchCommunityDetails();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const handleDeleteCommunity = async () => {
    if (!window.confirm('⚠️ НАЗАР АУДАРЫҢЫЗ!\n\nҚоғамдастықты өшіргіңіз келе ме?\n\nБұл әрекетті қайтару мүмкін емес. Барлық кітаптар мен деректер жойылады.')) return;

    // Double confirmation
    if (!window.confirm('Шынымен өшіргіңіз келе ме? Бұл соңғы растау.')) return;

    try {
      await API.delete(`/communities/delete/${myCommunity.id}`);
      alert('Қоғамдастық өшірілді. Енді басқа қоғамдастыққа қосылуға болады.');
      
      // Clear token and reload to go to JoinCommunity page
      clearToken();
      window.location.reload();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  if (loading) {
    return <div style={{ padding: '20px' }}>Жүктелуде...</div>;
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          {onBack && (
            <button onClick={onBack} style={{
              padding: '8px 16px', backgroundColor: '#6c757d', color: 'white',
              border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'
            }}>← Қайту</button>
          )}
          <h2 style={{ margin: 0 }}>🏘️ Менің қоғамдастығым</h2>
        </div>
        {!myCommunity && (
          <button onClick={() => setShowCreateForm(!showCreateForm)} style={{
            padding: '10px 20px', backgroundColor: '#4CAF50', color: 'white',
            border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'
          }}>
            {showCreateForm ? '✕ Жабу' : '➕ Қоғамдастық құру'}
          </button>
        )}
      </div>

      {/* Info Box */}
      <div style={{
        padding: '15px', backgroundColor: '#e3f2fd', borderRadius: '8px',
        marginBottom: '20px', border: '1px solid #2196F3'
      }}>
        <div style={{ fontSize: '14px', color: '#1976d2' }}>
          💡 <strong>Ескерту:</strong> Әр қолданушы тек 1 қоғамдастық құра алады.
          {myCommunity && ' Қоғамдастықты өшіру үшін алдымен барлық мүшелер мен кітаптарды өшіріңіз.'}
        </div>
      </div>

      {/* Create Community Form */}
      {showCreateForm && !myCommunity && (
        <div style={{
          padding: '20px', backgroundColor: 'white', borderRadius: '8px',
          marginBottom: '20px', border: '2px solid #4CAF50', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <h3>✨ Жаңа қоғамдастық құру</h3>
          <form onSubmit={handleCreateCommunity}>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>Атауы *</label>
              <input value={newCommunity.name}
                onChange={e => setNewCommunity({ ...newCommunity, name: e.target.value })}
                placeholder="Мысалы: 101-қонақ үй"
                style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>Сипаттама</label>
              <textarea value={newCommunity.description}
                onChange={e => setNewCommunity({ ...newCommunity, description: e.target.value })}
                placeholder="Қоғамдастық туралы қысқаша ақпарат" rows={3}
                style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box', resize: 'vertical' }}
              />
            </div>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>Кіру коды *</label>
              <input value={newCommunity.access_code}
                onChange={e => setNewCommunity({ ...newCommunity, access_code: e.target.value.toUpperCase() })}
                placeholder="DORM123" maxLength={20}
                style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box', textTransform: 'uppercase', fontFamily: 'monospace' }}
              />
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                💡 Басқа адамдар бұл кодты пайдаланып қоғамдастыққа қосылады
              </div>
            </div>
            <button type="submit" style={{
              padding: '10px 20px', backgroundColor: '#4CAF50', color: 'white',
              border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'
            }}>✓ Құру</button>
          </form>
        </div>
      )}

      {!myCommunity && !showCreateForm ? (
        <div style={{
          padding: '40px', textAlign: 'center', backgroundColor: 'white',
          borderRadius: '8px', border: '1px solid #ddd'
        }}>
          <p style={{ fontSize: '18px', color: '#666', marginBottom: '10px' }}>
            Сізде әлі қоғамдастық жоқ
          </p>
          <p style={{ fontSize: '14px', color: '#999' }}>
            Жоғарыдағы "Қоғамдастық құру" батырмасын басып құрыңыз
          </p>
        </div>
      ) : myCommunity && (
        <div>
          {/* Community Info */}
          <div style={{
            padding: '20px', backgroundColor: 'white', borderRadius: '8px',
            marginBottom: '20px', border: '2px solid #2196F3', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div>
                <h3 style={{ margin: '0 0 10px 0' }}>{myCommunity.name}</h3>
                {myCommunity.description && (
                  <p style={{ margin: '0 0 10px 0', color: '#666' }}>{myCommunity.description}</p>
                )}
                <div style={{
                  display: 'inline-block', padding: '6px 12px', backgroundColor: '#e3f2fd',
                  color: '#1976d2', borderRadius: '4px', fontFamily: 'monospace', fontWeight: 'bold'
                }}>
                  🔑 Кіру коды: {myCommunity.access_code}
                </div>
              </div>
              <button onClick={handleDeleteCommunity} style={{
                padding: '8px 16px', backgroundColor: '#f44336', color: 'white',
                border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'
              }}>🗑️ Өшіру</button>
            </div>
          </div>

          {/* Add Book Form */}
          <div style={{
            padding: '20px', backgroundColor: 'white', borderRadius: '8px',
            marginBottom: '20px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            <h3>📚 Кітап қосу</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
              <div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: '500' }}>Атауы *</label>
                  <input value={newBook.title}
                    onChange={e => setNewBook({ ...newBook, title: e.target.value })}
                    placeholder="Кітап атауы"
                    style={{ width: '100%', padding: '10px', border: bookErrors.title ? '2px solid #f44336' : '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                  />
                  {bookErrors.title && <div style={{ color: '#f44336', fontSize: '12px', marginTop: '4px' }}>{bookErrors.title}</div>}
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: '500' }}>Автор</label>
                  <input value={newBook.author}
                    onChange={e => setNewBook({ ...newBook, author: e.target.value })}
                    placeholder="Автор аты"
                    style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: '500' }}>Жанр</label>
                  <select value={newBook.genre}
                    onChange={e => setNewBook({ ...newBook, genre: e.target.value })}
                    style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box', backgroundColor: 'white' }}
                  >
                    <option value="">-- Жанр таңдаңыз --</option>
                    {GENRES.map(genre => <option key={genre} value={genre}>{genre}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: '500' }}>Мерзімі (күн) *</label>
                  <input type="number" min={1} value={newBook.borrow_days}
                    onChange={e => setNewBook({ ...newBook, borrow_days: parseInt(e.target.value) || 1 })}
                    style={{ width: '100%', padding: '10px', border: bookErrors.borrow_days ? '2px solid #f44336' : '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                  />
                  {bookErrors.borrow_days && <div style={{ color: '#f44336', fontSize: '12px', marginTop: '4px' }}>{bookErrors.borrow_days}</div>}
                </div>
              </div>
              <div>
                <ImageUpload value={newBook.image_url}
                  onChange={(url) => setNewBook({ ...newBook, image_url: url })}
                  error={bookErrors.image_url}
                />
              </div>
            </div>
            <button onClick={handleAddBook} style={{
              padding: '12px 24px', backgroundColor: '#4CAF50', color: 'white',
              border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '15px'
            }}>➕ Қосу</button>
          </div>

          {/* Books List */}
          <div style={{
            padding: '20px', backgroundColor: 'white', borderRadius: '8px',
            marginBottom: '20px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            <h3>📚 Кітаптар ({books.length})</h3>
            {books.length === 0 ? (
              <p style={{ color: '#666' }}>Кітаптар жоқ</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '15px' }}>
                {books.map(book => (
                  <div key={book.id} style={{
                    backgroundColor: '#f9f9f9', borderRadius: '8px',
                    overflow: 'hidden', border: '1px solid #ddd'
                  }}>
                    <div style={{ width: '100%', height: '200px', backgroundColor: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {book.image_url ? (
                        <img src={book.image_url} alt={book.title}
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          onError={(e) => {
                            e.target.style.display = 'none';
                            e.target.parentElement.innerHTML = '<div style="padding: 20px; color: #999; text-align: center;">📚<br/><small>Сурет жоқ</small></div>';
                          }}
                        />
                      ) : (
                        <div style={{ fontSize: '64px', color: '#bbb' }}>📚</div>
                      )}
                    </div>
                    <div style={{ padding: '15px' }}>
                      <strong style={{ display: 'block', marginBottom: '4px' }}>{book.title}</strong>
                      {book.author && <span style={{ color: '#666', fontSize: '13px', display: 'block', marginBottom: '4px' }}>✍️ {book.author}</span>}
                      {book.genre && <span style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '8px' }}>📚 {book.genre}</span>}
                      <span style={{ fontSize: '13px', color: '#999', display: 'block', marginBottom: '8px' }}>⏰ ({book.borrow_days} күн)</span>
                      {book.holder && <span style={{ fontSize: '13px', color: '#ff9800', display: 'block', marginBottom: '8px' }}>📚 {book.holder.name}</span>}
                      <button onClick={() => handleDeleteBook(book.id)} style={{
                        width: '100%', padding: '8px', backgroundColor: '#f44336', color: 'white',
                        border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: '500'
                      }}>🗑️ Өшіру</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Members List */}
          <div style={{
            padding: '20px', backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            <h3>👥 Мүшелер ({members.length})</h3>
            {members.length === 0 ? (
              <p style={{ color: '#666' }}>Мүшелер жоқ</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {members.map(member => {
                  const isOwner = member.id === myCommunity.owner_id;
                  return (
                    <li key={member.id} style={{
                      padding: '12px', marginBottom: '8px', backgroundColor: '#f9f9f9',
                      borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <div>
                        <strong>{member.name}</strong>
                        <span style={{ color: '#666', marginLeft: '10px' }}>{member.email}</span>
                        {member.phone && <span style={{ color: '#666', marginLeft: '10px' }}>📞 {member.phone}</span>}
                        {isOwner && (
                          <span style={{
                            marginLeft: '10px', padding: '3px 8px', backgroundColor: '#ff9800',
                            color: 'white', borderRadius: '12px', fontSize: '11px', fontWeight: 'bold'
                          }}>ИЕ</span>
                        )}
                      </div>
                      {!isOwner && (
                        <button onClick={() => handleRemoveMember(member.id)} style={{
                          padding: '6px 12px', backgroundColor: '#ff9800', color: 'white',
                          border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                        }}>🚪 Шығару</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CommunityManager;