// src/components/LoginRegister.js
import React, { useState } from 'react';
import API, { setToken, setCurrentUser, formatApiError } from '../api';
import PhoneInput, { getPhoneDigits } from './PhoneInput';

const LoginRegister = ({ setUser }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });

  const handleChange = e => setForm({ ...form, [e.target.name]: e.target.value });
  
  const handlePhoneChange = (formatted) => {
    setForm({ ...form, phone: formatted });
  };

  const handleSubmit = async e => {
    e.preventDefault();
    try {
      if (isLogin) {
        const res = await API.post('/users/login', { email: form.email, password: form.password });
        setToken(res.data.token);
        setCurrentUser(res.data.user);
        setUser(res.data.user);
      } else {
        // Get only digits for backend storage
        const phoneDigits = getPhoneDigits(form.phone);
        
        await API.post('/users/register', {
          name: form.name,
          email: form.email,
          phone: phoneDigits, // Store only digits
          password: form.password
        });
        alert('Тіркелді! Енді кіріңіз.');
        setIsLogin(true);
        setForm({ name: '', email: '', phone: '', password: '' });
      }
    } catch (err) { 
      alert(formatApiError(err)); 
    }
  };

  return (
    <div style={{ 
      maxWidth: '450px', 
      margin: '50px auto', 
      padding: '30px',
      border: '1px solid #ddd',
      borderRadius: '8px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
    }}>
      <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>
        {isLogin ? '🔐 Кіру' : '📝 Тіркелу'}
      </h2>
      
      <form onSubmit={handleSubmit}>
        {!isLogin && (
          <>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Аты-жөні *
              </label>
              <input
                name="name"
                placeholder="Толық аты-жөніңіз"
                value={form.name}
                onChange={handleChange}
                required={!isLogin}
                style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
                Телефон нөмірі *
              </label>
              <PhoneInput
                value={form.phone}
                onChange={handlePhoneChange}
                placeholder="+7(___) ___-__-__"
                style={{ 
                  width: '100%', 
                  padding: '10px', 
                  border: '1px solid #ddd', 
                  borderRadius: '4px', 
                  boxSizing: 'border-box' 
                }}
              />
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                💡 Автоматты форматталады: +7(775) 185-60-15
              </div>
            </div>
          </>
        )}

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
            Email *
          </label>
          <input
            name="email"
            placeholder="email@example.com"
            type="email"
            value={form.email}
            onChange={handleChange}
            required
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: '500' }}>
            Құпия сөз *
          </label>
          <input
            name="password"
            placeholder="••••••••"
            type="password"
            value={form.password}
            onChange={handleChange}
            required
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <button 
          type="submit" 
          style={{ 
            width: '100%', 
            padding: '12px',
            backgroundColor: isLogin ? '#2196F3' : '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '16px',
            fontWeight: 'bold',
            cursor: 'pointer'
          }}
        >
          {isLogin ? 'Кіру' : 'Тіркелу'}
        </button>
      </form>

      <button 
        onClick={() => { 
          setIsLogin(!isLogin); 
          setForm({ name: '', email: '', phone: '', password: '' }); 
        }} 
        style={{ 
          width: '100%', 
          padding: '12px', 
          marginTop: '15px', 
          background: '#f0f0f0',
          border: '1px solid #ddd',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        {isLogin ? 'Тіркелу' : 'Кіру'}
      </button>
    </div>
  );
};

export default LoginRegister;