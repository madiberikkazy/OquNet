// src/components/Messages.js
import React, { useState, useEffect } from 'react';
import API, { formatApiError } from '../api';

const Messages = ({ onClose, onRefresh }) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMessages();
    
    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchMessages, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchMessages = async () => {
    try {
      const res = await API.get('/messages');
      setMessages(res.data.messages || []);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching messages:', err);
      setLoading(false);
    }
  };

  const markAsRead = async (messageId) => {
    try {
      await API.put(`/messages/${messageId}/read`);
      await fetchMessages();
    } catch (err) {
      console.error('Error marking as read:', err);
    }
  };

  const formatDate = (date) => {
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Дәл қазір';
    if (minutes < 60) return `${minutes} минут бұрын`;
    if (hours < 24) return `${hours} сағат бұрын`;
    if (days < 7) return `${days} күн бұрын`;
    
    return d.toLocaleDateString('kk-KZ', { 
      day: 'numeric', 
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getMessageIcon = (type) => {
    switch(type) {
      case 'transfer_request': return '📨';
      case 'transfer_code': return '🔑';
      case 'chat': return '💬';
      default: return '📬';
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '20px', marginTop: '20px' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          padding: '15px',
          backgroundColor: 'white',
          borderRadius: '8px'
        }}>
          <h2 style={{ margin: 0 }}>💬 Хабарламалар</h2>
          <button onClick={onClose} style={{
            padding: '10px 20px',
            backgroundColor: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}>
            ← Артқа
          </button>
        </div>
        <p>Жүктелуде...</p>
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
        <h2 style={{ margin: 0 }}>💬 Хабарламалар ({messages.length})</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={fetchMessages}
            style={{
              padding: '10px 20px',
              backgroundColor: '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            🔄 Жаңарту
          </button>
          <button 
            onClick={() => {
              onRefresh();
              onClose();
            }}
            style={{
              padding: '10px 20px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            ← Артқа
          </button>
        </div>
      </div>

      {messages.length === 0 ? (
        <div style={{
          padding: '60px',
          textAlign: 'center',
          backgroundColor: 'white',
          borderRadius: '8px',
          border: '1px solid #ddd'
        }}>
          <p style={{ fontSize: '18px', color: '#666' }}>📭 Хабарламалар жоқ</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          {messages.map(message => (
            <div
              key={message.id}
              onClick={() => !message.is_read && markAsRead(message.id)}
              style={{
                padding: '20px',
                backgroundColor: message.is_read ? 'white' : '#e3f2fd',
                borderRadius: '8px',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                cursor: message.is_read ? 'default' : 'pointer',
                border: message.is_read ? '1px solid #ddd' : '2px solid #2196F3',
                transition: 'all 0.2s'
              }}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'start',
                marginBottom: '10px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '24px' }}>
                    {getMessageIcon(message.message_type)}
                  </span>
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: '15px' }}>
                      {message.fromUser.name}
                    </div>
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      {formatDate(message.createdAt)}
                    </div>
                  </div>
                </div>
                {!message.is_read && (
                  <span style={{
                    padding: '4px 10px',
                    backgroundColor: '#2196F3',
                    color: 'white',
                    borderRadius: '12px',
                    fontSize: '11px',
                    fontWeight: 'bold'
                  }}>
                    ЖАҢА
                  </span>
                )}
              </div>

              <div style={{
                padding: '15px',
                backgroundColor: '#f9f9f9',
                borderRadius: '8px',
                marginBottom: '10px'
              }}>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {message.content}
                </p>
              </div>

              {message.transfer_code && (
                <div style={{
                  padding: '15px',
                  backgroundColor: '#fff3cd',
                  borderRadius: '8px',
                  border: '2px solid #ff9800'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#856404' }}>
                    🔑 Трансфер коды:
                  </div>
                  <div style={{
                    fontSize: '32px',
                    fontFamily: 'monospace',
                    letterSpacing: '8px',
                    textAlign: 'center',
                    color: '#ff9800',
                    fontWeight: 'bold'
                  }}>
                    {message.transfer_code}
                  </div>
                  <div style={{ fontSize: '12px', color: '#856404', marginTop: '8px', textAlign: 'center' }}>
                    Бұл кодты кітапты алушыға айтыңыз
                  </div>
                </div>
              )}

              {message.Book && (
                <div style={{
                  marginTop: '10px',
                  padding: '10px',
                  backgroundColor: '#f0f0f0',
                  borderRadius: '4px',
                  fontSize: '13px',
                  color: '#666'
                }}>
                  📚 Кітап: <strong>{message.Book.title}</strong>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Messages;