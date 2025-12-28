// src/components/BookSearch.js
import React, { useState, useEffect } from 'react';
import API from '../api';

const BookSearch = ({ onSearch }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState('all');
  const [genres, setGenres] = useState([]);

  useEffect(() => {
    fetchGenres();
  }, []);

  const fetchGenres = async () => {
    try {
      const res = await API.get('/search/genres');
      setGenres(res.data.genres || []);
    } catch (err) {
      console.error('Error fetching genres:', err);
    }
  };

  const handleSearch = () => {
    onSearch({ query: searchQuery, genre: selectedGenre });
  };

  const handleClear = () => {
    setSearchQuery('');
    setSelectedGenre('all');
    onSearch({ query: '', genre: 'all' });
  };

  return (
    <div style={{
      padding: '20px',
      backgroundColor: 'white',
      borderRadius: '8px',
      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
      marginBottom: '20px'
    }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Search Input */}
        <div style={{ flex: '1', minWidth: '250px' }}>
          <input
            type="text"
            placeholder="🔍 Кітап атауы немесе автор..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
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

        {/* Genre Filter */}
        <div style={{ minWidth: '180px' }}>
          <select
            value={selectedGenre}
            onChange={(e) => setSelectedGenre(e.target.value)}
            style={{
              width: '100%',
              padding: '12px 15px',
              border: '2px solid #ddd',
              borderRadius: '6px',
              fontSize: '15px',
              backgroundColor: 'white',
              cursor: 'pointer'
            }}
          >
            <option value="all">📚 Барлық жанрлар</option>
            {genres.map(genre => (
              <option key={genre} value={genre}>{genre}</option>
            ))}
          </select>
        </div>

        {/* Search Button */}
        <button
          onClick={handleSearch}
          style={{
            padding: '12px 24px',
            backgroundColor: '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            fontWeight: 'bold',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }}
        >
          🔍 Іздеу
        </button>

        {/* Clear Button */}
        {(searchQuery || selectedGenre !== 'all') && (
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

      {/* Active Filters Display */}
      {(searchQuery || selectedGenre !== 'all') && (
        <div style={{
          marginTop: '15px',
          padding: '10px',
          backgroundColor: '#e3f2fd',
          borderRadius: '4px',
          fontSize: '14px',
          color: '#1976d2'
        }}>
          <strong>Іздеу:</strong>{' '}
          {searchQuery && <span>"{searchQuery}"</span>}
          {searchQuery && selectedGenre !== 'all' && <span> • </span>}
          {selectedGenre !== 'all' && <span>Жанр: {selectedGenre}</span>}
        </div>
      )}
    </div>
  );
};

export default BookSearch;