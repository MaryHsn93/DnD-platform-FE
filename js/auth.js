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
      showError('Salvataggio dei dati di autenticazione fallito. Riprova.', 'loginErrorContainer');
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
      showError('Registrazione riuscita ma salvataggio dati fallito. Effettua il login.', 'registerErrorContainer');
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

// ====== HANDLE OTP REQUEST ======
async function handleOtpRequest(event) {
  event.preventDefault();

  const email = document.getElementById('otpEmail').value.trim();

  clearErrors('otpErrorContainer');

  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    showError(emailValidation.message, 'otpErrorContainer');
    return;
  }

  const button = document.getElementById('otpSendBtn');
  setLoading(button, true);

  try {
    await requestOtpLogin(email);

    // Show OTP code input phase
    document.getElementById('otpRequestPhase').style.display = 'none';
    document.getElementById('otpValidatePhase').style.display = 'block';

    // Start countdown for resend
    startOtpResendCountdown();

  } catch (error) {
    console.error('OTP request error:', error);
    showError(getErrorMessage(error), 'otpErrorContainer');
    setLoading(button, false);
  }
}

// ====== HANDLE OTP VALIDATE ======
async function handleOtpValidate(event) {
  event.preventDefault();

  const email = document.getElementById('otpEmail').value.trim();
  const otpCode = getOtpCodeFromInputs();

  clearErrors('otpErrorContainer');

  if (!otpCode || otpCode.length !== 6) {
    showError('Inserisci il codice OTP a 6 cifre.', 'otpErrorContainer');
    return;
  }

  const button = document.getElementById('otpValidateBtn');
  setLoading(button, true);

  try {
    const response = await validateOtpLogin(email, otpCode);

    console.log('OTP login response:', response);

    const accessToken = response.accessToken;
    const refreshToken = response.refreshToken;
    const accessTokenExpiresAt = response.accessTokenExpiresAt;
    const refreshTokenExpiresAt = response.refreshTokenExpiresAt;
    const userId = response.userId;

    const saved = saveAuthData(accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, '', email, userId);

    if (!saved) {
      showError('Login riuscito ma salvataggio dati fallito. Riprova.', 'otpErrorContainer');
      setLoading(button, false);
      return;
    }

    console.log('OTP login successful, redirecting to dashboard...');
    window.location.href = 'dashboard.html';

  } catch (error) {
    console.error('OTP validate error:', error);
    showError(getErrorMessage(error), 'otpErrorContainer');
    setLoading(button, false);
  }
}

// ====== OTP CODE INPUT HELPERS ======
function getOtpCodeFromInputs() {
  const inputs = document.querySelectorAll('.otp-digit');
  let code = '';
  inputs.forEach(input => { code += input.value; });
  return code;
}

function setupOtpInputs() {
  const inputs = document.querySelectorAll('.otp-digit');
  inputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val.slice(0, 1);
      if (val && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        inputs[index - 1].focus();
      }
    });
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      for (let i = 0; i < inputs.length && i < paste.length; i++) {
        inputs[i].value = paste[i];
      }
      const focusIdx = Math.min(paste.length, inputs.length - 1);
      inputs[focusIdx].focus();
    });
  });
}

function startOtpResendCountdown() {
  const resendBtn = document.getElementById('otpResendBtn');
  if (!resendBtn) return;
  let seconds = 60;
  resendBtn.disabled = true;
  resendBtn.textContent = `Reinvia codice (${seconds}s)`;
  const interval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(interval);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Reinvia codice';
    } else {
      resendBtn.textContent = `Reinvia codice (${seconds}s)`;
    }
  }, 1000);
}

// ====== REATTACH LISTENERS (called by toggleForm) ======
function reattachListeners() {
  console.log('Reattaching event listeners...');
  attachFormListeners();
}
