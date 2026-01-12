// ====== API CONFIGURATION ======
const API_CONFIG = {
  LOGIN: {
    BASE_URL: 'http://192.168.3.70:8081',
    ENDPOINT: '/auth/login-tokens'
  },
  REGISTER: {
    BASE_URL: 'http://192.168.3.70:8089',
    ENDPOINT: '/users'
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
