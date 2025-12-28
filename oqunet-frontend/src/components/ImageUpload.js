// src/components/ImageUpload.js
import React, { useState } from 'react';

const ImageUpload = ({ value, onChange, error }) => {
  const [preview, setPreview] = useState(value || '');
  const [uploading, setUploading] = useState(false);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert('Сурет өте үлкен! Максимум: 5MB');
      return;
    }

    // Check file type
    if (!file.type.startsWith('image/')) {
      alert('Тек сурет файлдарын жүктеуге болады!');
      return;
    }

    setUploading(true);

    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result;
      setPreview(base64String);
      onChange(base64String);
      setUploading(false);
    };
    reader.onerror = () => {
      alert('Суретті оқу қатесі!');
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleUrlInput = (e) => {
    const url = e.target.value;
    setPreview(url);
    onChange(url);
  };

  const clearImage = () => {
    setPreview('');
    onChange('');
  };

  return (
    <div style={{ marginBottom: '15px' }}>
      <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
        Кітап суреті * {uploading && <span style={{ color: '#2196F3' }}>⏳ Жүктелуде...</span>}
      </label>

      {/* Preview */}
      {preview && (
        <div style={{
          marginBottom: '10px',
          position: 'relative',
          width: '200px',
          height: '280px',
          border: '2px solid #ddd',
          borderRadius: '8px',
          overflow: 'hidden',
          backgroundColor: '#f5f5f5'
        }}>
          <img
            src={preview}
            alt="Preview"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover'
            }}
            onError={() => {
              setPreview('');
              onChange('');
              alert('Суретті жүктеу қатесі! URL-ді тексеріңіз.');
            }}
          />
          <button
            onClick={clearImage}
            type="button"
            style={{
              position: 'absolute',
              top: '5px',
              right: '5px',
              padding: '5px 10px',
              backgroundColor: '#f44336',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Upload Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* File Upload */}
        <div>
          <input
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            disabled={uploading}
            style={{
              padding: '10px',
              border: error ? '2px solid #f44336' : '1px solid #ddd',
              borderRadius: '4px',
              width: '100%',
              boxSizing: 'border-box',
              cursor: 'pointer'
            }}
          />
          <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
            📤 Компьютерден сурет жүктеу (max 5MB)
          </div>
        </div>

        {/* URL Input */}
        <div>
          <input
            type="url"
            placeholder="немесе сурет сілтемесін енгізіңіз"
            value={preview && !preview.startsWith('data:') ? preview : ''}
            onChange={handleUrlInput}
            style={{
              width: '100%',
              padding: '10px',
              border: error ? '2px solid #f44336' : '1px solid #ddd',
              borderRadius: '4px',
              boxSizing: 'border-box'
            }}
          />
          <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
            🔗 Немесе интернеттен сурет сілтемесі (https://...)
          </div>
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: '8px',
          padding: '8px',
          backgroundColor: '#ffebee',
          color: '#c62828',
          borderRadius: '4px',
          fontSize: '13px'
        }}>
          ⚠️ {error}
        </div>
      )}
    </div>
  );
};

export default ImageUpload;