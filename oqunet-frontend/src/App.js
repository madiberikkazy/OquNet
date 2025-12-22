// src/App.js
import React, { useState, useEffect } from 'react';
import LoginRegister from './components/LoginRegister';
import BookList from './components/BookList';
import AdminPanel from './components/AdminPanel';
import UserSettings from './components/UserSettings';
import JoinCommunity from './components/JoinCommunity';
import { clearToken, getCurrentUser, getToken } from './api';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentView, setCurrentView] = useState('books');

  useEffect(() => {
    console.log('App mounted - checking auth status');
    const token = getToken();
    const savedUser = getCurrentUser();
    
    console.log('Token exists:', !!token);
    console.log('Saved user:', savedUser);
    
    if (token && savedUser) {
      setUser(savedUser);
      console.log('User restored from localStorage');
    } else {
      console.log('No auth data found');
    }
    
    setLoading(false);
  }, []);

  const handleLogin = (userData) => {
    console.log('User logged in:', userData);
    setUser(userData);
  };

  const handleLogout = () => {
    console.log('User logged out');
    clearToken();
    setUser(null);
    setCurrentView('books');
  };

  const handleUserUpdate = (updatedUser) => {
    setUser(updatedUser);
  };

  if (loading) {
    return (
      <div style={{ 
        padding: '40px', 
        textAlign: 'center',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <h2>📚 OquNet жүктелуде...</h2>
      </div>
    );
  }

  if (!user) {
    return <LoginRegister setUser={handleLogin} />;
  }

  // If user doesn't have community, show join page
  if (user.role !== 'admin' && !user.community_id) {
    return <JoinCommunity user={user} onJoin={handleUserUpdate} onLogout={handleLogout} />;
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f5f5f5' }}>
      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '15px 30px', 
        backgroundColor: 'white',
        borderBottom: '2px solid #2196F3',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div>
          <h1 style={{ margin: 0, color: '#2196F3', fontSize: '24px' }}>
            📚 OquNet - Кітап алмасу жүйесі
          </h1>
          {user.role !== 'admin' && user.community && (
            <p style={{ margin: '5px 0 0 0', fontSize: '14px', color: '#666' }}>
              Қоғамдастық: <strong>{user.community.name}</strong>
            </p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '14px', marginBottom: '4px' }}>
              Сәлем, <strong>{user.name}</strong>
            </div>
            <span style={{ 
              padding: '3px 10px', 
              backgroundColor: user.role === 'admin' ? '#ff9800' : '#4CAF50',
              color: 'white',
              borderRadius: '12px',
              fontSize: '12px',
              fontWeight: 'bold'
            }}>
              {user.role === 'admin' ? 'Админ' : 'Қолданушы'}
            </span>
          </div>
          {user.role !== 'admin' && (
            <button
              onClick={() => setCurrentView(currentView === 'books' ? 'settings' : 'books')}
              style={{
                padding: '10px 20px',
                cursor: 'pointer',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 'bold'
              }}
            >
              {currentView === 'books' ? '⚙️ Баптаулар' : '📚 Кітаптар'}
            </button>
          )}
          <button 
            onClick={handleLogout}
            style={{ 
              padding: '10px 20px', 
              cursor: 'pointer',
              backgroundColor: '#f44336',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 'bold'
            }}
          >
            Шығу
          </button>
        </div>
      </header>

      <main style={{ maxWidth: '1400px', margin: '0 auto' }}>
        {user.role === 'admin' ? (
          <AdminPanel />
        ) : (
          currentView === 'books' ? (
            <BookList />
          ) : (
            <UserSettings onLogout={handleLogout} onUserUpdate={handleUserUpdate} />
          )
        )}
      </main>
    </div>
  );
}

export default App;