// src/components/CommunityList.js
import React, { useEffect, useState } from 'react';
import API, { getCurrentUser } from '../api';

const CommunityList = () => {
  const [communities, setCommunities] = useState([]);
  const user = getCurrentUser();

  useEffect(() => {
    // Only show for admin
    if (user.role === 'admin') {
      fetchCommunities();
    }
  }, []);

  const fetchCommunities = async () => {
    try {
      const res = await API.get('/communities');
      setCommunities(res.data.communities || []);
    } catch (err) {
      console.error('Error fetching communities:', err);
    }
  };

  // Don't show for regular users
  if (user.role !== 'admin') {
    return null;
  }

  return (
    <div style={{ 
      padding: '20px', 
      marginTop: '20px',
      backgroundColor: 'white',
      borderRadius: '8px',
      boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
    }}>
      <h3>🏘️ Қоғамдастықтар ({communities.length})</h3>
      {communities.length === 0 ? (
        <p style={{ color: '#666' }}>Қоғамдастықтар жоқ</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {communities.map(c => (
            <li key={c.id} style={{ 
              padding: '10px', 
              marginBottom: '8px', 
              backgroundColor: '#f5f5f5', 
              borderRadius: '4px',
              borderLeft: '4px solid #2196F3'
            }}>
              <strong>{c.name}</strong>
              {c.description && (
                <span style={{ color: '#666', marginLeft: '10px' }}>
                  — {c.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default CommunityList;