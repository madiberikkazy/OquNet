// src/components/AdminPanel.js - COMPLETE VERSION WITH IMAGE SUPPORT
import React, { useEffect, useState } from 'react';
import API, { formatApiError } from '../api';

const AdminPanel = () => {
  const [books, setBooks] = useState([]);
  const [users, setUsers] = useState([]);
  const [communities, setCommunities] = useState([]);
  const [bookId, setBookId] = useState('');
  const [userId, setUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedCommunityFilter, setSelectedCommunityFilter] = useState('');
  
  // Forms - ADDED image_url
  const [newBook, setNewBook] = useState({ 
    title: '', 
    author: '', 
    community_id: '', 
    borrow_days: 14,
    image_url: ''  // NEW FIELD
  });
  const [newCommunity, setNewCommunity] = useState({ name: '', description: '', access_code: '' });

  useEffect(() => {
    console.log('AdminPanel mounted');
    fetchData();
  }, []);

  useEffect(() => {
    console.log('Communities state updated:', communities);
  }, [communities]);

  const fetchData = async () => {
    setLoading(true);
    try {
      console.log('🔄 Fetching data from API...');
      
      const [booksRes, usersRes, communitiesRes] = await Promise.all([
        API.get('/books'),
        API.get('/users'),
        API.get('/communities')
      ]);
      
      console.log('📦 Raw API responses:');
      console.log('- Books:', booksRes.data);
      console.log('- Users:', usersRes.data);
      console.log('- Communities:', communitiesRes.data);
      
      let communitiesArray = [];
      
      if (communitiesRes.data) {
        if (Array.isArray(communitiesRes.data.communities)) {
          communitiesArray = communitiesRes.data.communities;
        } else if (Array.isArray(communitiesRes.data)) {
          communitiesArray = communitiesRes.data;
        } else if (communitiesRes.data.data && Array.isArray(communitiesRes.data.data)) {
          communitiesArray = communitiesRes.data.data;
        }
      }
      
      console.log('✅ Parsed arrays:');
      console.log('- Books count:', booksRes.data.books?.length || 0);
      console.log('- Users count:', usersRes.data.users?.length || 0);
      console.log('- Communities count:', communitiesArray.length);
      
      setBooks(booksRes.data.books || []);
      setUsers(usersRes.data.users || []);
      setCommunities(communitiesArray);
      
      console.log('✅ State updated successfully');
    } catch (err) {
      console.error('❌ Fetch error:', err);
      console.error('Error details:', err.response?.data);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const assignBook = async () => {
    try {
      await API.post('/books/assign', { book_id: bookId, user_id: userId });
      alert('Кітап берілді');
      setBookId('');
      setUserId('');
      await fetchData();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const returnBook = async () => {
    try {
      await API.post('/books/return', { book_id: bookId });
      alert('Кітап қайтарылды');
      setBookId('');
      await fetchData();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const addBook = async () => {
    console.log('Adding book with data:', newBook);
    if (!newBook.title || !newBook.community_id) {
      alert('Кітап атауы және қоғамдастық міндетті');
      return;
    }
    if (!newBook.borrow_days || newBook.borrow_days < 1) {
      alert('Беру мерзімі кем дегенде 1 күн болуы керек');
      return;
    }
    try {
      const payload = {
        title: newBook.title,
        author: newBook.author,
        community_id: newBook.community_id ? parseInt(newBook.community_id, 10) : null,
        borrow_days: parseInt(newBook.borrow_days, 10) || 14,
        image_url: newBook.image_url || null  // INCLUDE IMAGE URL
      };
      console.log('Adding book with data:', payload);
      const response = await API.post('/books/add', payload);
      console.log('Book added:', response.data);
      alert('Кітап қосылды');
      setNewBook({ title: '', author: '', community_id: '', borrow_days: 14, image_url: '' });
      await fetchData();
    } catch (err) {
      console.error('Error adding book:', err);
      alert(formatApiError(err));
    }
  };

  const addCommunity = async () => {
    console.log('Adding community with data:', newCommunity);
    if (!newCommunity.name) {
      alert('Қоғамдастық атауы міндетті');
      return;
    }
    if (!newCommunity.access_code || newCommunity.access_code.length < 4) {
      alert('Кіру коды міндетті (кем дегенде 4 таңба)');
      return;
    }
    try {
      const response = await API.post('/communities/add', newCommunity);
      console.log('Community added:', response.data);
      alert(`Қоғамдастық қосылды! Кіру коды: ${newCommunity.access_code}`);
      setNewCommunity({ name: '', description: '', access_code: '' });
      await fetchData();
    } catch (err) {
      console.error('Error adding community:', err);
      alert(formatApiError(err));
    }
  };

  const deleteBook = async (id) => {
    if (window.confirm('Кітапты өшіргіңіз келе ме?')) {
      try {
        await API.delete(`/books/delete/${id}`);
        alert('Кітап өшірілді');
        await fetchData();
      } catch (err) {
        alert(formatApiError(err));
      }
    }
  };

  const deleteCommunity = async (id) => {
    if (window.confirm('Қоғамдастықты өшіргіңіз келе ме?')) {
      try {
        await API.delete(`/communities/delete/${id}`);
        alert('Қоғамдастық өшірілді');
        await fetchData();
      } catch (err) {
        alert(formatApiError(err));
      }
    }
  };

  const deleteUser = async (id) => {
    if (window.confirm('Пайдаланушыны өшіргіңіз келе ме?')) {
      try {
        await API.delete(`/users/delete/${id}`);
        alert('Пайдаланушы өшірілді');
        await fetchData();
      } catch (err) {
        alert(formatApiError(err));
      }
    }
  };

  if (loading) {
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Admin Panel</h2>
        <button onClick={fetchData} style={{ padding: '8px 16px', cursor: 'pointer' }}>🔄 Жаңарту</button>
      </div>
      
      {/* Add Community */}
      <section style={{ marginTop: '16px', padding: '16px', border: '2px solid #4CAF50', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
        <h3>✨ Қоғамдастық қосу</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="Атауы *"
            value={newCommunity.name}
            onChange={e => setNewCommunity({ ...newCommunity, name: e.target.value })}
            style={{ padding: '10px', width: '200px', border: '1px solid #ddd', borderRadius: '4px' }}
          />
          <input
            placeholder="Сипаттама"
            value={newCommunity.description}
            onChange={e => setNewCommunity({ ...newCommunity, description: e.target.value })}
            style={{ padding: '10px', width: '250px', border: '1px solid #ddd', borderRadius: '4px' }}
          />
          <input
            placeholder="Кіру коды * (мысалы: DORM123)"
            value={newCommunity.access_code}
            onChange={e => setNewCommunity({ ...newCommunity, access_code: e.target.value.toUpperCase() })}
            style={{ padding: '10px', width: '220px', border: '1px solid #ddd', borderRadius: '4px', textTransform: 'uppercase' }}
            maxLength={20}
          />
          <button 
            onClick={addCommunity} 
            style={{ 
              padding: '10px 20px', 
              cursor: 'pointer', 
              backgroundColor: '#4CAF50', 
              color: 'white', 
              border: 'none', 
              borderRadius: '4px',
              fontWeight: 'bold'
            }}
          >
            ➕ Қосу
          </button>
        </div>
        <div style={{ 
          marginTop: '10px', 
          padding: '10px', 
          backgroundColor: '#e8f5e9', 
          borderRadius: '4px',
          fontSize: '13px', 
          color: '#2e7d32' 
        }}>
          💡 Кіру коды: Студенттер қоғамдастыққа қосылу үшін осы кодты қолданады
        </div>
      </section>

      {/* Add Book - UPDATED WITH IMAGE */}
      <section style={{ marginTop: '16px', padding: '16px', border: '2px solid #2196F3', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
        <h3>📚 Кітап қосу</h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
          {/* Left Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input
              placeholder="Кітап атауы *"
              value={newBook.title}
              onChange={e => setNewBook({ ...newBook, title: e.target.value })}
              style={{ padding: '10px', border: '1px solid #ddd', borderRadius: '4px' }}
            />
            <input
              placeholder="Автор"
              value={newBook.author}
              onChange={e => setNewBook({ ...newBook, author: e.target.value })}
              style={{ padding: '10px', border: '1px solid #ddd', borderRadius: '4px' }}
            />
            <input
              type="number"
              min={1}
              placeholder="Беру мерзімі (күн) *"
              value={newBook.borrow_days}
              onChange={e => setNewBook({ ...newBook, borrow_days: parseInt(e.target.value, 10) || 1 })}
              style={{ padding: '10px', border: '1px solid #ddd', borderRadius: '4px' }}
            />
            <select
              value={newBook.community_id}
              onChange={e => {
                const value = e.target.value;
                setNewBook({ ...newBook, community_id: value });
              }}
              style={{ padding: '10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
            >
              <option value="">-- Қоғамдастық таңдаңыз ({communities.length} бар) --</option>
              {communities.length > 0 ? (
                communities.map((c, index) => {
                  const communityId = c.id || c._id;
                  return (
                    <option key={communityId || index} value={communityId}>
                      {c.name} (ID: {communityId})
                    </option>
                  );
                })
              ) : (
                <option value="" disabled>Қоғамдастықтар жоқ!</option>
              )}
            </select>
          </div>

          {/* Right Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input
              placeholder="Кітап суреті (URL)"
              value={newBook.image_url}
              onChange={e => setNewBook({ ...newBook, image_url: e.target.value })}
              style={{ padding: '10px', border: '1px solid #ddd', borderRadius: '4px' }}
            />

            {/* Image Preview */}
            {newBook.image_url ? (
              <div style={{ 
                padding: '10px', 
                border: '1px solid #ddd', 
                borderRadius: '4px',
                backgroundColor: 'white',
                textAlign: 'center',
                minHeight: '150px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <img 
                  src={newBook.image_url} 
                  alt="Кітап суреті"
                  style={{ 
                    maxWidth: '100%', 
                    maxHeight: '200px', 
                    objectFit: 'contain',
                    borderRadius: '4px'
                  }}
                  onError={(e) => {
                    e.target.style.display = 'none';
                    const parent = e.target.parentElement;
                    parent.innerHTML = '<div style="padding: 20px; color: #f44336; text-align: center;">❌ Сурет жүктелмеді<br/><small>URL тексеріңіз</small></div>';
                  }}
                />
              </div>
            ) : (
              <div style={{ 
                padding: '20px', 
                border: '1px dashed #ddd', 
                borderRadius: '4px',
                backgroundColor: '#fafafa',
                textAlign: 'center',
                color: '#999',
                minHeight: '150px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px'
              }}>
                🖼️ Кітап суреті<br/>көрінеді
              </div>
            )}
          </div>
        </div>

        <button 
          onClick={addBook} 
          style={{ 
            padding: '12px 24px', 
            cursor: 'pointer', 
            backgroundColor: '#2196F3', 
            color: 'white', 
            border: 'none', 
            borderRadius: '4px',
            fontWeight: 'bold',
            fontSize: '15px'
          }}
        >
          ➕ Кітап қосу
        </button>

        <div style={{ 
          marginTop: '15px', 
          padding: '12px', 
          backgroundColor: '#e3f2fd', 
          borderRadius: '4px',
          fontSize: '13px', 
          color: '#1976d2' 
        }}>
          💡 <strong>Кітап суретін қалай қосамын?</strong><br/>
          1. Кітап суретін интернетке жүктеңіз (imgur.com, imgbb.com, postimages.org)<br/>
          2. Сурет сілтемесін (URL) көшіріп, "Кітап суреті" өрісіне қойыңыз<br/>
          3. Немесе Google Images-тен сурет тауып, оң жақпен басып "Copy image address" таңдаңыз<br/>
          4. Мысал: https://covers.openlibrary.org/b/id/12345-L.jpg
        </div>
      </section>

      {/* Assign/Return Book */}
      <section style={{ marginTop: '16px', padding: '16px', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h3>📖 Кітап беру/қайтару</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select 
            value={bookId} 
            onChange={e => setBookId(e.target.value)} 
            style={{ padding: '8px', width: '300px' }}
          >
            <option value="">Кітап таңдаңыз</option>
            {books.map(b => (
              <option key={b.id || b._id} value={b.id || b._id}>
                {b.title} {b.holder ? `(${b.holder.name})` : '(Бос)'}
              </option>
            ))}
          </select>

          <select 
            value={userId} 
            onChange={e => setUserId(e.target.value)} 
            style={{ padding: '8px', width: '250px' }}
          >
            <option value="">Пайдаланушы таңдаңыз</option>
            {users.filter(u => u.role !== 'admin').map(u => (
              <option key={u.id || u._id} value={u.id || u._id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>

          <button 
            onClick={async () => { 
              if (!bookId || !userId) return alert('Кітап пен пайдаланушы таңдалуы керек'); 
              await assignBook(); 
            }} 
            style={{ padding: '8px 16px', cursor: 'pointer' }}
          >
            📚 Беру
          </button>
          <button 
            onClick={async () => { 
              if (!bookId) return alert('Кітап таңдалуы керек'); 
              await returnBook(); 
            }} 
            style={{ padding: '8px 16px', cursor: 'pointer' }}
          >
            ↩️ Қайтару
          </button>
        </div>
      </section>

      {/* Communities List */}
      <section style={{ marginTop: '20px' }}>
        <h3>📋 Қоғамдастықтар ({communities.length})</h3>
        {communities.length === 0 ? (
          <div style={{ padding: '20px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px' }}>
            ⚠️ Қоғамдастықтар жоқ. Жоғарыда қосыңыз!
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {communities.map(c => {
              const communityId = c.id || c._id;
              return (
                <li key={communityId} style={{ padding: '15px', marginBottom: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px', borderLeft: '4px solid #4CAF50' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '4px' }}>
                        {c.name}
                      </div>
                      {c.description && (
                        <div style={{ fontSize: '13px', color: '#666', marginBottom: '6px' }}>
                          {c.description}
                        </div>
                      )}
                      <div style={{ 
                        display: 'inline-block',
                        padding: '4px 12px', 
                        backgroundColor: '#e3f2fd', 
                        color: '#1976d2',
                        borderRadius: '4px',
                        fontSize: '13px',
                        fontWeight: '600',
                        fontFamily: 'monospace'
                      }}>
                        🔑 Кіру коды: {c.access_code}
                      </div>
                    </div>
                    <button 
                      onClick={() => deleteCommunity(communityId)} 
                      style={{ padding: '8px 16px', color: 'white', backgroundColor: '#f44336', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      🗑️ Өшіру
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Books List - WITH IMAGES */}
      <section style={{ marginTop: '20px' }}>
        <h3>📚 Кітаптар ({books.length})</h3>
        {books.length === 0 ? (
          <div>Кітаптар жоқ</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '15px' }}>
            {books.map(b => {
              const bookId = b.id || b._id;
              return (
                <div key={bookId} style={{ 
                  padding: '15px', 
                  backgroundColor: '#f5f5f5', 
                  borderRadius: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px'
                }}>
                  {/* Book Image */}
                  {b.image_url ? (
                    <div style={{ 
                      width: '100%', 
                      height: '200px', 
                      backgroundColor: '#fff',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      border: '1px solid #ddd'
                    }}>
                      <img 
                        src={b.image_url} 
                        alt={b.title}
                        style={{ 
                          maxWidth: '100%', 
                          maxHeight: '100%', 
                          objectFit: 'contain'
                        }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                          e.target.parentElement.innerHTML = '<div style="padding: 20px; color: #999; text-align: center;">📚<br/><small>Сурет жоқ</small></div>';
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ 
                      width: '100%', 
                      height: '200px', 
                      backgroundColor: '#e0e0e0',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#999',
                      fontSize: '48px'
                    }}>
                      📚
                    </div>
                  )}

                  {/* Book Info */}
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: '15px', marginBottom: '4px' }}>
                      {b.title}
                    </div>
                    {b.author && (
                      <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>
                        {b.author}
                      </div>
                    )}
                    <div style={{ fontSize: '12px', color: '#999' }}>
                      {b.Community?.name || b.community?.name || '—'}
                    </div>
                    {b.holder && (
                      <div style={{ fontSize: '12px', color: '#ff9800', marginTop: '4px' }}>
                        Holder: {b.holder.name}
                      </div>
                    )}
                  </div>

                  <button 
                    onClick={() => deleteBook(bookId)} 
                    style={{ 
                      padding: '8px', 
                      color: 'white', 
                      backgroundColor: '#f44336', 
                      border: 'none', 
                      borderRadius: '4px', 
                      cursor: 'pointer',
                      fontWeight: '500',
                      fontSize: '13px'
                    }}
                  >
                    🗑️ Өшіру
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Users List */}
      <section style={{ marginTop: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h3 style={{ margin: 0 }}>👥 Пайдаланушылар ({users.filter(u => selectedCommunityFilter === '' || u.community_id === parseInt(selectedCommunityFilter)).length})</h3>
          <select
            value={selectedCommunityFilter}
            onChange={e => setSelectedCommunityFilter(e.target.value)}
            style={{ padding: '8px', width: '250px', border: '1px solid #ddd', borderRadius: '4px' }}
          >
            <option value="">-- Барлық қоғамдастықтар --</option>
            {communities.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {users.length === 0 ? (
          <div>Пайдаланушылар жоқ</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {users
              .filter(u => selectedCommunityFilter === '' || u.community_id === parseInt(selectedCommunityFilter))
              .map(u => {
                const userId = u.id || u._id;
                return (
                  <li key={userId} style={{ 
                    padding: '12px', 
                    marginBottom: '8px',
                    backgroundColor: '#f9f9f9',
                    borderRadius: '4px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <strong>{u.name}</strong> - {u.email}
                      <span style={{ 
                        marginLeft: '10px', 
                        padding: '3px 10px', 
                        background: u.role === 'admin' ? '#ff9800' : '#4CAF50', 
                        color: 'white', 
                        borderRadius: '12px', 
                        fontSize: '12px',
                        fontWeight: '500'
                      }}>
                        {u.role === 'admin' ? 'Админ' : 'Қолданушы'}
                      </span>
                      {u.community && (
                        <span style={{ 
                          marginLeft: '10px',
                          padding: '3px 10px',
                          backgroundColor: '#e3f2fd',
                          color: '#1976d2',
                          borderRadius: '12px',
                          fontSize: '11px'
                        }}>
                          🏘️ {u.community.name}
                        </span>
                      )}
                    </div>
                    {u.role !== 'admin' && (
                      <button
                        onClick={() => deleteUser(userId)}
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
                        🗑️ Өшіру
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
};

export default AdminPanel;