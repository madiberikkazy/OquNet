import React, { useState } from 'react';
import API, { formatApiError, setCurrentUser } from '../api';

const JoinCommunity = ({ user, onJoin, onLogout }) => {
  const [accessCode, setAccessCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCommunity, setNewCommunity] = useState({
    name: '',
    description: '',
    access_code: ''
  });

  const handleJoin = async (e) => {
    e.preventDefault();
    
    if (!accessCode || accessCode.length < 4) {
      alert('Кіру кодын енгізіңіз (кем дегенде 4 таңба)');
      return;
    }

    setLoading(true);
    try {
      const res = await API.post('/users/join-community', { access_code: accessCode });
      
      setCurrentUser(res.data.user);
      onJoin(res.data.user);
      
      alert(res.data.message);
    } catch (err) {
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCommunity = async () => {
    if (!newCommunity.name || !newCommunity.access_code) {
      alert('Атауы және кіру коды міндетті');
      return;
    }

    if (newCommunity.access_code.length < 4) {
      alert('Кіру коды кем дегенде 4 таңба болуы керек');
      return;
    }

    setLoading(true);
    try {
      const res = await API.post('/communities/create', newCommunity);
      
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
            {showCreateForm ? '✨ Жаңа қоғамдастық құру' : '🏘️ Қоғамдастыққа қосылу'}
          </h1>
          <p style={{ color: '#666', fontSize: '14px' }}>
            {showCreateForm 
              ? 'Өзіңіздің қоғамдастығыңызды құрыңыз және автоматты түрде оның мүшесі болыңыз'
              : <>Сәлем, <strong>{user.name}</strong>! Кітаптарды көру үшін қоғамдастыққа қосылыңыз.</>
            }
          </p>
        </div>

        {showCreateForm ? (
          <div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '8px', 
                fontWeight: '600',
                color: '#333'
              }}>
                Қоғамдастық атауы *
              </label>
              <input
                type="text"
                placeholder="Мысалы: 101-қонақ үй"
                value={newCommunity.name}
                onChange={e => setNewCommunity({ ...newCommunity, name: e.target.value })}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '8px', 
                fontWeight: '600',
                color: '#333'
              }}>
                Сипаттама
              </label>
              <textarea
                placeholder="Қоғамдастық туралы қысқаша ақпарат"
                value={newCommunity.description}
                onChange={e => setNewCommunity({ ...newCommunity, description: e.target.value })}
                rows={3}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '8px', 
                fontWeight: '600',
                color: '#333'
              }}>
                Кіру коды *
              </label>
              <input
                type="text"
                placeholder="DORM123"
                value={newCommunity.access_code}
                onChange={e => setNewCommunity({ ...newCommunity, access_code: e.target.value.toUpperCase() })}
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
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                💡 Басқа адамдар бұл кодты пайдаланып қоғамдастыққа қосылады
              </div>
            </div>

            <button
              onClick={handleCreateCommunity}
              disabled={loading}
              style={{
                width: '100%',
                padding: '14px',
                backgroundColor: loading ? '#ccc' : '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: 'bold',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
                marginBottom: '10px'
              }}
            >
              {loading ? '⏳ Құрылуда...' : '✓ Құру'}
            </button>

            <button
              onClick={() => {
                setShowCreateForm(false);
                setNewCommunity({ name: '', description: '', access_code: '' });
              }}
              disabled={loading}
              style={{
                width: '100%',
                padding: '14px',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: 'bold',
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              ← Артқа
            </button>
          </div>
        ) : (
          <div>
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
                onKeyPress={e => e.key === 'Enter' && handleJoin(e)}
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
              <div style={{ marginBottom: '12px' }}>
                💡 <strong>Кіру кодын қайдан аламын?</strong><br/>
                Қоғамдастықтың админінен немесе тұрғын үй басқармасынан кіру кодын сұраңыз.
              </div>
              <div style={{ 
                paddingTop: '12px', 
                borderTop: '1px solid #90caf9' 
              }}>
                <strong>Немесе өз қоғамдастығыңызды құрғыңыз келе ме?</strong><br/>
                <button
                  onClick={() => setShowCreateForm(true)}
                  style={{
                    marginTop: '8px',
                    padding: '8px 16px',
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold'
                  }}
                >
                  ✨ Жаңа қоғамдастық құру
                </button>
              </div>
            </div>

            <button
              onClick={handleJoin}
              disabled={loading}
              style={{
                width: '100%',
                padding: '14px',
                backgroundColor: loading ? '#ccc' : '#4CAF50',
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
          </div>
        )}

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