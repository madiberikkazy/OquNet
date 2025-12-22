// src/components/UserSettings.js
import React, { useState, useEffect } from 'react';
import API, { formatApiError, clearToken, getCurrentUser, setCurrentUser } from '../api';

const UserSettings = ({ onLogout, onUserUpdate }) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [checkingBooks, setCheckingBooks] = useState(true);
  const user = getCurrentUser();
  
  const [profileForm, setProfileForm] = useState({
    name: user.name || '',
    email: user.email || '',
    phone: user.phone || ''
  });
  const [hasBorrowedBook, setHasBorrowedBook] = useState(false);
  const [borrowedBooks, setBorrowedBooks] = useState([]);

  // Check for borrowed books on component mount
  useEffect(() => {
    checkBorrowedBooks();
  }, []);

  const checkBorrowedBooks = async () => {
    setCheckingBooks(true);
    try {
      // Get all books and check if any are borrowed by current user
      const endpoint = user.role === 'admin' 
        ? '/books' 
        : `/books/community/${user.community_id}`;
      
      const res = await API.get(endpoint);
      const books = res.data.books || [];
      
      // Filter books borrowed by current user
      const myBooks = books.filter(book => book.current_holder_id === user.id);
      
      setHasBorrowedBook(myBooks.length > 0);
      setBorrowedBooks(myBooks);
    } catch (err) {
      console.error('Error checking borrowed books:', err);
    } finally {
      setCheckingBooks(false);
    }
  };

  const handleProfileUpdate = async () => {
    setLoading(true);
    try {
      // Your backend endpoint is /users/profile (PUT) according to userController
      const res = await API.put('/users/profile', profileForm);
      
      // Update localStorage with new user data
      const updatedUser = { ...user, ...profileForm };
      setCurrentUser(updatedUser);
      
      alert('✅ Профиль сәтті жаңартылды!');
      setEditMode(false);
      
      // Notify parent component
      if (onUserUpdate) {
        onUserUpdate(updatedUser);
      }
    } catch (err) {
      console.error('Profile update error:', err);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLeaveCommunity = async () => {
    // Check for borrowed books first
    await checkBorrowedBooks();
    
    if (hasBorrowedBook) {
      const bookTitles = borrowedBooks.map(b => b.title).join(', ');
      return alert(`⚠️ Алдымен кітаптарды қайтарыңыз: ${bookTitles}`);
    }

    if (!window.confirm('Қоғамдастықтан шығуға сенімдісіз бе?')) return;

    setLoading(true);
    try {
      // Your backend endpoint is /users/leave-community (POST)
      const res = await API.post('/users/leave-community');
      
      // Update user in localStorage
      const updatedUser = { ...user, community_id: null, community: null };
      setCurrentUser(updatedUser);
      
      alert('✅ ' + (res.data.message || 'Қоғамдастықтан шықтыңыз'));
      
      // Force reload to show join community page
      window.location.reload();
    } catch (err) {
      console.error('Leave community error:', err);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    // Check for borrowed books first
    await checkBorrowedBooks();
    
    if (hasBorrowedBook) {
      const bookTitles = borrowedBooks.map(b => b.title).join(', ');
      return alert(`⚠️ Алдымен кітаптарды қайтарыңыз: ${bookTitles}`);
    }

    if (!password) {
      alert('❌ Құпия сөзді енгізіңіз');
      return;
    }

    setLoading(true);
    try {
      // Verify password first
      await API.post('/users/login', { 
        email: user.email, 
        password: password 
      });

      // Delete account - your backend allows users to delete themselves
      await API.delete(`/users/delete/${user.id}`);
      
      alert('✅ Аккаунт сәтті өшірілді');
      clearToken();
      onLogout();
    } catch (err) {
      console.error('Delete account error:', err);
      if (err.response?.status === 400 || err.response?.status === 401) {
        alert('❌ Құпия сөз қате');
      } else {
        alert(formatApiError(err));
      }
    } finally {
      setLoading(false);
      setPassword('');
    }
  };

  return (
    <div style={{ padding: '20px', marginTop: '20px' }}>
      <h2 style={{ marginBottom: '20px' }}>⚙️ Баптаулар</h2>

      {/* Borrowed Books Warning */}
      {checkingBooks ? (
        <div style={{ 
          padding: '15px', 
          backgroundColor: '#fff3cd',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #ffc107'
        }}>
          ⏳ Кітаптар тексерілуде...
        </div>
      ) : hasBorrowedBook && (
        <div style={{ 
          padding: '15px', 
          backgroundColor: '#fff3cd',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '2px solid #ff9800'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#856404' }}>
            ⚠️ Сізде қолданыста кітаптар бар:
          </div>
          <ul style={{ margin: '8px 0', paddingLeft: '20px', color: '#856404' }}>
            {borrowedBooks.map(book => (
              <li key={book.id}>{book.title}</li>
            ))}
          </ul>
          <div style={{ fontSize: '13px', color: '#856404' }}>
            Қоғамдастықтан шығу немесе аккаунтты өшіру үшін алдымен кітаптарды қайтарыңыз.
          </div>
        </div>
      )}

      {/* Profile Edit Section */}
      <div style={{ 
        padding: '20px', 
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ margin: 0 }}>👤 Профиль мәліметтері</h3>
          {!editMode && (
            <button
              onClick={() => setEditMode(true)}
              style={{
                padding: '8px 16px',
                backgroundColor: '#2196F3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              ✏️ Өзгерту
            </button>
          )}
        </div>

        {editMode ? (
          <div>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Аты-жөні
              </label>
              <input
                value={profileForm.name}
                onChange={e => setProfileForm({ ...profileForm, name: e.target.value })}
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
                Email
              </label>
              <input
                type="email"
                value={profileForm.email}
                onChange={e => setProfileForm({ ...profileForm, email: e.target.value })}
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
                Телефон нөмірі
              </label>
              <input
                type="tel"
                value={profileForm.phone}
                onChange={e => setProfileForm({ ...profileForm, phone: e.target.value })}
                style={{ 
                  width: '100%', 
                  padding: '10px', 
                  border: '1px solid #ddd', 
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {user.community && (
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500', color: '#666' }}>
                  Қоғамдастық (өзгертуге болмайды)
                </label>
                <input
                  value={user.community.name}
                  disabled
                  style={{ 
                    width: '100%', 
                    padding: '10px', 
                    border: '1px solid #ddd', 
                    borderRadius: '4px',
                    backgroundColor: '#f5f5f5',
                    color: '#666',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleProfileUpdate}
                disabled={loading}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  opacity: loading ? 0.6 : 1
                }}
              >
                {loading ? '⏳ Сақталуда...' : '✓ Сақтау'}
              </button>
              <button
                onClick={() => {
                  setEditMode(false);
                  setProfileForm({
                    name: user.name,
                    email: user.email,
                    phone: user.phone
                  });
                }}
                disabled={loading}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: loading ? 'not-allowed' : 'pointer'
                }}
              >
                Болдырмау
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '15px' }}>
            <div style={{ padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '6px' }}>
              <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Аты-жөні</div>
              <div style={{ fontSize: '16px', fontWeight: '500' }}>{user.name}</div>
            </div>
            <div style={{ padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '6px' }}>
              <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Email</div>
              <div style={{ fontSize: '16px', fontWeight: '500' }}>{user.email}</div>
            </div>
            <div style={{ padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '6px' }}>
              <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Телефон</div>
              <div style={{ fontSize: '16px', fontWeight: '500' }}>{user.phone || 'Көрсетілмеген'}</div>
            </div>
            {user.community && (
              <div style={{ padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '6px' }}>
                <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Қоғамдастық</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '16px', fontWeight: '500' }}>{user.community.name}</div>
                  <button
                    onClick={handleLeaveCommunity}
                    disabled={loading || hasBorrowedBook}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: hasBorrowedBook ? '#ccc' : '#ff9800',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: (loading || hasBorrowedBook) ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      opacity: hasBorrowedBook ? 0.6 : 1
                    }}
                    title={hasBorrowedBook ? 'Алдымен кітаптарды қайтарыңыз' : ''}
                  >
                    🚪 Шығу
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete Account Section */}
      <div style={{ 
        padding: '20px', 
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        border: '2px solid #ffc107'
      }}>
        <h4 style={{ margin: '0 0 10px 0', color: '#856404' }}>
          ⚠️ Қауіпті аймақ
        </h4>
        <p style={{ margin: '0 0 15px 0', fontSize: '14px', color: '#856404' }}>
          Аккаунтты өшірген соң барлық деректеріңіз жойылады және қалпына келтіру мүмкін емес.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={hasBorrowedBook}
            style={{
              padding: '10px 20px',
              backgroundColor: hasBorrowedBook ? '#ccc' : '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: hasBorrowedBook ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              opacity: hasBorrowedBook ? 0.6 : 1
            }}
            title={hasBorrowedBook ? 'Алдымен кітаптарды қайтарыңыз' : ''}
          >
            🗑️ Аккаунтты өшіру
          </button>
        ) : (
          <div>
            <p style={{ margin: '0 0 10px 0', fontSize: '14px', fontWeight: 'bold' }}>
              Растау үшін құпия сөзді енгізіңіз:
            </p>
            <input
              type="password"
              placeholder="Құпия сөз"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: '10px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                boxSizing: 'border-box'
              }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleDeleteAccount}
                disabled={loading || hasBorrowedBook}
                style={{
                  padding: '10px 20px',
                  backgroundColor: hasBorrowedBook ? '#ccc' : '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (loading || hasBorrowedBook) ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  opacity: (loading || hasBorrowedBook) ? 0.6 : 1
                }}
                title={hasBorrowedBook ? 'Алдымен кітаптарды қайтарыңыз' : ''}
              >
                {loading ? '⏳ Өшірілуде...' : '✓ Растау'}
              </button>
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setPassword('');
                }}
                disabled={loading}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: loading ? 'not-allowed' : 'pointer'
                }}
              >
                Болдырмау
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserSettings;