// src/components/BookList.js
import React, { useEffect, useState } from 'react';
import API, { formatApiError, getCurrentUser } from '../api';

const BookList = () => {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBook, setSelectedBook] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const user = getCurrentUser();

  useEffect(() => {
    fetchBooks();
  }, []);

  const fetchBooks = async () => {
    try {
      setLoading(true);
      
      const endpoint = user.role === 'admin' 
        ? '/books' 
        : `/books/community/${user.community_id}`;
      
      const res = await API.get(endpoint);
      setBooks(res.data.books || []);
    } catch (err) {
      console.error(err);
      alert(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const openBorrowModal = (book) => {
    setSelectedBook(book);
    setShowModal(true);
  };

  const closeModal = () => {
    setSelectedBook(null);
    setShowModal(false);
  };

  const borrowBook = async () => {
    if (!selectedBook) return;
    
    try {
      const res = await API.post('/books/borrow', { book_id: selectedBook.id });
      alert(res.data.message);
      closeModal();
      await fetchBooks();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const returnBook = async (bookId) => {
    if (!window.confirm('Кітапты қайтарғыңыз келе ме?')) return;
    
    try {
      const res = await API.post('/books/return-my-book', { book_id: bookId });
      alert(res.data.message);
      await fetchBooks();
    } catch (err) {
      alert(formatApiError(err));
    }
  };

  const formatDate = (date) => {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString('kk-KZ', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getTimeSince = (date) => {
    if (!date) return '';
    const now = new Date();
    const borrowed = new Date(date);
    const diffMs = now - borrowed;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffDays > 0) return `${diffDays} күн бұрын`;
    if (diffHours > 0) return `${diffHours} сағат бұрын`;
    return 'Жақында';
  };

  const getDaysRemaining = (borrowedAt, borrowDays) => {
    if (!borrowedAt) return 0;
    const borrowed = new Date(borrowedAt);
    const dueDate = new Date(borrowed);
    dueDate.setDate(dueDate.getDate() + borrowDays);
    
    const now = new Date();
    const diffMs = dueDate - now;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    
    return diffDays;
  };

  const getReturnDate = (borrowedAt, borrowDays) => {
    if (!borrowedAt) return '';
    const borrowed = new Date(borrowedAt);
    const returnDate = new Date(borrowed);
    returnDate.setDate(returnDate.getDate() + borrowDays);
    
    return returnDate.toLocaleDateString('kk-KZ', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h3>📚 Кітаптар жүктелуде...</h3>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', marginTop: '20px' }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '20px',
        padding: '15px',
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div>
          <h2 style={{ margin: 0 }}>
            📚 Кітаптар тізімі
          </h2>
          {user.role !== 'admin' && user.community && (
            <p style={{ margin: '5px 0 0 0', color: '#666', fontSize: '14px' }}>
              Қоғамдастық: <strong>{user.community.name}</strong>
            </p>
          )}
        </div>
        <button 
          onClick={fetchBooks} 
          style={{ 
            padding: '10px 20px', 
            cursor: 'pointer',
            backgroundColor: '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontWeight: 'bold'
          }}
        >
          🔄 Жаңарту
        </button>
      </div>

      {books.length === 0 ? (
        <div style={{ 
          padding: '60px', 
          textAlign: 'center', 
          backgroundColor: 'white', 
          borderRadius: '8px',
          border: '1px solid #ddd'
        }}>
          <p style={{ fontSize: '18px', color: '#666' }}>
            😔 Кітаптар жоқ
          </p>
          <p style={{ fontSize: '14px', color: '#999' }}>
            Админ кітаптарды қосқанша күтіңіз
          </p>
        </div>
      ) : (
        <div style={{ 
          backgroundColor: 'white', 
          borderRadius: '8px', 
          overflow: 'hidden',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8f9fa', borderBottom: '2px solid #dee2e6' }}>
                <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Кітап</th>
                <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Автор</th>
                {user.role === 'admin' && (
                  <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Қоғамдастық</th>
                )}
                <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Мерзімі</th>
                <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Статус</th>
                <th style={{ textAlign: 'left', padding: '15px', fontWeight: '600' }}>Әрекет</th>
              </tr>
            </thead>
            <tbody>
              {books.map(book => {
                const isMyBook = book.current_holder_id === user.id;
                const isBorrowed = book.current_holder_id !== null;
                const daysRemaining = isBorrowed ? getDaysRemaining(book.borrowed_at, book.borrow_days) : 0;
                
                return (
                  <tr key={book.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '15px' }}>
                      <div style={{ fontWeight: '600', fontSize: '15px', marginBottom: '4px' }}>
                        {book.title}
                      </div>
                    </td>
                    <td style={{ padding: '15px', color: '#666' }}>
                      {book.author || <em style={{ color: '#999' }}>Автор көрсетілмеген</em>}
                    </td>
                    {user.role === 'admin' && (
                      <td style={{ padding: '15px', color: '#666' }}>
                        {book.community?.name || book.Community?.name || '—'}
                      </td>
                    )}
                    <td style={{ padding: '15px' }}>
                      <div style={{ fontSize: '14px', fontWeight: '500' }}>
                        {book.borrow_days} күн
                      </div>
                    </td>
                    <td style={{ padding: '15px' }}>
                      {isBorrowed ? (
                        <div>
                          <div style={{ 
                            display: 'inline-block',
                            padding: '6px 12px', 
                            backgroundColor: isMyBook ? '#4CAF50' : '#ff9800', 
                            color: 'white', 
                            borderRadius: '16px',
                            fontSize: '13px',
                            fontWeight: '500',
                            marginBottom: '6px'
                          }}>
                            {isMyBook ? '✓ Сізде' : `📚 ${book.holder.name}`}
                          </div>
                          <div style={{ fontSize: '12px', color: '#999' }}>
                            {getTimeSince(book.borrowed_at)}
                          </div>
                          {daysRemaining > 0 ? (
                            <div style={{ fontSize: '11px', color: '#4CAF50', fontWeight: '500' }}>
                              {daysRemaining} күн қалды
                            </div>
                          ) : daysRemaining === 0 ? (
                            <div style={{ fontSize: '11px', color: '#ff9800', fontWeight: '500' }}>
                              Бүгін қайтару керек
                            </div>
                          ) : (
                            <div style={{ fontSize: '11px', color: '#f44336', fontWeight: '500' }}>
                              {Math.abs(daysRemaining)} күн кешіктірілген
                            </div>
                          )}
                        </div>
                      ) : (
                        <span style={{ 
                          display: 'inline-block',
                          padding: '6px 12px', 
                          backgroundColor: '#e8f5e9', 
                          color: '#2e7d32', 
                          borderRadius: '16px',
                          fontSize: '13px',
                          fontWeight: '500'
                        }}>
                          ✓ Бос
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '15px' }}>
                      {isMyBook ? (
                        <button
                          onClick={() => returnBook(book.id)}
                          style={{
                            padding: '8px 16px',
                            backgroundColor: '#ff5722',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: '500',
                            fontSize: '13px'
                          }}
                        >
                          ↩️ Қайтару
                        </button>
                      ) : isBorrowed ? (
                        <button
                          onClick={() => openBorrowModal(book)}
                          style={{
                            padding: '8px 16px',
                            backgroundColor: '#6c757d',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: '500',
                            fontSize: '13px'
                          }}
                        >
                          ℹ️ Ақпарат
                        </button>
                      ) : (
                        <button
                          onClick={() => openBorrowModal(book)}
                          style={{
                            padding: '8px 16px',
                            backgroundColor: '#4CAF50',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: '500',
                            fontSize: '13px'
                          }}
                        >
                          📖 Алу
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Window */}
      {showModal && selectedBook && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '12px',
            padding: '30px',
            maxWidth: '500px',
            width: '90%',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: '20px', color: '#2196F3' }}>
              📚 {selectedBook.title}
            </h2>

            {selectedBook.author && (
              <div style={{ marginBottom: '15px', paddingBottom: '15px', borderBottom: '1px solid #eee' }}>
                <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Автор</div>
                <div style={{ fontSize: '16px', fontWeight: '500' }}>{selectedBook.author}</div>
              </div>
            )}

            <div style={{ marginBottom: '15px', paddingBottom: '15px', borderBottom: '1px solid #eee' }}>
              <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>Беру мерзімі</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#4CAF50' }}>
                {selectedBook.borrow_days} күн
              </div>
              <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
                Кітапты {selectedBook.borrow_days} күн ішінде қайтару керек
              </div>
            </div>

            {selectedBook.current_holder_id ? (
              <>
                <div style={{ 
                  padding: '15px', 
                  backgroundColor: '#fff3cd', 
                  borderRadius: '8px',
                  marginBottom: '15px'
                }}>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#856404', marginBottom: '10px' }}>
                    ⚠️ Кітап алынған
                  </div>
                  
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: '#856404', marginBottom: '4px' }}>Алған адам:</div>
                    <div style={{ fontSize: '15px', fontWeight: '500' }}>{selectedBook.holder.name}</div>
                  </div>

                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: '#856404', marginBottom: '4px' }}>Телефон нөмірі:</div>
                    <div style={{ fontSize: '15px', fontWeight: '500' }}>
                      <a href={`tel:${selectedBook.holder.phone}`} style={{ color: '#2196F3', textDecoration: 'none' }}>
                        📞 {selectedBook.holder.phone}
                      </a>
                    </div>
                  </div>

                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: '#856404', marginBottom: '4px' }}>Алған күні:</div>
                    <div style={{ fontSize: '14px' }}>{formatDate(selectedBook.borrowed_at)}</div>
                    <div style={{ fontSize: '12px', color: '#999' }}>({getTimeSince(selectedBook.borrowed_at)})</div>
                  </div>

                  <div>
                    <div style={{ fontSize: '12px', color: '#856404', marginBottom: '4px' }}>Қайтару мерзімі:</div>
                    <div style={{ fontSize: '15px', fontWeight: 'bold' }}>
                      {getReturnDate(selectedBook.borrowed_at, selectedBook.borrow_days)}
                    </div>
                    {(() => {
                      const daysLeft = getDaysRemaining(selectedBook.borrowed_at, selectedBook.borrow_days);
                      if (daysLeft > 0) {
                        return (
                          <div style={{ fontSize: '13px', color: '#4CAF50', fontWeight: '500', marginTop: '4px' }}>
                            ⏰ {daysLeft} күннен кейін босайды
                          </div>
                        );
                      } else if (daysLeft === 0) {
                        return (
                          <div style={{ fontSize: '13px', color: '#ff9800', fontWeight: '500', marginTop: '4px' }}>
                            ⏰ Бүгін босауы керек
                          </div>
                        );
                      } else {
                        return (
                          <div style={{ fontSize: '13px', color: '#f44336', fontWeight: '500', marginTop: '4px' }}>
                            ⚠️ {Math.abs(daysLeft)} күн кешіктірілген
                          </div>
                        );
                      }
                    })()}
                  </div>
                </div>

                <div style={{ fontSize: '13px', color: '#666', marginBottom: '20px' }}>
                  💡 Кітапты алғыңыз келсе, жоғарыдағы нөмірге хабарласыңыз
                </div>

                {/* Previous borrower info */}
                {selectedBook.history && selectedBook.history.length > 0 && selectedBook.history[0].borrower && (
                  <div style={{ 
                    padding: '12px', 
                    backgroundColor: '#f0f0f0', 
                    borderRadius: '8px',
                    marginBottom: '15px'
                  }}>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#666', marginBottom: '8px' }}>
                      📚 Алдыңғы қолданушы
                    </div>
                    <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                      <strong>{selectedBook.history[0].borrower.name}</strong>
                    </div>
                    <div style={{ fontSize: '13px', color: '#666' }}>
                      📞 <a href={`tel:${selectedBook.history[0].borrower.phone}`} style={{ color: '#2196F3', textDecoration: 'none' }}>
                        {selectedBook.history[0].borrower.phone}
                      </a>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={{ 
                  padding: '15px', 
                  backgroundColor: '#e8f5e9', 
                  borderRadius: '8px',
                  marginBottom: '20px'
                }}>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#2e7d32', marginBottom: '8px' }}>
                    ✓ Кітап бос
                  </div>
                  <div style={{ fontSize: '13px', color: '#2e7d32' }}>
                    Кітапты {selectedBook.borrow_days} күнге алуға болады
                  </div>
                </div>

                {/* Previous borrower info for available books */}
                {selectedBook.history && selectedBook.history.length > 0 && selectedBook.history[0].borrower && (
                  <div style={{ 
                    padding: '12px', 
                    backgroundColor: '#f0f0f0', 
                    borderRadius: '8px',
                    marginBottom: '15px'
                  }}>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#666', marginBottom: '8px' }}>
                      📚 Алдыңғы қолданушы
                    </div>
                    <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                      <strong>{selectedBook.history[0].borrower.name}</strong>
                    </div>
                    <div style={{ fontSize: '13px', color: '#666' }}>
                      📞 <a href={`tel:${selectedBook.history[0].borrower.phone}`} style={{ color: '#2196F3', textDecoration: 'none' }}>
                        {selectedBook.history[0].borrower.phone}
                      </a>
                    </div>
                  </div>
                )}
              </>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              {!selectedBook.current_holder_id && (
                <button
                  onClick={borrowBook}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '15px'
                  }}
                >
                  ✓ Алу
                </button>
              )}
              <button
                onClick={closeModal}
                style={{
                  flex: selectedBook.current_holder_id ? 1 : 0.5,
                  padding: '12px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '15px'
                }}
              >
                Жабу
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ 
        marginTop: '20px', 
        padding: '15px', 
        backgroundColor: 'white', 
        borderRadius: '8px',
        fontSize: '13px',
        color: '#666'
      }}>
        <strong>Статус түсіндірмесі:</strong>
        <div style={{ marginTop: '8px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          <div>
            <span style={{ 
              display: 'inline-block',
              padding: '4px 10px', 
              backgroundColor: '#e8f5e9', 
              color: '#2e7d32', 
              borderRadius: '12px',
              fontSize: '12px',
              marginRight: '8px'
            }}>
              ✓ Бос
            </span>
            - Кітапты алуға болады
          </div>
          <div>
            <span style={{ 
              display: 'inline-block',
              padding: '4px 10px', 
              backgroundColor: '#4CAF50', 
              color: 'white', 
              borderRadius: '12px',
              fontSize: '12px',
              marginRight: '8px'
            }}>
              ✓ Сізде
            </span>
            - Кітап сізде
          </div>
          <div>
            <span style={{ 
              display: 'inline-block',
              padding: '4px 10px', 
              backgroundColor: '#ff9800', 
              color: 'white', 
              borderRadius: '12px',
              fontSize: '12px',
              marginRight: '8px'
            }}>
              📚 Есімі
            </span>
            - Басқа адам алған
          </div>
        </div>
      </div>
    </div>
  );
};

export default BookList;