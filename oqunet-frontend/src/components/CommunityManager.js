// src/components/CommunityManager.js
import React, { useState, useEffect, useCallback } from 'react';
import API, { formatApiError, setCurrentUser } from '../api';
import ImageUpload from './ImageUpload';

const GENRES = [
  'Роман',
  'Әңгіме',
  'Поэзия',
  'Фантастика',
  'Фэнтези',
  'Детектив',
  'Триллер',
  'Махаббат романы',
  'Тарихи шығарма',
  'Ғылыми-көпшілік',
  'Өмірбаян',
  'Психология',
  'Балалар әдебиеті',
  'Өзін-өзі дамыту',
  'Діни әдебиет'
];

const CommunityManager = ({ onUserUpdate, onBack }) => {
  const [myCommunities, setMyCommunities] = useState([]);
  const [selectedCommunity, setSelectedCommunity] = useState(null);
  const [members, setMembers] = useState([]);
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [newCommunity, setNewCommunity] = useState({
    name: '',
    description: '',
    access_code: ''
  });

  const [newBook, setNewBook] = useState({
    title: '',
    author: '',
    borrow_days: 14,
    genre: '',
    image_url: ''
  });

  const [bookErrors, setBookErrors] = useState({});

  const fetchMyCommunities = useCallback(async () => {
    setLoading(true);
    try {
      const res = await API.get('/communities');
      const communities = res.data.communities || [];
      setMyCommunities(communities);
      
      if (communities.length > 0 && !selectedCommunity) {
        setSelectedCommunity(communities[0]);
      }
    } catch (err) {
      console.error('Error fetching communities:', err);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, [selectedCommunity]);

  const fetchCommunityDetails = useCallback(async () => {
    if (!selectedCommunity) return;

    try {
      const [membersRes, booksRes] = await Promise.all([
        API.get(`/communities/${selectedCommunity.id}/members`),
        API.get(`/books/community/${selectedCommunity.id}`)
      ]);

      setMembers(membersRes.data.members || []);
      setBooks(booksRes.data.books || []);
    } catch (err) {
      console.error('Error fetching community details:', err);
      alert(formatApiError(err));
    }
  }, [selectedCommunity]);

  useEffect(() => {
    fetchMyCommunities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedCommunity) {
      fetchCommunityDetails();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCommunity]);

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
      
      // Update user in localStorage with new community
      if (res.data.user) {
        setCurrentUser(res.data.user);
        onUserUpdate(res.data.user);
      }

      setNewCommunity({ name: '', description: '', access_code: '' });
      setShowCreateForm(false);
      await fetchMyCommunities();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const handleAddBook = async () => {
    if (!newBook.title || !selectedCommunity) {
      alert('Кітап атауы міндетті');
      return;
    }

    try {
      await API.post('/books/add', {
        ...newBook,
        community_id: selectedCommunity.id
      });
      alert('Кітап қосылды');
      setNewBook({ title: '', author: '', borrow_days: 14 });
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
      await API.delete(`/communities/${selectedCommunity.id}/members/${memberId}`);
      alert('Мүше шығарылды');
      await fetchCommunityDetails();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const handleDeleteCommunity = async (communityId) => {
    if (!window.confirm('Қоғамдастықты өшіргіңіз келе ме? Барлық кітаптар жойылады!')) return;

    try {
      await API.delete(`/communities/delete/${communityId}`);
      alert('Қоғамдастық өшірілді');
      setSelectedCommunity(null);
      await fetchMyCommunities();
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
            <button
              onClick={onBack}
              style={{
                padding: '8px 16px',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              ← Қайту
            </button>
          )}
          <h2 style={{ margin: 0 }}>🏘️ Менің қоғамдастықтарым</h2>
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          style={{
            padding: '10px 20px',
            backgroundColor: '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
        >
          {showCreateForm ? '✕ Жабу' : '➕ Жаңа қоғамдастық'}
        </button>
      </div>

      {/* Create Community Form */}
      {showCreateForm && (
        <div style={{
          padding: '20px',
          backgroundColor: 'white',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '2px solid #4CAF50'
        }}>
          <h3>✨ Жаңа қоғамдастық құру</h3>
          <form onSubmit={handleCreateCommunity}>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Атауы *
              </label>
              <input
                value={newCommunity.name}
                onChange={e => setNewCommunity({ ...newCommunity, name: e.target.value })}
                placeholder="Мысалы: 101-қонақ үй"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Сипаттама
              </label>
              <textarea
                value={newCommunity.description}
                onChange={e => setNewCommunity({ ...newCommunity, description: e.target.value })}
                placeholder="Қоғамдастық туралы қысқаша ақпарат"
                rows={3}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Кіру коды *
              </label>
              <input
                value={newCommunity.access_code}
                onChange={e => setNewCommunity({ ...newCommunity, access_code: e.target.value.toUpperCase() })}
                placeholder="DORM123"
                maxLength={20}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  textTransform: 'uppercase',
                  fontFamily: 'monospace'
                }}
              />
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                💡 Басқа адамдар бұл кодты пайдаланып қоғамдастыққа қосылады
              </div>
            </div>

            <button
              type="submit"
              style={{
                padding: '10px 20px',
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              ✓ Құру
            </button>
          </form>
        </div>
      )}

      {myCommunities.length === 0 ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          backgroundColor: 'white',
          borderRadius: '8px',
          border: '1px solid #ddd'
        }}>
          <p style={{ fontSize: '18px', color: '#666', marginBottom: '10px' }}>
            Сізде әлі қоғамдастық жоқ
          </p>
          <p style={{ fontSize: '14px', color: '#999' }}>
            Жоғарыдағы "Жаңа қоғамдастық" батырмасын басып құрыңыз
          </p>
        </div>
      ) : (
        <>
          {/* Community Tabs */}
          <div style={{
            display: 'flex',
            gap: '10px',
            marginBottom: '20px',
            flexWrap: 'wrap'
          }}>
            {myCommunities.map(community => (
              <button
                key={community.id}
                onClick={() => setSelectedCommunity(community)}
                style={{
                  padding: '10px 20px',
                  backgroundColor: selectedCommunity?.id === community.id ? '#2196F3' : 'white',
                  color: selectedCommunity?.id === community.id ? 'white' : '#333',
                  border: '2px solid #2196F3',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: '500'
                }}
              >
                {community.name}
              </button>
            ))}
          </div>

          {selectedCommunity && (
            <div>
              {/* Community Info */}
              <div style={{
                padding: '20px',
                backgroundColor: 'white',
                borderRadius: '8px',
                marginBottom: '20px',
                border: '2px solid #2196F3'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <h3 style={{ margin: '0 0 10px 0' }}>{selectedCommunity.name}</h3>
                    {selectedCommunity.description && (
                      <p style={{ margin: '0 0 10px 0', color: '#666' }}>{selectedCommunity.description}</p>
                    )}
                    <div style={{
                      display: 'inline-block',
                      padding: '6px 12px',
                      backgroundColor: '#e3f2fd',
                      color: '#1976d2',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontWeight: 'bold'
                    }}>
                      🔑 Кіру коды: {selectedCommunity.access_code}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteCommunity(selectedCommunity.id)}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: '#f44336',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 'bold'
                    }}
                  >
                    🗑️ Өшіру
                  </button>
                </div>
              </div>

              {/* Add Book Form */}
              <div style={{
                padding: '20px',
                backgroundColor: 'white',
                borderRadius: '8px',
                marginBottom: '20px'
              }}>
                <h3>📚 Кітап қосу</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1', minWidth: '200px' }}>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px' }}>
                      Атауы *
                    </label>
                    <input
                      value={newBook.title}
                      onChange={e => setNewBook({ ...newBook, title: e.target.value })}
                      placeholder="Кітап атауы"
                      style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ flex: '1', minWidth: '200px' }}>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px' }}>
                      Автор
                    </label>
                    <input
                      value={newBook.author}
                      onChange={e => setNewBook({ ...newBook, author: e.target.value })}
                      placeholder="Автор аты"
                      style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ flex: '0 0 120px' }}>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px' }}>
                      Мерзімі (күн)
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={newBook.borrow_days}
                      onChange={e => setNewBook({ ...newBook, borrow_days: parseInt(e.target.value) || 1 })}
                      style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <button
                    onClick={handleAddBook}
                    style={{
                      padding: '10px 20px',
                      backgroundColor: '#4CAF50',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      height: '42px'
                    }}
                  >
                    ➕ Қосу
                  </button>
                </div>
              </div>

              {/* Books List */}
              <div style={{
                padding: '20px',
                backgroundColor: 'white',
                borderRadius: '8px',
                marginBottom: '20px'
              }}>
                <h3>📚 Кітаптар ({books.length})</h3>
                {books.length === 0 ? (
                  <p style={{ color: '#666' }}>Кітаптар жоқ</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {books.map(book => (
                      <li key={book.id} style={{
                        padding: '12px',
                        marginBottom: '8px',
                        backgroundColor: '#f9f9f9',
                        borderRadius: '4px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <div>
                          <strong>{book.title}</strong>
                          {book.author && <span style={{ color: '#666', marginLeft: '10px' }}>— {book.author}</span>}
                          <span style={{ marginLeft: '10px', fontSize: '13px', color: '#999' }}>
                            ({book.borrow_days} күн)
                          </span>
                          {book.holder && (
                            <span style={{ marginLeft: '10px', fontSize: '13px', color: '#ff9800' }}>
                              📚 {book.holder.name}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => handleDeleteBook(book.id)}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: '#f44336',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          🗑️
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Members List */}
              <div style={{
                padding: '20px',
                backgroundColor: 'white',
                borderRadius: '8px'
              }}>
                <h3>👥 Мүшелер ({members.length})</h3>
                {members.length === 0 ? (
                  <p style={{ color: '#666' }}>Мүшелер жоқ</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {members.map(member => {
                      const isOwner = member.id === selectedCommunity.owner_id;
                      return (
                        <li key={member.id} style={{
                          padding: '12px',
                          marginBottom: '8px',
                          backgroundColor: '#f9f9f9',
                          borderRadius: '4px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}>
                          <div>
                            <strong>{member.name}</strong>
                            <span style={{ color: '#666', marginLeft: '10px' }}>{member.email}</span>
                            {member.phone && (
                              <span style={{ color: '#666', marginLeft: '10px' }}>📞 {member.phone}</span>
                            )}
                            {isOwner && (
                              <span style={{
                                marginLeft: '10px',
                                padding: '3px 8px',
                                backgroundColor: '#ff9800',
                                color: 'white',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 'bold'
                              }}>
                                ИЕ
                              </span>
                            )}
                          </div>
                          {!isOwner && (
                            <button
                              onClick={() => handleRemoveMember(member.id)}
                              style={{
                                padding: '6px 12px',
                                backgroundColor: '#ff9800',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '12px'
                              }}
                            >
                              🚪 Шығару
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CommunityManager;