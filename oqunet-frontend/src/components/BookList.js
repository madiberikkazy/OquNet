// src/components/BookList.js - COMPLETE VERSION WITH IMAGE SUPPORT
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
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: '20px'
        }}>
          {books.map(book => {
            const isMyBook = book.current_holder_id === user.id;
            const isBorrowed = book.current_holder_id !== null;
            const daysRemaining = isBorrowed ? getDaysRemaining(book.borrowed_at, book.borrow_days) : 0;
            
            return (
              <div 
                key={book.id} 
                style={{ 
                  backgroundColor: 'white',
                  borderRadius: '12px',
                  overflow: 'hidden',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                  transition: 'transform 0.2s, box-shadow 0.2s',
                  cursor: 'pointer',
                  border: isMyBook ? '2px solid #4CAF50' : '1px solid #e0e0e0'
                }}
                onClick={() => openBorrowModal(book)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
                }}
              >
                {/* Book Image */}
                <div style={{ 
                  width: '100%', 
                  height: '280px', 
                  backgroundColor: '#f5f5f5',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  position: 'relative'
                }}>
                  {book.image_url ? (
                    <img 
                      src={book.image_url} 
                      alt={book.title}
                      style={{ 
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover'
                      }}
                      onError={(e) => {
                        e.target.style.display = 'none';
                        const parent = e.target.parentElement;
                        const placeholder = document.createElement('div');
                        placeholder.style.cssText = 'font-size: 64px; color: #bbb;';
                        placeholder.textContent = '📚';
                        parent.appendChild(placeholder);
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: '64px', color: '#bbb' }}>📚</div>
                  )}
                  
                  {/* Status Badge */}
                  <div style={{ 
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    padding: '6px 12px',
                    backgroundColor: isMyBook ? '#4CAF50' : (isBorrowed ? '#ff9800' : '#4CAF50'),
                    color: 'white',
                    borderRadius: '16px',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                  }}>
                    {isMyBook ? '✓ Сізде' : (isBorrowed ? '📚 Алынған' : '✓ Бос')}
                  </div>
                </div>

                {/* Book Info */}
                <div style={{ padding: '15px' }}>
                  <h3 style={{ 
                    margin: '0 0 8px 0', 
                    fontSize: '18px',
                    fontWeight: 'bold',
                    color: '#333',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}>
                    {book.title}
                  </h3>
                  
                  {book.author && (
                    <div style={{ 
                      fontSize: '14px', 
                      color: '#666',
                      marginBottom: '8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      ✍️ {book.author}
                    </div>
                  )}

                  <div style={{ 
                    fontSize: '13px', 
                    color: '#999',
                    marginBottom: '12px'
                  }}>
                    ⏰ Мерзім: {book.borrow_days} күн
                  </div>

                  {isBorrowed && (
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '13px', color: '#666', marginBottom: '4px' }}>
                        {isMyBook ? 'Сізде' : `Алған адам: ${book.holder?.name}`}
                      </div>
                      <div style={{ fontSize: '12px', color: '#999' }}>
                        {getTimeSince(book.borrowed_at)}
                      </div>
                      {daysRemaining > 0 ? (
                        <div style={{ fontSize: '12px', color: '#4CAF50', fontWeight: '500' }}>
                          {daysRemaining} күн қалды
                        </div>
                      ) : daysRemaining === 0 ? (
                        <div style={{ fontSize: '12px', color: '#ff9800', fontWeight: '500' }}>
                          Бүгін қайтару керек
                        </div>
                      ) : (
                        <div style={{ fontSize: '12px', color: '#f44336', fontWeight: '500' }}>
                          {Math.abs(daysRemaining)} күн кешіктірілген
                        </div>
                      )}
                    </div>
                  )}

                  {isMyBook ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        returnBook(book.id);
                      }}
                      style={{
                        width: '100%',
                        padding: '10px',
                        backgroundColor: '#ff5722',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '14px'
                      }}
                    >
                      ↩️ Қайтару
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openBorrowModal(book);
                      }}
                      style={{
                        width: '100%',
                        padding: '10px',
                        backgroundColor: isBorrowed ? '#6c757d' : '#4CAF50',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '14px'
                      }}
                    >
                      {isBorrowed ? 'ℹ️ Ақпарат' : '📖 Алу'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
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
          backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '20px'
        }}
        onClick={closeModal}
        >
          <div style={{
            backgroundColor: 'white',
            borderRadius: '16px',
            maxWidth: '600px',
            width: '100%',
            maxHeight: '90vh',
            overflow: 'auto',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
          }}
          onClick={(e) => e.stopPropagation()}
          >
            {/* Book Image in Modal */}
            {selectedBook.image_url && (
              <div style={{ 
                width: '100%', 
                height: '300px', 
                backgroundColor: '#f5f5f5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                borderRadius: '16px 16px 0 0'
              }}>
                <img 
                  src={selectedBook.image_url} 
                  alt={selectedBook.title}
                  style={{ 
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover'
                  }}
                  onError={(e) => {
                    e.target.style.display = 'none';
                    e.target.parentElement.innerHTML = '<div style="font-size: 72px; color: #bbb;">📚</div>';
                  }}
                />
              </div>
            )}

            <div style={{ padding: '30px' }}>
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
        </div>
      )}
    </div>
  );
};

export default BookList;