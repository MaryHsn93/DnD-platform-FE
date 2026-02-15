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
    SPELLS: '/api/compendium/spells',
    SPELL_SCHOOLS: '/api/compendium/spell-schools',
    MAGIC_ITEMS: '/api/compendium/magic-items',
    MONSTERS: '/api/compendium/monsters',
    EQUIPMENT: '/api/compendium/equipment',
    ARMOR_TYPES: '/api/compendium/armor-types',
    WEAPON_TYPES: '/api/compendium/weapon-types'
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

// ====== GET SPELLS (PAGINATED + FILTERS) ======
async function getSpells(page = 0, pageSize = 50, filters = {}) {
  let url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.SPELLS
    + '?page=' + page + '&pageSize=' + pageSize;
  if (filters.levels && filters.levels.length > 0) {
    filters.levels.forEach(function(l) { url += '&level=' + encodeURIComponent(l); });
  }
  if (filters.schools && filters.schools.length > 0) {
    filters.schools.forEach(function(s) { url += '&school=' + encodeURIComponent(s); });
  }
  if (filters.ritual != null) url += '&ritual=' + filters.ritual;
  if (filters.concentration != null) url += '&concentration=' + filters.concentration;

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

// ====== GET SPELL SCHOOLS ======
async function getSpellSchools() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.SPELL_SCHOOLS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Spell schools fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get spell schools error:', error);
    throw error;
  }
}

// ====== GET MAGIC ITEMS (PAGINATED) ======
async function getMagicItems(page = 0, pageSize = 50) {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.MAGIC_ITEMS
    + '?page=' + page + '&pageSize=' + pageSize;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Magic items fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get magic items error:', error);
    throw error;
  }
}

// ====== GET MONSTERS (PAGINATED) ======
async function getMonsters(page = 0, pageSize = 50) {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.MONSTERS
    + '?page=' + page + '&pageSize=' + pageSize;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Monsters fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get monsters error:', error);
    throw error;
  }
}

// ====== GET EQUIPMENT (PAGINATED) ======
async function getEquipment(page = 0, pageSize = 50) {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.EQUIPMENT
    + '?page=' + page + '&pageSize=' + pageSize;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Equipment fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get equipment error:', error);
    throw error;
  }
}

// ====== GET ARMOR TYPES ======
async function getArmorTypes() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.ARMOR_TYPES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Armor types fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get armor types error:', error);
    throw error;
  }
}

// ====== GET WEAPON TYPES ======
async function getWeaponTypes(category) {
  let url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.WEAPON_TYPES;
  if (category) {
    url += '?category=' + encodeURIComponent(category);
  }

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Weapon types fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get weapon types error:', error);
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
