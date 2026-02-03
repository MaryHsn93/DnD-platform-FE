// ====== API CONFIGURATION ======
const API_CONFIG = {
  LOGIN: {
    BASE_URL: 'http://192.168.3.70:8081',
    ENDPOINT: '/auth/login-tokens'
  },
  LOGOUT: {
    BASE_URL: 'http://192.168.3.70:8081',
    ENDPOINT: '/auth/login-tokens'
  },
  REFRESH: {
    BASE_URL: 'http://192.168.3.70:8081',
    ENDPOINT: '/auth/login-tokens/refreshed'
  },
  REGISTER: {
    BASE_URL: 'http://192.168.3.70:8089',
    ENDPOINT: '/users'
  },
  COMPENDIUM: {
    BASE_URL: 'http://192.168.3.70:8090',
    CLASSES: '/api/compendium/classes',
    SPECIES: '/api/compendium/species',
    SPELLS: '/api/compendium/spells'
  },
  TIMEOUT: 10000 // 10 seconds
};

// ====== GENERIC API REQUEST WRAPPER ======
async function apiRequest(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        ...options.headers
      }
    });

    clearTimeout(timeoutId);

    // Parse response body
    let data;
    try {
      data = await response.json();
    } catch (e) {
      // If JSON parsing fails, return text or empty object
      data = await response.text().catch(() => ({}));
    }

    // Handle HTTP errors
    if (!response.ok) {
      const error = new Error(data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return { success: true, data, status: response.status };

  } catch (error) {
    clearTimeout(timeoutId);

    // Handle abort (timeout)
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Request timeout');
      timeoutError.status = 408;
      timeoutError.isTimeout = true;
      throw timeoutError;
    }

    // Handle network errors
    if (!error.status) {
      error.isNetworkError = true;
    }

    throw error;
  }
}

// ====== TOKEN REFRESH ======
let _refreshPromise = null;

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  const userId = getUserId();

  if (!refreshToken || !userId) {
    throw new Error('Missing refresh token or userId');
  }

  const url = API_CONFIG.REFRESH.BASE_URL + API_CONFIG.REFRESH.ENDPOINT;

  const result = await apiRequest(url, {
    method: 'POST',
    headers: { 'accept': '*/*' },
    body: JSON.stringify({
      token: refreshToken,
      userId: parseInt(userId, 10)
    })
  });

  const data = result.data;
  localStorage.setItem('authToken', data.accessToken);
  if (data.refreshToken) {
    localStorage.setItem('refreshToken', data.refreshToken);
  }
  if (data.accessTokenExpiresAt) {
    localStorage.setItem('accessTokenExpiresAt', data.accessTokenExpiresAt.toString());
  }
  if (data.refreshTokenExpiresAt) {
    localStorage.setItem('refreshTokenExpiresAt', data.refreshTokenExpiresAt.toString());
  }

  return data.accessToken;
}

async function authenticatedRequest(url, options = {}) {
  // Proactively refresh token if expired (avoids 401 + CORS issues)
  let token = getAuthToken();
  if (isAccessTokenExpired()) {
    console.log('Access token expired, refreshing proactively...');
    try {
      if (!_refreshPromise) {
        _refreshPromise = refreshAccessToken().finally(() => {
          _refreshPromise = null;
        });
      }
      token = await _refreshPromise;
    } catch (refreshError) {
      console.error('Proactive refresh failed, showing re-login overlay:', refreshError);
      token = await showReloginOverlay();
    }
  }

  const reqOptions = {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': 'Bearer ' + token
    }
  };

  try {
    return await apiRequest(url, reqOptions);
  } catch (error) {
    if (error.status !== 401 && !error.isNetworkError) {
      throw error;
    }

    // 401 or network error (CORS-blocked 401) — attempt token refresh
    try {
      if (!_refreshPromise) {
        _refreshPromise = refreshAccessToken().finally(() => {
          _refreshPromise = null;
        });
      }
      const newToken = await _refreshPromise;

      // Retry original request with new token
      reqOptions.headers['Authorization'] = 'Bearer ' + newToken;
      return await apiRequest(url, reqOptions);
    } catch (refreshError) {
      console.error('Token refresh failed, showing re-login overlay:', refreshError);

      // Show overlay instead of redirecting — user stays on the current page
      const newToken = await showReloginOverlay();

      // Retry original request with the token from re-login
      reqOptions.headers['Authorization'] = 'Bearer ' + newToken;
      return await apiRequest(url, reqOptions);
    }
  }
}

// ====== LOGIN USER ======
async function loginUser(username, email, password) {
  const url = API_CONFIG.LOGIN.BASE_URL + API_CONFIG.LOGIN.ENDPOINT;

  console.log('Attempting login for:', { username, email });

  try {
    const result = await apiRequest(url, {
      method: 'POST',
      body: JSON.stringify({
        username,
        email,
        password
      })
    });

    console.log('Login successful:', result);
    return result.data;

  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

// ====== REGISTER USER ======
async function registerUser(username, email, password) {
  const url = API_CONFIG.REGISTER.BASE_URL + API_CONFIG.REGISTER.ENDPOINT;

  console.log('Attempting registration for:', { username, email });

  try {
    const result = await apiRequest(url, {
      method: 'POST',
      body: JSON.stringify({
        username,
        email,
        password
      })
    });

    console.log('Registration successful:', result);
    return result.data;

  } catch (error) {
    console.error('Registration error:', error);
    throw error;
  }
}

// ====== GET CLASSES ======
async function getClasses() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.CLASSES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Classes fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get classes error:', error);
    throw error;
  }
}

// ====== GET SPECIES ======
async function getSpecies() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.SPECIES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Species fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get species error:', error);
    throw error;
  }
}

// ====== GET SPELLS ======
async function getSpells() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.SPELLS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Spells fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get spells error:', error);
    throw error;
  }
}

// ====== LOGOUT USER ======
async function logoutUser(token, userId) {
  const url = `${API_CONFIG.LOGOUT.BASE_URL}${API_CONFIG.LOGOUT.ENDPOINT}/${token}?userId=${userId}`;

  console.log('Logout');

  try {
    const result = await apiRequest(url, {
      method: 'DELETE',
      headers: {
        'accept': '*/*'
      }
    });

    console.log('Logout successful:', result);
    return result.data;

  } catch (error) {
    console.error('Logout error:', error);
    throw error;
  }
}
