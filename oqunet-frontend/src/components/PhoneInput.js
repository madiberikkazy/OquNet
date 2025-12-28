// src/components/PhoneInput.js
import React from 'react';

// Format phone number as +7(XXX) XXX-XX-XX
export const formatPhoneNumber = (value) => {
  // Remove all non-digits
  const digits = value.replace(/\D/g, '');
  
  // Limit to 11 digits (7 + 10)
  const limitedDigits = digits.slice(0, 11);
  
  // If starts with 8, replace with 7
  let formatted = limitedDigits;
  if (formatted.startsWith('8')) {
    formatted = '7' + formatted.slice(1);
  }
  
  // Format based on number of digits
  if (formatted.length === 0) {
    return '';
  } else if (formatted.length <= 1) {
    return '+' + formatted;
  } else if (formatted.length <= 4) {
    return `+${formatted.slice(0, 1)}(${formatted.slice(1)}`;
  } else if (formatted.length <= 7) {
    return `+${formatted.slice(0, 1)}(${formatted.slice(1, 4)}) ${formatted.slice(4)}`;
  } else if (formatted.length <= 9) {
    return `+${formatted.slice(0, 1)}(${formatted.slice(1, 4)}) ${formatted.slice(4, 7)}-${formatted.slice(7)}`;
  } else {
    return `+${formatted.slice(0, 1)}(${formatted.slice(1, 4)}) ${formatted.slice(4, 7)}-${formatted.slice(7, 9)}-${formatted.slice(9, 11)}`;
  }
};

// Extract only digits from formatted phone
export const getPhoneDigits = (formatted) => {
  return formatted.replace(/\D/g, '');
};

const PhoneInput = ({ value, onChange, placeholder, style, disabled }) => {
  const handleChange = (e) => {
    const input = e.target.value;
    const formatted = formatPhoneNumber(input);
    onChange(formatted);
  };

  const handleKeyDown = (e) => {
    // Allow: backspace, delete, tab, escape, enter
    if ([8, 9, 27, 13, 46].indexOf(e.keyCode) !== -1 ||
        // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
        (e.keyCode === 65 && e.ctrlKey === true) ||
        (e.keyCode === 67 && e.ctrlKey === true) ||
        (e.keyCode === 86 && e.ctrlKey === true) ||
        (e.keyCode === 88 && e.ctrlKey === true) ||
        // Allow: home, end, left, right
        (e.keyCode >= 35 && e.keyCode <= 39)) {
      return;
    }
    // Ensure that it is a number and stop the keypress
    if ((e.shiftKey || (e.keyCode < 48 || e.keyCode > 57)) && (e.keyCode < 96 || e.keyCode > 105)) {
      e.preventDefault();
    }
  };

  return (
    <input
      type="text"
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      placeholder={placeholder || '+7(___) ___-__-__'}
      disabled={disabled}
      style={{
        fontFamily: 'monospace',
        fontSize: '16px',
        letterSpacing: '0.5px',
        ...style
      }}
    />
  );
};

export default PhoneInput;