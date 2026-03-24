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
    const raw = localStorage.getItem('accessTokenExpiresAt');
    if (!raw) return null;

    let expiresAt = Number(raw);

    // If not a valid number, try parsing as ISO date string
    if (isNaN(expiresAt)) {
      expiresAt = new Date(raw).getTime();
    }

    // If value looks like seconds (< 1e12) instead of milliseconds, convert
    if (expiresAt > 0 && expiresAt < 1e12) {
      expiresAt *= 1000;
    }

    return expiresAt > 0 ? expiresAt : null;
  } catch (error) {
    console.error('Failed to get access token expiry:', error);
    return null;
  }
}

function isAccessTokenExpired() {
  const expiresAt = getAccessTokenExpiresAt();
  if (!expiresAt) return false; // No expiry info — assume valid, let 401 handler decide
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

// ====== RE-LOGIN OVERLAY ======

let _reloginPromise = null;

function showReloginOverlay() {
  // Deduplicate: if overlay is already showing, return the same promise
  if (_reloginPromise) return _reloginPromise;

  _reloginPromise = new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'relogin-overlay';
    overlay.innerHTML = `
      <style>
        #relogin-overlay {
          position: fixed;
          top: 0; left: 0;
          width: 100%; height: 100%;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: reloginFadeIn 0.3s ease;
        }
        @keyframes reloginFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .relogin-card {
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(20px) saturate(160%);
          -webkit-backdrop-filter: blur(20px) saturate(160%);
          padding: 2rem;
          border-radius: 20px;
          width: 100%;
          max-width: 360px;
          margin: 1rem;
          border: 1px solid rgba(212, 175, 55, 0.35);
          box-shadow:
            0 8px 32px rgba(0, 0, 0, 0.15),
            inset 0 1px 0 rgba(255, 255, 255, 0.15),
            0 0 60px rgba(212, 175, 55, 0.2);
          animation: reloginSlideUp 0.4s ease;
          font-family: 'Inter', sans-serif;
          color: #f5f5f5;
        }
        @keyframes reloginSlideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .relogin-card h3 {
          font-family: 'Cinzel', serif;
          margin-bottom: 0.5rem;
          text-align: center;
          color: #d4af37;
          text-shadow: 0 0 20px rgba(212, 175, 55, 0.5);
        }
        .relogin-card .relogin-subtitle {
          text-align: center;
          color: #b5b5b5;
          font-size: 0.85rem;
          margin-bottom: 1.5rem;
        }
        .relogin-card input {
          width: 100%;
          padding: 0.8rem;
          margin-bottom: 1rem;
          border-radius: 12px;
          border: 1px solid rgba(212, 175, 55, 0.3);
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(15px);
          -webkit-backdrop-filter: blur(15px);
          color: #f5f5f5;
          font-family: 'Inter', sans-serif;
          font-size: 0.95rem;
          transition: all 0.3s ease;
          box-sizing: border-box;
        }
        .relogin-card input:focus {
          outline: none;
          border-color: rgba(212, 175, 55, 0.8);
          background: rgba(255, 255, 255, 0.08);
          box-shadow: 0 0 25px rgba(212, 175, 55, 0.4);
        }
        .relogin-card input::placeholder {
          color: rgba(181, 181, 181, 0.7);
        }
        .relogin-card button {
          width: 100%;
          padding: 0.9rem;
          background: linear-gradient(135deg,
            rgba(139, 30, 30, 0.8),
            rgba(90, 20, 20, 0.8));
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(212, 175, 55, 0.3);
          border-radius: 12px;
          font-weight: 600;
          font-size: 0.95rem;
          color: white;
          cursor: pointer;
          transition: all 0.3s ease;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
          font-family: 'Inter', sans-serif;
        }
        .relogin-card button:hover {
          transform: translateY(-2px);
          background: linear-gradient(135deg,
            rgba(139, 30, 30, 1),
            rgba(90, 20, 20, 1));
          box-shadow:
            0 5px 20px rgba(139, 30, 30, 0.6),
            0 0 30px rgba(212, 175, 55, 0.3);
          border-color: rgba(212, 175, 55, 0.5);
        }
        .relogin-card button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        .relogin-error {
          color: #ff6b6b;
          text-align: center;
          font-size: 0.85rem;
          margin-bottom: 1rem;
          min-height: 1.2em;
        }
        .relogin-success {
          color: #51cf66;
          text-align: center;
          font-size: 0.85rem;
          margin-bottom: 1rem;
          min-height: 1.2em;
        }
        .relogin-toggle {
          text-align: center;
          margin-top: 1rem;
          color: #b5b5b5;
          cursor: pointer;
          transition: all 0.3s ease;
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
        }
        .relogin-toggle:hover {
          color: #f5f5f5;
        }
        .relogin-toggle span {
          color: #d4af37;
          text-shadow: 0 0 10px rgba(212, 175, 55, 0.5);
          transition: all 0.3s ease;
        }
        .relogin-toggle span:hover {
          color: #f0d060;
          text-shadow: 0 0 15px rgba(212, 175, 55, 0.8);
        }
      </style>
      <div class="relogin-card">
        <!-- Login View -->
        <div id="relogin-login-view">
          <h3>Sessione Scaduta</h3>
          <p class="relogin-subtitle">La tua sessione è scaduta. Accedi di nuovo per continuare.</p>
          <div class="relogin-error" id="relogin-error"></div>
          <form id="relogin-form">
            <input type="text" id="relogin-identifier" placeholder="Email o Username" required />
            <input type="password" id="relogin-password" placeholder="Password" required />
            <button type="submit">Accedi</button>
          </form>
          <div class="relogin-toggle" id="relogin-otp-btn"><span>Accedi con OTP</span></div>
          <div class="relogin-toggle" id="relogin-forgot-btn"><span>Password dimenticata?</span></div>
        </div>
        <!-- OTP Login View -->
        <div id="relogin-otp-view" style="display: none;">
          <h3>Login con OTP</h3>
          <p class="relogin-subtitle">Inserisci la tua email per ricevere un codice di accesso.</p>
          <div class="relogin-error" id="relogin-otp-error"></div>
          <div id="relogin-otp-request-phase">
            <form id="relogin-otp-request-form">
              <input type="email" id="relogin-otp-email" placeholder="Email" required />
              <button type="submit">Invia Codice OTP</button>
            </form>
          </div>
          <div id="relogin-otp-validate-phase" style="display: none;">
            <p class="relogin-subtitle">Inserisci il codice a 6 cifre ricevuto via email.</p>
            <div style="display: flex; justify-content: center; gap: 0.4rem; margin-bottom: 1rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
              <input type="text" class="relogin-otp-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width: 2.5rem; height: 3rem; text-align: center; font-size: 1.3rem; font-weight: 600; padding: 0.3rem;">
            </div>
            <button id="relogin-otp-validate-btn" type="button" style="width: 100%; padding: 0.9rem; background: linear-gradient(135deg, rgba(139,30,30,0.8), rgba(90,20,20,0.8)); backdrop-filter: blur(10px); border: 1px solid rgba(212,175,55,0.3); border-radius: 12px; font-weight: 600; color: white; cursor: pointer; font-family: 'Inter', sans-serif; font-size: 0.95rem;">Accedi</button>
            <button id="relogin-otp-resend-btn" type="button" style="width: 100%; padding: 0.6rem; margin-top: 0.5rem; background: transparent; border: 1px solid rgba(212,175,55,0.2); border-radius: 12px; color: #b5b5b5; font-size: 0.85rem; cursor: pointer; font-family: 'Inter', sans-serif;">Reinvia codice</button>
          </div>
          <div class="relogin-toggle" id="relogin-otp-back-btn"><span>Torna al login</span></div>
        </div>
        <!-- Forgot Password View -->
        <div id="relogin-forgot-view" style="display: none;">
          <h3>Recupera Password</h3>
          <p class="relogin-subtitle">Inserisci la tua email e ti invieremo un link per reimpostare la password.</p>
          <div class="relogin-error" id="relogin-forgot-error"></div>
          <div class="relogin-success" id="relogin-forgot-success"></div>
          <form id="relogin-forgot-form">
            <input type="email" id="relogin-forgot-email" placeholder="Email" required />
            <button type="submit">Invia Email di Recupero</button>
          </form>
          <div class="relogin-toggle" id="relogin-back-btn"><span>Torna al login</span></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // === Login View ===
    const form = document.getElementById('relogin-form');
    const errorEl = document.getElementById('relogin-error');
    const loginView = document.getElementById('relogin-login-view');
    const forgotView = document.getElementById('relogin-forgot-view');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      const identifier = document.getElementById('relogin-identifier').value.trim();
      const password = document.getElementById('relogin-password').value;

      errorEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Accesso in corso...';

      try {
        const isEmail = identifier.includes('@');
        const username = isEmail ? identifier.split('@')[0] : identifier;
        const email = isEmail ? identifier : '';

        const data = await loginUser(username, isEmail ? identifier : '', password);
        saveAuthData(
          data.accessToken,
          data.refreshToken,
          data.accessTokenExpiresAt,
          data.refreshTokenExpiresAt,
          username,
          email || identifier,
          data.userId
        );

        overlay.remove();
        _reloginPromise = null;
        resolve(data.accessToken);
      } catch (err) {
        errorEl.textContent = getErrorMessage(err);
        btn.disabled = false;
        btn.textContent = 'Accedi';
      }
    });

    // === OTP Login ===
    const otpView = document.getElementById('relogin-otp-view');

    document.getElementById('relogin-otp-btn').addEventListener('click', () => {
      loginView.style.display = 'none';
      otpView.style.display = 'block';
      // Setup OTP digit inputs
      const otpDigits = document.querySelectorAll('.relogin-otp-digit');
      otpDigits.forEach((input, index) => {
        input.addEventListener('input', (e) => {
          const val = e.target.value.replace(/[^0-9]/g, '');
          e.target.value = val.slice(0, 1);
          if (val && index < otpDigits.length - 1) otpDigits[index + 1].focus();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && index > 0) otpDigits[index - 1].focus();
        });
        input.addEventListener('paste', (e) => {
          e.preventDefault();
          const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
          for (let i = 0; i < otpDigits.length && i < paste.length; i++) otpDigits[i].value = paste[i];
          otpDigits[Math.min(paste.length, otpDigits.length - 1)].focus();
        });
      });
    });

    document.getElementById('relogin-otp-back-btn').addEventListener('click', () => {
      otpView.style.display = 'none';
      loginView.style.display = 'block';
      // Reset OTP state
      document.getElementById('relogin-otp-email').value = '';
      document.getElementById('relogin-otp-email').disabled = false;
      document.getElementById('relogin-otp-error').textContent = '';
      document.getElementById('relogin-otp-request-phase').style.display = 'block';
      document.getElementById('relogin-otp-validate-phase').style.display = 'none';
      document.querySelectorAll('.relogin-otp-digit').forEach(d => d.value = '');
    });

    // OTP Request Form
    const otpRequestForm = document.getElementById('relogin-otp-request-form');
    const otpErrorEl = document.getElementById('relogin-otp-error');

    otpRequestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = otpRequestForm.querySelector('button');
      const email = document.getElementById('relogin-otp-email').value.trim();

      otpErrorEl.textContent = '';

      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        otpErrorEl.textContent = emailValidation.message;
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Invio in corso...';

      try {
        await requestOtpLogin(email);
        document.getElementById('relogin-otp-request-phase').style.display = 'none';
        document.getElementById('relogin-otp-validate-phase').style.display = 'block';
        // Start resend countdown
        const resendBtn = document.getElementById('relogin-otp-resend-btn');
        let seconds = 60;
        resendBtn.disabled = true;
        resendBtn.textContent = `Reinvia codice (${seconds}s)`;
        const interval = setInterval(() => {
          seconds--;
          if (seconds <= 0) { clearInterval(interval); resendBtn.disabled = false; resendBtn.textContent = 'Reinvia codice'; }
          else resendBtn.textContent = `Reinvia codice (${seconds}s)`;
        }, 1000);
      } catch (err) {
        otpErrorEl.textContent = getErrorMessage(err);
        btn.disabled = false;
        btn.textContent = 'Invia Codice OTP';
      }
    });

    // OTP Validate
    document.getElementById('relogin-otp-validate-btn').addEventListener('click', async () => {
      const email = document.getElementById('relogin-otp-email').value.trim();
      const digits = document.querySelectorAll('.relogin-otp-digit');
      let otpCode = '';
      digits.forEach(d => otpCode += d.value);

      otpErrorEl.textContent = '';

      if (!otpCode || otpCode.length !== 6) {
        otpErrorEl.textContent = 'Inserisci il codice OTP a 6 cifre.';
        return;
      }

      const btn = document.getElementById('relogin-otp-validate-btn');
      btn.disabled = true;
      btn.textContent = 'Accesso in corso...';

      try {
        const data = await validateOtpLogin(email, otpCode);
        saveAuthData(
          data.accessToken,
          data.refreshToken,
          data.accessTokenExpiresAt,
          data.refreshTokenExpiresAt,
          '',
          email,
          data.userId
        );

        overlay.remove();
        _reloginPromise = null;
        resolve(data.accessToken);
      } catch (err) {
        otpErrorEl.textContent = getErrorMessage(err);
        btn.disabled = false;
        btn.textContent = 'Accedi';
      }
    });

    // OTP Resend
    document.getElementById('relogin-otp-resend-btn').addEventListener('click', async () => {
      const email = document.getElementById('relogin-otp-email').value.trim();
      const resendBtn = document.getElementById('relogin-otp-resend-btn');
      otpErrorEl.textContent = '';
      resendBtn.disabled = true;

      try {
        await requestOtpLogin(email);
        document.querySelectorAll('.relogin-otp-digit').forEach(d => d.value = '');
        document.querySelector('.relogin-otp-digit')?.focus();
        let seconds = 60;
        resendBtn.textContent = `Reinvia codice (${seconds}s)`;
        const interval = setInterval(() => {
          seconds--;
          if (seconds <= 0) { clearInterval(interval); resendBtn.disabled = false; resendBtn.textContent = 'Reinvia codice'; }
          else resendBtn.textContent = `Reinvia codice (${seconds}s)`;
        }, 1000);
      } catch (err) {
        otpErrorEl.textContent = getErrorMessage(err);
        resendBtn.disabled = false;
      }
    });

    // === Forgot Password Toggle ===
    document.getElementById('relogin-forgot-btn').addEventListener('click', () => {
      loginView.style.display = 'none';
      forgotView.style.display = 'block';
    });

    document.getElementById('relogin-back-btn').addEventListener('click', () => {
      forgotView.style.display = 'none';
      loginView.style.display = 'block';
    });

    // === Forgot Password Form ===
    const forgotForm = document.getElementById('relogin-forgot-form');
    const forgotErrorEl = document.getElementById('relogin-forgot-error');
    const forgotSuccessEl = document.getElementById('relogin-forgot-success');

    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = forgotForm.querySelector('button');
      const email = document.getElementById('relogin-forgot-email').value.trim();

      forgotErrorEl.textContent = '';
      forgotSuccessEl.textContent = '';

      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        forgotErrorEl.textContent = emailValidation.message;
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Invio in corso...';

      try {
        await requestPasswordReset(email);
        forgotSuccessEl.textContent = 'Email inviata! Controlla la tua casella di posta per il link di recupero.';
        forgotForm.querySelector('input').disabled = true;
        btn.style.display = 'none';
      } catch (err) {
        forgotErrorEl.textContent = getErrorMessage(err);
        btn.disabled = false;
        btn.textContent = 'Invia Email di Recupero';
      }
    });
  });

  return _reloginPromise;
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
    case 404:
      return 'The requested resource was not found. Please check your input.';
    case 409:
      return 'A hero with this email already exists. Try logging in instead.';
    case 500:
      return 'The tavern keeper is unavailable. Please try again later.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}
