// ====== API CONFIGURATION ======
const API_CONFIG = {
  LOGIN: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.AUTH_PORT}`,
    ENDPOINT: '/auth/login-tokens'
  },
  LOGOUT: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.AUTH_PORT}`,
    ENDPOINT: '/auth/login-tokens'
  },
  REFRESH: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.AUTH_PORT}`,
    ENDPOINT: '/auth/login-tokens/refreshed'
  },
  REGISTER: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.REGISTER_PORT}`,
    ENDPOINT: '/users'
  },
  PASSWORD_RESET: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.AUTH_PORT}`,
    ENDPOINT: '/auth/password-reset'
  },
  COMPENDIUM: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.COMPENDIUM_PORT}`,
    CLASSES: '/api/compendium/classes',
    SPECIES: '/api/compendium/species',
    SPELLS: '/api/compendium/spells',
    SPELL_SCHOOLS: '/api/compendium/spell-schools',
    MAGIC_ITEMS: '/api/compendium/magic-items',
    MONSTERS: '/api/compendium/monsters',
    EQUIPMENT: '/api/compendium/equipment',
    ARMOR_TYPES: '/api/compendium/armor-types',
    WEAPON_TYPES: '/api/compendium/weapon-types',
    BACKGROUNDS: '/api/compendium/backgrounds',
    SKILLS: '/api/compendium/skills',
    CONDITIONS: '/api/compendium/conditions',
    DAMAGE_TYPES: '/api/compendium/damage-types',
    LANGUAGES: '/api/compendium/languages',
    ALIGNMENTS: '/api/compendium/alignments',
    TOOL_TYPES: '/api/compendium/tool-types',
    PROFICIENCY_TYPES: '/api/compendium/proficiency-types'
  },
  CHAT: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.CHAT_PORT}`,
    WS: '/api/chat/ws',
    CONVERSATIONS: '/api/chat/conversations',
    CONVERSATIONS_READ: '/api/chat/conversations/{id}/read',
    MESSAGES: '/api/chat/conversations/{conversationId}/messages',
    USERS_SEARCH: '/api/chat/users/search'
  },
  CHARACTER: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.CHARACTER_PORT}`,
    CHARACTERS: '/characters',
    IMPORT_SHEET: '/characters/import-sheet',
    SHEET: '/characters/{id}/sheet'
  },
  DOCUMENT_QA: {
    BASE_URL: `http://${ENV.API_HOST}:${ENV.DOCUMENT_QA_PORT}`,
    ASK: '/api/document-qa/ask',
    CONVERSATIONS: '/api/document-qa/conversations',
    CONVERSATION: '/api/document-qa/conversations/{id}',
    MESSAGES: '/api/document-qa/conversations/{id}/messages'
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
  // Proactively refresh token if we know it's expired
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
    // Attempt refresh on 401 or network errors (CORS-blocked 401s appear as network errors)
    if (error.status !== 401 && !error.isNetworkError) {
      throw error;
    }

    // 401 or CORS-blocked 401 — attempt token refresh
    let newToken;
    try {
      if (!_refreshPromise) {
        _refreshPromise = refreshAccessToken().finally(() => {
          _refreshPromise = null;
        });
      }
      newToken = await _refreshPromise;
    } catch (refreshError) {
      console.error('Token refresh failed, showing re-login overlay:', refreshError);
      newToken = await showReloginOverlay();
    }

    // Retry with new token — errors propagate to caller
    reqOptions.headers['Authorization'] = 'Bearer ' + newToken;
    return await apiRequest(url, reqOptions);
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

// ====== GET BACKGROUNDS ======
async function getBackgrounds() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.BACKGROUNDS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Backgrounds fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get backgrounds error:', error);
    throw error;
  }
}

// ====== GET SKILLS ======
async function getSkills() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.SKILLS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Skills fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get skills error:', error);
    throw error;
  }
}

// ====== GET CONDITIONS ======
async function getConditions() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.CONDITIONS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Conditions fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get conditions error:', error);
    throw error;
  }
}

// ====== GET DAMAGE TYPES ======
async function getDamageTypes() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.DAMAGE_TYPES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Damage types fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get damage types error:', error);
    throw error;
  }
}

// ====== GET LANGUAGES ======
async function getLanguages() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.LANGUAGES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Languages fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get languages error:', error);
    throw error;
  }
}

// ====== GET ALIGNMENTS ======
async function getAlignments() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.ALIGNMENTS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Alignments fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get alignments error:', error);
    throw error;
  }
}

// ====== GET TOOL TYPES ======
async function getToolTypes() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.TOOL_TYPES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Tool types fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get tool types error:', error);
    throw error;
  }
}

// ====== GET PROFICIENCY TYPES ======
async function getProficiencyTypes() {
  const url = API_CONFIG.COMPENDIUM.BASE_URL + API_CONFIG.COMPENDIUM.PROFICIENCY_TYPES;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Proficiency types fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get proficiency types error:', error);
    throw error;
  }
}

// ====== GET CHARACTERS (PAGINATED) ======
async function getCharacters(page = 0, size = 20) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.CHARACTERS
    + '?page=' + page + '&size=' + size;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Characters fetched successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Get characters error:', error);
    throw error;
  }
}

// ====== CREATE CHARACTER ======
async function createCharacter(characterData) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.CHARACTERS;

  try {
    const result = await authenticatedRequest(url, {
      method: 'POST',
      body: JSON.stringify(characterData)
    });

    console.log('Character created successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Create character error:', error);
    throw error;
  }
}

// ====== UPDATE CHARACTER ======
async function updateCharacter(characterId, characterData) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.CHARACTERS + '/' + characterId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'PUT',
      body: JSON.stringify(characterData)
    });

    console.log('Character updated successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Update character error:', error);
    throw error;
  }
}

// ====== DELETE CHARACTER ======
async function deleteCharacter(characterId) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.CHARACTERS + '/' + characterId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'DELETE'
    });

    console.log('Character deleted successfully:', result);
    return result.data;

  } catch (error) {
    console.error('Delete character error:', error);
    throw error;
  }
}

// ====== IMPORT CHARACTER FROM PDF ======
async function importCharacterSheet(file) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.IMPORT_SHEET;

  const formData = new FormData();
  formData.append('file', file);

  try {
    let token = getAuthToken();
    if (isAccessTokenExpired()) {
      try {
        if (!_refreshPromise) {
          _refreshPromise = refreshAccessToken().finally(() => { _refreshPromise = null; });
        }
        token = await _refreshPromise;
      } catch (refreshError) {
        token = await showReloginOverlay();
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token
      },
      body: formData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = {};
    }

    if (!response.ok) {
      const error = new Error(data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    console.log('Character imported successfully:', data);
    return data;

  } catch (error) {
    console.error('Import character error:', error);
    throw error;
  }
}

// ====== GET CHARACTER SHEET PDF ======
async function getCharacterSheet(characterId) {
  const url = API_CONFIG.CHARACTER.BASE_URL + API_CONFIG.CHARACTER.SHEET.replace('{id}', characterId);

  try {
    let token = getAuthToken();
    if (isAccessTokenExpired()) {
      try {
        if (!_refreshPromise) {
          _refreshPromise = refreshAccessToken().finally(() => { _refreshPromise = null; });
        }
        token = await _refreshPromise;
      } catch (refreshError) {
        token = await showReloginOverlay();
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log('Character sheet fetched successfully, size:', arrayBuffer.byteLength);
    return arrayBuffer;

  } catch (error) {
    console.error('Get character sheet error:', error);
    throw error;
  }
}

// ====== REQUEST PASSWORD RESET ======
async function requestPasswordReset(email) {
  const url = API_CONFIG.PASSWORD_RESET.BASE_URL + API_CONFIG.PASSWORD_RESET.ENDPOINT;

  console.log('Requesting password reset for:', email);

  try {
    const result = await apiRequest(url, {
      method: 'POST',
      body: JSON.stringify({ email })
    });

    console.log('Password reset request successful:', result);
    return result.data;

  } catch (error) {
    console.error('Password reset request error:', error);
    throw error;
  }
}

// ====== DOCUMENT Q&A - ASK ======
async function askDocumentQuestion(userId, question, conversationId, documentIds) {
  const url = API_CONFIG.DOCUMENT_QA.BASE_URL + API_CONFIG.DOCUMENT_QA.ASK;

  const body = {
    userId: parseInt(userId, 10),
    question: question
  };
  if (conversationId) body.conversationId = conversationId;
  if (documentIds && documentIds.length > 0) body.documentIds = documentIds;

  try {
    const result = await authenticatedRequest(url, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    console.log('Document Q&A answer received:', result);
    return result.data;

  } catch (error) {
    console.error('Document Q&A ask error:', error);
    throw error;
  }
}

// ====== DOCUMENT Q&A - LIST CONVERSATIONS ======
async function getDocQAConversations(userId) {
  const url = API_CONFIG.DOCUMENT_QA.BASE_URL + API_CONFIG.DOCUMENT_QA.CONVERSATIONS
    + '?userId=' + userId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Document Q&A conversations fetched:', result);
    return result.data;

  } catch (error) {
    console.error('Get document Q&A conversations error:', error);
    throw error;
  }
}

// ====== DOCUMENT Q&A - GET CONVERSATION ======
async function getDocQAConversation(id, userId) {
  const url = API_CONFIG.DOCUMENT_QA.BASE_URL
    + API_CONFIG.DOCUMENT_QA.CONVERSATION.replace('{id}', id)
    + '?userId=' + userId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Document Q&A conversation fetched:', result);
    return result.data;

  } catch (error) {
    console.error('Get document Q&A conversation error:', error);
    throw error;
  }
}

// ====== DOCUMENT Q&A - GET MESSAGES ======
async function getDocQAMessages(conversationId, userId) {
  const url = API_CONFIG.DOCUMENT_QA.BASE_URL
    + API_CONFIG.DOCUMENT_QA.MESSAGES.replace('{id}', conversationId)
    + '?userId=' + userId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'GET'
    });

    console.log('Document Q&A messages fetched:', result);
    return result.data;

  } catch (error) {
    console.error('Get document Q&A messages error:', error);
    throw error;
  }
}

// ====== DOCUMENT Q&A - DELETE CONVERSATION ======
async function deleteDocQAConversation(id, userId) {
  const url = API_CONFIG.DOCUMENT_QA.BASE_URL
    + API_CONFIG.DOCUMENT_QA.CONVERSATION.replace('{id}', id)
    + '?userId=' + userId;

  try {
    const result = await authenticatedRequest(url, {
      method: 'DELETE'
    });

    console.log('Document Q&A conversation deleted:', result);
    return result.data;

  } catch (error) {
    console.error('Delete document Q&A conversation error:', error);
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
