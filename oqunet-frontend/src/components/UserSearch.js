// src/components/UserSearch.js
import React, { useState } from 'react';
import API, { formatApiError } from '../api';
import PhoneInput, { getPhoneDigits, formatPhoneNumber } from './PhoneInput';

const UserSearch = () => {
  const [phoneSearch, setPhoneSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async () => {
    const digits = getPhoneDigits(phoneSearch);
    
    if (digits.length < 3) {
      alert('Телефон нөмірінің кем дегенде 3 таңбасын енгізіңіз');
      return;
    }

    setSearching(true);
    setHasSearched(true);
    
    try {
      const res = await API.get(`/search/users?phone=${digits}`);
      setSearchResults(res.data.users || []);
    } catch (err) {
      alert(formatApiError(err));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleClear = () => {
    setPhoneSearch('');
    setSearchResults([]);
    setHasSearched(false);
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Пайдаланушыны өшіргіңіз келе ме?')) return;

    try {
      await API.delete(`/users/delete/${userId}`);
      alert('Пайдаланушы өшірілді');
      // Refresh search results
      handleSearch();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{
        padding: '20px',
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        marginBottom: '20px'
      }}>
        <h3 style={{ margin: '0 0 15px 0' }}>📱 Телефон нөмірі бойынша іздеу</h3>
        
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1', minWidth: '250px' }}>
            <PhoneInput
              value={phoneSearch}
              onChange={setPhoneSearch}
              placeholder="+7(___) ___-__-__"
              style={{
                width: '100%',
                padding: '12px 15px',
                border: '2px solid #ddd',
                borderRadius: '6px',
                fontSize: '15px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <button
            onClick={handleSearch}
            disabled={searching || getPhoneDigits(phoneSearch).length < 3}
            style={{
              padding: '12px 24px',
              backgroundColor: searching || getPhoneDigits(phoneSearch).length < 3 ? '#ccc' : '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '15px',
              fontWeight: 'bold',
              cursor: searching || getPhoneDigits(phoneSearch).length < 3 ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            {searching ? '⏳ Іздеу...' : '🔍 Іздеу'}
          </button>

          {phoneSearch && (
            <button
              onClick={handleClear}
              style={{
                padding: '12px 24px',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '15px',
                fontWeight: 'bold',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              ✕ Тазалау
            </button>
          )}
        </div>

        <div style={{
          marginTop: '10px',
          fontSize: '13px',
          color: '#666'
        }}>
          💡 Кем дегенде 3 таңба енгізіңіз. Мысалы: +7(775) немесе 775
        </div>
      </div>

      {/* Search Results */}
      {hasSearched && (
        <div style={{
          padding: '20px',
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <h4 style={{ margin: '0 0 15px 0' }}>
            Нәтижелер: {searchResults.length}
          </h4>

          {searchResults.length === 0 ? (
            <div style={{
              padding: '40px',
              textAlign: 'center',
              color: '#666'
            }}>
              <p style={{ fontSize: '18px' }}>😔 Табылмады</p>
              <p style={{ fontSize: '14px' }}>
                "{phoneSearch}" нөмірі бойынша пайдаланушы табылмады
              </p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {searchResults.map(user => (
                <li
                  key={user.id}
                  style={{
                    padding: '15px',
                    marginBottom: '10px',
                    backgroundColor: '#f9f9f9',
                    borderRadius: '6px',
                    border: '1px solid #ddd'
                  }}
                >
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: '16px', marginBottom: '5px' }}>
                        {user.name}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666', marginBottom: '3px' }}>
                        📧 {user.email}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
                        📱 {formatPhoneNumber(user.phone)}
                      </div>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
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
                        {user.community && (
                          <span style={{
                            padding: '3px 10px',
                            backgroundColor: '#e3f2fd',
                            color: '#1976d2',
                            borderRadius: '12px',
                            fontSize: '12px'
                          }}>
                            🏘️ {user.community.name}
                          </span>
                        )}
                      </div>
                    </div>
                    {user.role !== 'admin' && (
                      <button
                        onClick={() => handleDeleteUser(user.id)}
                        style={{
                          padding: '8px 16px',
                          backgroundColor: '#f44336',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          fontSize: '13px'
                        }}
                      >
                        🗑️ Өшіру
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default UserSearch;