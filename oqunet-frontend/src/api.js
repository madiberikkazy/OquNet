// src/api.js
import axios from 'axios';

// LocalStorage keys
const TOKEN_KEY = 'oqunet_token';
const USER_KEY = 'oqunet_user';

// Token management
export const setToken = (token) => {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    console.log('Token saved:', token.substring(0, 20) + '...');
  }
};

export const getToken = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  console.log('Getting token:', token ? 'exists' : 'not found');
  return token;
};

export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  console.log('Token cleared');
};

// User management
export const setCurrentUser = (user) => {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    console.log('User saved:', user);
  }
};

export const getCurrentUser = () => {
  const userStr = localStorage.getItem(USER_KEY);
  if (userStr) {
    try {
      const user = JSON.parse(userStr);
      console.log('User loaded from localStorage:', user);
      return user;
    } catch (e) {
      console.error('Error parsing user from localStorage:', e);
      return null;
    }
  }
  console.log('No user in localStorage');
  return null;
};

// Create axios instance
const API = axios.create({
  baseURL: 'http://localhost:3000/api',
});

// Request interceptor - add token to every request
API.interceptors.request.use(
  config => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
      console.log('Request with token to:', config.url);
    } else {
      console.warn('Request without token to:', config.url);
    }
    return config;
  },
  error => {
    console.error('Request interceptor error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor - handle errors
API.interceptors.response.use(
  response => {
    console.log('Response from:', response.config.url, '- Status:', response.status);
    return response;
  },
  error => {
    console.error('API Error:', error.response?.status, error.response?.data);
    
    if (!error.response) {
      const message = 'Серверге қосылу мүмкін емес. Желі күйін тексеріңіз.';
      error.friendlyMessage = message;
      return Promise.reject(error);
    }

    const { status, data } = error.response;
    let message = data?.message || '';
    
    switch (status) {
      case 400:
        message = message || 'Қате сұрау (400).';
        break;
      case 401:
        message = message || 'Сессия аяқталды. Қайта кіріңіз.';
        console.warn('Token expired or invalid - clearing auth');
        clearToken();
        setTimeout(() => {
          window.location.reload();
        }, 1000);
        break;
      case 403:
        message = message || 'Рұқсат жоқ (403).';
        break;
      case 404:
        message = message || 'Ресурс табылмады (404).';
        break;
      case 422:
        message = message || 'Жарамсыз деректер (422).';
        break;
      case 500:
        message = message || 'Сервердегі қате (500).';
        break;
      default:
        message = message || `Қате: ${status}`;
    }

    error.friendlyMessage = message;
    error.response.data = { ...data, message };

    return Promise.reject(error);
  }
);

export function formatApiError(err) {
  if (!err) return 'Белгісіз қате';
  if (err.friendlyMessage) return err.friendlyMessage;
  if (err.response?.data?.message) return err.response.data.message;
  if (err.message) return err.message;
  return 'Белгісіз қате';
}

export default API;