// src/components/JoinCommunity.js
import React, { useState } from 'react';
import API, { formatApiError, setCurrentUser } from '../api';

const JoinCommunity = ({ user, onJoin, onLogout }) => {
  const [accessCode, setAccessCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleJoin = async (e) => {
    e.preventDefault();
    
    if (!accessCode || accessCode.length < 4) {
      alert('Кіру кодын енгізіңіз (кем дегенде 4 таңба)');
      return;
    }

    setLoading(true);
    try {
      const res = await API.post('/users/join-community', { access_code: accessCode });
      
      // Update user in localStorage and state
      setCurrentUser(res.data.user);
      onJoin(res.data.user);
      
      alert(res.data.message);
    } catch (err) {
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      backgroundColor: '#f5f5f5',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px'
    }}>
      <div style={{
        maxWidth: '500px',
        width: '100%',
        backgroundColor: 'white',
        borderRadius: '12px',
        padding: '40px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ color: '#2196F3', marginBottom: '10px' }}>
            🏘️ Қоғамдастыққа қосылу
          </h1>
          <p style={{ color: '#666', fontSize: '14px' }}>
            Сәлем, <strong>{user.name}</strong>! Кітаптарды көру үшін қоғамдастыққа қосылыңыз.
          </p>
        </div>

        <form onSubmit={handleJoin}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '8px', 
              fontWeight: '600',
              color: '#333'
            }}>
              Кіру коды
            </label>
            <input
              type="text"
              placeholder="Мысалы: DORM123"
              value={accessCode}
              onChange={e => setAccessCode(e.target.value.toUpperCase())}
              maxLength={20}
              style={{
                width: '100%',
                padding: '12px',
                border: '2px solid #ddd',
                borderRadius: '6px',
                fontSize: '16px',
                textTransform: 'uppercase',
                fontFamily: 'monospace',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ 
            padding: '15px', 
            backgroundColor: '#e3f2fd', 
            borderRadius: '6px',
            marginBottom: '20px',
            fontSize: '14px',
            color: '#1976d2'
          }}>
            💡 <strong>Кіру кодын қайдан аламын?</strong><br/>
            Қоғамдастықтың админінен немесе тұрғын үй басқармасынан кіру кодын сұраңыз.
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 'bold',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1
            }}
          >
            {loading ? '⏳ Қосылуда...' : '✓ Қосылу'}
          </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center' }}>
          <button
            onClick={onLogout}
            style={{
              padding: '10px 20px',
              backgroundColor: 'transparent',
              color: '#666',
              border: '1px solid #ddd',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Шығу
          </button>
        </div>
      </div>
    </div>
  );
};

export default JoinCommunity;