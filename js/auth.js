// ====== AUTHENTICATION LOGIC ======

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  attachFormListeners();
});

// ====== ATTACH EVENT LISTENERS ======
function attachFormListeners() {
  // Detect which form is currently displayed
  const loginButton = document.getElementById('loginButton');
  const registerButton = document.getElementById('registerButton');

  if (loginButton) {
    loginButton.addEventListener('click', handleLogin);
    console.log('Login listener attached');
  }

  if (registerButton) {
    registerButton.addEventListener('click', handleRegister);
    console.log('Register listener attached');
  }
}

// ====== HANDLE LOGIN ======
async function handleLogin(event) {
  event.preventDefault();

  // Get form values (email or username and password for login)
  const emailOrUsername = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  // Clear previous errors
  clearErrors('loginErrorContainer');

  // Validate inputs - check if it's empty
  if (!emailOrUsername) {
    showError('Email o Username è richiesto.', 'loginErrorContainer');
    return;
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    showError(passwordValidation.message, 'loginErrorContainer');
    return;
  }

  // Show loading state
  const button = document.getElementById('loginButton');
  setLoading(button, true);

  try {
    // Determine if input is email or username
    const isEmail = emailOrUsername.includes('@');
    const username = isEmail ? emailOrUsername.split('@')[0] : emailOrUsername;
    const email = isEmail ? emailOrUsername : '';

    // Call login API - pass username and email (email might be empty if username was provided)
    const response = await loginUser(username, emailOrUsername, password);

    console.log('Login response:', response);

    // Extract tokens from response
    const accessToken = response.accessToken;
    const refreshToken = response.refreshToken;
    const accessTokenExpiresAt = response.accessTokenExpiresAt;
    const refreshTokenExpiresAt = response.refreshTokenExpiresAt;
    const userId = response.userId;

    // Extract username and email from JWT payload or use provided values
    const finalUsername = username;
    const finalEmail = email || emailOrUsername;

    // Save authentication data
    const saved = saveAuthData(accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, finalUsername, finalEmail, userId);

    if (!saved) {
      showError('Failed to save authentication data. Please try again.', 'loginErrorContainer');
      setLoading(button, false);
      return;
    }

    // Success - redirect to dashboard
    console.log('Login successful, redirecting to dashboard...');
    window.location.href = 'dashboard.html';

  } catch (error) {
    console.error('Login error:', error);

    // Get user-friendly error message
    const errorMessage = getErrorMessage(error);
    showError(errorMessage, 'loginErrorContainer');

    // Hide loading state
    setLoading(button, false);
  }
}

// ====== HANDLE REGISTRATION ======
async function handleRegister(event) {
  event.preventDefault();

  // Get form values
  const username = document.getElementById('registerUsername').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value.trim();

  // Clear previous errors
  clearErrors('registerErrorContainer');

  // Validate inputs
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    showError(usernameValidation.message, 'registerErrorContainer');
    return;
  }

  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    showError(emailValidation.message, 'registerErrorContainer');
    return;
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    showError(passwordValidation.message, 'registerErrorContainer');
    return;
  }

  // Show loading state
  const button = document.getElementById('registerButton');
  setLoading(button, true);

  try {
    // Call register API
    const response = await registerUser(username, email, password);

    console.log('Registration response:', response);

    // Auto-login after successful registration
    console.log('Registration successful, performing auto-login...');
    const loginResponse = await loginUser(username, email, password);

    console.log('Auto-login response:', loginResponse);

    // Extract tokens from login response
    const accessToken = loginResponse.accessToken;
    const refreshToken = loginResponse.refreshToken;
    const accessTokenExpiresAt = loginResponse.accessTokenExpiresAt;
    const refreshTokenExpiresAt = loginResponse.refreshTokenExpiresAt;
    const userId = loginResponse.userId;

    // Save authentication data
    const saved = saveAuthData(accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, username, email, userId);

    if (!saved) {
      showError('Registration successful but failed to save data. Please login.', 'registerErrorContainer');
      setLoading(button, false);
      return;
    }

    // Success - redirect to dashboard
    console.log('Registration and auto-login successful, redirecting to dashboard...');
    window.location.href = 'dashboard.html';

  } catch (error) {
    console.error('Registration error:', error);

    // Get user-friendly error message
    const errorMessage = getErrorMessage(error);
    showError(errorMessage, 'registerErrorContainer');

    // Hide loading state
    setLoading(button, false);
  }
}

// ====== REATTACH LISTENERS (called by toggleForm) ======
function reattachListeners() {
  console.log('Reattaching event listeners...');
  attachFormListeners();
}
