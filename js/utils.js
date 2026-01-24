// ====== VALIDATION FUNCTIONS ======

function validateEmail(email) {
  if (!email || email.trim() === '') {
    return { valid: false, message: 'Email is required.' };
  }

  // RFC 5322 basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return { valid: false, message: 'Please enter a valid email address.' };
  }

  return { valid: true };
}

function validatePassword(password) {
  if (!password || password.trim() === '') {
    return { valid: false, message: 'Password is required.' };
  }

  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }

  return { valid: true };
}

function validateUsername(username) {
  if (!username || username.trim() === '') {
    return { valid: false, message: 'Username is required.' };
  }

  if (username.length < 2) {
    return { valid: false, message: 'Username must be at least 2 characters long.' };
  }

  return { valid: true };
}

// ====== ERROR DISPLAY ======

function showError(message, containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`Error container ${containerId} not found`);
    return;
  }

  // Clear existing errors
  clearErrors(containerId);

  // Create error message element
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = message;
  errorDiv.setAttribute('role', 'alert');

  // Insert error message
  container.appendChild(errorDiv);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (errorDiv.parentNode === container) {
      errorDiv.style.opacity = '0';
      setTimeout(() => {
        if (errorDiv.parentNode === container) {
          container.removeChild(errorDiv);
        }
      }, 300);
    }
  }, 5000);
}

function clearErrors(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const errorMessages = container.querySelectorAll('.error-message');
  errorMessages.forEach(msg => {
    if (msg.parentNode === container) {
      container.removeChild(msg);
    }
  });
}

// ====== TOKEN MANAGEMENT ======

function saveAuthData(accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, username, email, userId) {
  try {
    localStorage.setItem('authToken', accessToken);
    if (refreshToken) {
      localStorage.setItem('refreshToken', refreshToken);
    }
    if (accessTokenExpiresAt) {
      localStorage.setItem('accessTokenExpiresAt', accessTokenExpiresAt.toString());
    }
    if (refreshTokenExpiresAt) {
      localStorage.setItem('refreshTokenExpiresAt', refreshTokenExpiresAt.toString());
    }
    localStorage.setItem('username', username);
    localStorage.setItem('userEmail', email);
    if (userId) {
      localStorage.setItem('userId', userId.toString());
    }
    localStorage.setItem('loginTimestamp', Date.now().toString());
    return true;
  } catch (error) {
    console.error('Failed to save auth data:', error);
    return false;
  }
}

function getRefreshToken() {
  try {
    return localStorage.getItem('refreshToken');
  } catch (error) {
    console.error('Failed to get refresh token:', error);
    return null;
  }
}

function getAccessTokenExpiresAt() {
  try {
    const expiresAt = localStorage.getItem('accessTokenExpiresAt');
    return expiresAt ? parseInt(expiresAt, 10) : null;
  } catch (error) {
    console.error('Failed to get access token expiry:', error);
    return null;
  }
}

function isAccessTokenExpired() {
  const expiresAt = getAccessTokenExpiresAt();
  if (!expiresAt) return true;
  return Date.now() >= expiresAt;
}

function getAuthToken() {
  try {
    return localStorage.getItem('authToken');
  } catch (error) {
    console.error('Failed to get auth token:', error);
    return null;
  }
}

function getUserId() {
  try {
    return localStorage.getItem('userId');
  } catch (error) {
    console.error('Failed to get user id:', error);
    return null;
  }
}

function clearAuthData() {
  try {
    localStorage.removeItem('authToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('accessTokenExpiresAt');
    localStorage.removeItem('refreshTokenExpiresAt');
    localStorage.removeItem('username');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userId');
    localStorage.removeItem('loginTimestamp');
    return true;
  } catch (error) {
    console.error('Failed to clear auth data:', error);
    return false;
  }
}

async function handleLogout() {
  const refreshToken = getRefreshToken();
  const userId = getUserId();

  try {
    if (refreshToken && userId) {
      await logoutUser(refreshToken, userId);
    }
  } catch (error) {
    console.error('Logout API error:', error);
  } finally {
    clearAuthData();
    window.location.href = 'index.html';
  }
}

function isAuthenticated() {
  return !!getAuthToken();
}

// ====== LOADING STATE ======

function setLoading(button, isLoading) {
  if (!button) return;

  if (isLoading) {
    button.disabled = true;
    button.classList.add('loading');
    button.setAttribute('data-original-text', button.textContent);
    button.textContent = button.textContent.replace(/\.\.\.$/, '');
  } else {
    button.disabled = false;
    button.classList.remove('loading');
    const originalText = button.getAttribute('data-original-text');
    if (originalText) {
      button.textContent = originalText;
      button.removeAttribute('data-original-text');
    }
  }
}

// ====== ERROR MAPPER ======

function getErrorMessage(error) {
  // Timeout error
  if (error.isTimeout) {
    return 'The spell took too long to cast. Please try again.';
  }

  // Network error
  if (error.isNetworkError) {
    return 'Cannot reach the tavern. Check your connection.';
  }

  // HTTP status errors
  switch (error.status) {
    case 400:
      // Extract message from violations array if present
      if (error.data?.violations?.length > 0) {
        return error.data.violations[0].message;
      }
      return error.data?.message || 'Invalid request. Please check your input.';
    case 401:
      return 'Invalid credentials. Check your Email/Username and Password.';
    case 409:
      return 'A hero with this email already exists. Try logging in instead.';
    case 500:
      return 'The tavern keeper is unavailable. Please try again later.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}
