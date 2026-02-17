// ====== TAVERN CHAT MODULE ======
// WebSocket + REST integration with chat-service (port 8086)
const TavernChat = (function () {
  'use strict';

  // ====== STATE ======
  let _ws = null;
  let _reconnectAttempts = 0;
  let _reconnectTimer = null;
  let _heartbeatTimer = null;
  let _pollingTimer = null;
  let _wsConnectedOnce = false;
  let _wsConnectTimeout = null;

  let _currentTab = 'tavern';
  let _conversations = { tavern: null, party: null };
  let _messages = { tavern: [], party: [] };
  let _messageIds = new Set();
  let _onlineUsers = [];
  let _unreadCount = 0;
  let _chatOpen = false;
  let _backendAvailable = false;
  let _username = '';
  let _userId = null;

  // Pagination state
  let _pages = { tavern: 0, party: 0 };
  let _hasMore = { tavern: true, party: true };
  let _loadingMore = false;

  const MAX_RECONNECT_DELAY = 30000;
  const HEARTBEAT_INTERVAL = 30000;
  const POLLING_INTERVAL = 10000;
  const WS_CONNECT_TIMEOUT = 5000;
  const PAGE_SIZE = 30;

  // ====== PUBLIC API ======

  function init() {
    _username = localStorage.getItem('username') || 'Adventurer';
    _userId = localStorage.getItem('userId');

    _setupTabListeners();
    _setupScrollListener();
    _connectWebSocket();

    // Fallback: if WS not connected within timeout, start polling
    _wsConnectTimeout = setTimeout(function () {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        console.log('[TavernChat] WebSocket not connected after timeout, starting polling fallback');
        _startPolling();
      }
    }, WS_CONNECT_TIMEOUT);

    // Cleanup on page unload
    window.addEventListener('beforeunload', destroy);

    // Resolve conversations and load initial messages
    _resolveConversations();
  }

  function destroy() {
    if (_ws) {
      _ws.onclose = null; // prevent reconnect
      _ws.close();
      _ws = null;
    }
    clearTimeout(_reconnectTimer);
    clearInterval(_heartbeatTimer);
    clearInterval(_pollingTimer);
    clearTimeout(_wsConnectTimeout);
    window.removeEventListener('beforeunload', destroy);
  }

  function toggleChat() {
    var chatWindow = document.getElementById('chatWindow');
    var chatToggleBtn = document.getElementById('chatToggleBtn');
    if (!chatWindow || !chatToggleBtn) return;

    _chatOpen = !_chatOpen;
    chatWindow.classList.toggle('active', _chatOpen);
    chatToggleBtn.classList.toggle('active', _chatOpen);

    if (_chatOpen) {
      _unreadCount = 0;
      _updateNotificationBadge();
      var convId = _conversations[_currentTab];
      if (convId) _markAsRead(convId);
      _scrollToBottom();
    }
  }

  function sendMessage() {
    var input = document.getElementById('chatInput');
    if (!input) return;

    var content = input.value.trim();
    if (!content) return;

    var convId = _conversations[_currentTab];
    if (!convId) {
      console.warn('[TavernChat] No conversation for tab:', _currentTab);
      _showChatError('Cannot send messages — the chat server is unreachable. Retrying...');
      if (!_backendAvailable) _resolveConversations();
      return;
    }

    input.value = '';

    // Optimistic UI: show message immediately
    var optimisticMsg = {
      id: 'optimistic-' + Date.now(),
      senderUsername: _username,
      senderId: _userId ? parseInt(_userId, 10) : 0,
      content: content,
      createdAt: new Date().toISOString(),
      _optimistic: true
    };
    _addMessage(_currentTab, optimisticMsg);
    _renderSingleMessage(optimisticMsg);
    _scrollToBottom();

    // Send via WebSocket if connected, otherwise REST
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({
        type: 'SEND_MESSAGE',
        conversationId: convId,
        content: content
      }));
    } else {
      _sendMessageREST(convId, content);
    }
  }

  function handleKeypress(e) {
    if (e.key === 'Enter') sendMessage();
  }

  function switchTab(tab) {
    _currentTab = tab;

    // Update tab UI
    document.querySelectorAll('.chat-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    _renderMessages(tab);

    if (!_backendAvailable && !_conversations[tab]) {
      _renderConnectionError();
      return;
    }

    _scrollToBottom();

    // Mark as read
    var convId = _conversations[tab];
    if (convId && _chatOpen) _markAsRead(convId);

    // Load messages if none yet
    if (_messages[tab].length === 0 && convId) {
      _fetchMessages(convId, 0).then(function (msgs) {
        if (msgs && msgs.length > 0) {
          msgs.forEach(function (m) { _addMessage(tab, m); });
          _renderMessages(tab);
          _scrollToBottom();
        }
      });
    }
  }

  // ====== WEBSOCKET ======

  async function _connectWebSocket() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    _updateConnectionIndicator('connecting');

    var token = getAuthToken();
    if (isAccessTokenExpired()) {
      try {
        token = await refreshAccessToken();
      } catch (e) {
        console.error('[TavernChat] Token refresh failed:', e);
        _updateConnectionIndicator('disconnected');
        _scheduleReconnect();
        return;
      }
    }

    var wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProtocol + '//' + ENV.API_HOST + ':' + ENV.CHAT_PORT + API_CONFIG.CHAT.WS + '?token=' + encodeURIComponent(token);

    try {
      _ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[TavernChat] WebSocket creation failed:', e);
      _updateConnectionIndicator('disconnected');
      _scheduleReconnect();
      return;
    }

    _ws.onopen = function () {
      console.log('[TavernChat] WebSocket connected');
      _reconnectAttempts = 0;
      _wsConnectedOnce = true;
      _updateConnectionIndicator('connected');
      _startHeartbeat();
      _stopPolling();
      clearTimeout(_wsConnectTimeout);
    };

    _ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
        _handleWsMessage(data);
      } catch (e) {
        console.warn('[TavernChat] Failed to parse WS message:', e);
      }
    };

    _ws.onclose = function (event) {
      console.log('[TavernChat] WebSocket closed:', event.code, event.reason);
      _updateConnectionIndicator('disconnected');
      _stopHeartbeat();
      _scheduleReconnect();
      if (_wsConnectedOnce) _startPolling();
    };

    _ws.onerror = function (event) {
      console.error('[TavernChat] WebSocket error:', event);
    };
  }

  function _handleWsMessage(data) {
    switch (data.type) {
      case 'NEW_MESSAGE':
        _onNewMessage(data);
        break;
      case 'USER_ONLINE':
        _onUserOnline(data);
        break;
      case 'USER_OFFLINE':
        _onUserOffline(data);
        break;
      case 'PONG':
        // heartbeat response, nothing to do
        break;
      default:
        console.log('[TavernChat] Unknown WS message type:', data.type);
    }
  }

  function _onNewMessage(data) {
    var msg = data.message || data;

    // Deduplication
    if (msg.id && _messageIds.has(msg.id)) {
      // Remove optimistic version if server confirmed
      _removeOptimisticMessage(msg);
      return;
    }

    // Determine which tab
    var tab = _getTabForConversation(msg.conversationId);
    if (!tab) return;

    _addMessage(tab, msg);

    if (tab === _currentTab) {
      _renderSingleMessage(msg);
      _scrollToBottom();
    }

    // Notification if chat is closed
    if (!_chatOpen) {
      _unreadCount++;
      _updateNotificationBadge();
    }
  }

  function _onUserOnline(data) {
    var user = { id: data.userId, username: data.username };
    if (!_onlineUsers.find(function (u) { return u.id === user.id; })) {
      _onlineUsers.push(user);
      _renderOnlineUsers();
    }
  }

  function _onUserOffline(data) {
    _onlineUsers = _onlineUsers.filter(function (u) { return u.id !== data.userId; });
    _renderOnlineUsers();
  }

  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    var delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), MAX_RECONNECT_DELAY);
    _reconnectAttempts++;
    console.log('[TavernChat] Reconnecting in ' + delay + 'ms (attempt ' + _reconnectAttempts + ')');
    _updateConnectionIndicator('connecting');
    _reconnectTimer = setTimeout(function () {
      _connectWebSocket();
    }, delay);
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(function () {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  function _stopHeartbeat() {
    clearInterval(_heartbeatTimer);
  }

  // ====== POLLING FALLBACK ======

  function _startPolling() {
    if (_pollingTimer) return;
    console.log('[TavernChat] Starting polling fallback');
    _pollingTimer = setInterval(function () {
      _pollMessages();
    }, POLLING_INTERVAL);
    _pollMessages(); // immediate first poll
  }

  function _stopPolling() {
    if (_pollingTimer) {
      console.log('[TavernChat] Stopping polling fallback');
      clearInterval(_pollingTimer);
      _pollingTimer = null;
    }
  }

  function _pollMessages() {
    ['tavern', 'party'].forEach(function (tab) {
      var convId = _conversations[tab];
      if (!convId) return;
      _fetchMessages(convId, 0).then(function (msgs) {
        if (!msgs) return;
        var newMsgs = false;
        msgs.forEach(function (m) {
          if (!_messageIds.has(m.id)) {
            _addMessage(tab, m);
            newMsgs = true;
          }
        });
        if (newMsgs && tab === _currentTab) {
          _renderMessages(tab);
          _scrollToBottom();
        }
      });
    });
  }

  // ====== REST API ======

  async function _fetchConversations() {
    var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.CONVERSATIONS;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      return result.data;
    } catch (e) {
      console.error('[TavernChat] Failed to fetch conversations:', e);
      return [];
    }
  }

  async function _fetchMessages(convId, page) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.MESSAGES.replace('{conversationId}', convId) +
      '?page=' + page + '&pageSize=' + PAGE_SIZE;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      var data = result.data;
      // Handle paginated response
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.content)) return data.content;
      return [];
    } catch (e) {
      console.error('[TavernChat] Failed to fetch messages:', e);
      return [];
    }
  }

  async function _sendMessageREST(convId, content) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.MESSAGES.replace('{conversationId}', convId);
    try {
      await authenticatedRequest(url, {
        method: 'POST',
        body: JSON.stringify({ content: content })
      });
    } catch (e) {
      console.error('[TavernChat] Failed to send message via REST:', e);
    }
  }

  async function _markAsRead(convId) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.CONVERSATIONS_READ.replace('{id}', convId);
    try {
      await authenticatedRequest(url, { method: 'PUT' });
    } catch (e) {
      // Non-critical, just log
      console.warn('[TavernChat] Failed to mark as read:', e);
    }
  }

  async function _createConversation(type, name, participantIds) {
    var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.CONVERSATIONS;
    try {
      var result = await authenticatedRequest(url, {
        method: 'POST',
        body: JSON.stringify({
          type: type,
          name: name,
          participantIds: participantIds || []
        })
      });
      return result.data;
    } catch (e) {
      console.error('[TavernChat] Failed to create conversation:', e);
      return null;
    }
  }

  // ====== CONVERSATION RESOLUTION ======

  async function _resolveConversations() {
    var convs = await _fetchConversations();

    // If fetch returned empty and no conversations were previously resolved, backend is down
    if (convs.length === 0 && !_conversations.tavern && !_conversations.party) {
      _backendAvailable = false;
      _renderConnectionError();
      return;
    }

    _backendAvailable = true;
    _clearChatError();

    // Find Tavern group conversation
    var tavern = convs.find(function (c) {
      return c.type === 'GROUP' && c.name === 'Tavern';
    });
    if (tavern) {
      _conversations.tavern = tavern.id;
    } else {
      // Try to create Tavern
      var created = await _createConversation('GROUP', 'Tavern', []);
      if (created) _conversations.tavern = created.id;
    }

    // Find My Party group conversation
    var party = convs.find(function (c) {
      return c.type === 'GROUP' && c.name === 'My Party';
    });
    if (party) {
      _conversations.party = party.id;
    }
    // If no party conversation, show placeholder (handled in render)

    // Load initial messages for current tab
    var convId = _conversations[_currentTab];
    if (convId) {
      var msgs = await _fetchMessages(convId, 0);
      if (msgs && msgs.length > 0) {
        msgs.forEach(function (m) { _addMessage(_currentTab, m); });
        _renderMessages(_currentTab);
        _scrollToBottom();
      }
    }

    // Render party placeholder if needed
    if (!_conversations.party && _currentTab === 'party') {
      _renderPartyPlaceholder();
    }
  }

  // ====== MESSAGE MANAGEMENT ======

  function _addMessage(tab, msg) {
    if (msg.id && _messageIds.has(msg.id)) return;
    if (msg.id) _messageIds.add(msg.id);
    _messages[tab].push(msg);
  }

  function _removeOptimisticMessage(confirmedMsg) {
    ['tavern', 'party'].forEach(function (tab) {
      _messages[tab] = _messages[tab].filter(function (m) {
        // Remove optimistic messages that match sender + content
        if (m._optimistic &&
            m.senderUsername === confirmedMsg.senderUsername &&
            m.content === confirmedMsg.content) {
          return false;
        }
        return true;
      });
    });
    // Add the confirmed message
    var tab = _getTabForConversation(confirmedMsg.conversationId);
    if (tab) {
      _addMessage(tab, confirmedMsg);
      if (tab === _currentTab) {
        _renderMessages(tab);
        _scrollToBottom();
      }
    }
  }

  function _getTabForConversation(convId) {
    if (_conversations.tavern === convId) return 'tavern';
    if (_conversations.party === convId) return 'party';
    return null;
  }

  // ====== UI RENDERING ======

  function _renderMessages(tab) {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    container.innerHTML = '';

    if (!_conversations[tab] && tab === 'party') {
      _renderPartyPlaceholder();
      return;
    }

    _messages[tab].forEach(function (msg) {
      container.appendChild(_createMessageElement(msg));
    });
  }

  function _renderSingleMessage(msg) {
    var container = document.getElementById('chatMessages');
    if (!container) return;
    container.appendChild(_createMessageElement(msg));
  }

  function _createMessageElement(msg) {
    var isSent = msg.senderUsername === _username ||
                 (msg.senderId && msg.senderId.toString() === _userId);
    var sender = msg.senderUsername || 'Unknown';
    var content = _escapeHtml(msg.content || '');
    var time = _formatTime(msg.createdAt);

    var div = document.createElement('div');
    div.className = 'message ' + (isSent ? 'sent' : 'received');
    if (msg.id) div.dataset.msgId = msg.id;

    div.innerHTML =
      '<div class="message-header">' +
        '<div class="message-avatar">' + _escapeHtml(sender.charAt(0).toUpperCase()) + '</div>' +
        '<span class="message-sender">' + _escapeHtml(sender) + '</span>' +
        '<span class="message-time">' + time + '</span>' +
      '</div>' +
      '<div class="message-content">' + content + '</div>';

    return div;
  }

  function _renderConnectionError() {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    var isParty = _currentTab === 'party';
    var title = isParty ? 'Party Unreachable' : 'Tavern Unreachable';
    var text = isParty
      ? 'Unable to reach your party. The chat server is not responding.'
      : 'The chat server is not responding. Check that the service is running.';

    container.innerHTML =
      '<div style="text-align:center;padding:2rem 1rem;font-size:0.9rem;">' +
        '<div style="width:48px;height:48px;margin:0 auto 1rem;border-radius:50%;background:rgba(239,68,68,0.15);display:flex;align-items:center;justify-content:center;">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        '</div>' +
        '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">' + title + '</p>' +
        '<p style="color:var(--text-muted);margin-bottom:1rem;">' + text + '</p>' +
        '<button onclick="TavernChat._retry()" style="padding:0.6rem 1.5rem;background:linear-gradient(135deg,var(--primary),#5a1414);border:1px solid var(--gold);border-radius:10px;color:var(--gold);font-family:Cinzel,serif;font-size:0.85rem;cursor:pointer;transition:all 0.3s ease;">Retry</button>' +
      '</div>';
  }

  function _showChatError(message) {
    // Remove any existing error toast
    _clearChatError();
    var container = document.getElementById('chatMessages');
    if (!container) return;

    var toast = document.createElement('div');
    toast.id = 'chatErrorToast';
    toast.style.cssText = 'padding:0.6rem 1rem;margin:0.25rem 0;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:10px;font-size:0.8rem;color:#fca5a5;text-align:center;animation:messageSlide 0.3s ease;';
    toast.textContent = message;
    container.appendChild(toast);
    _scrollToBottom();

    // Auto-dismiss after 4 seconds
    setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 4000);
  }

  function _clearChatError() {
    var toast = document.getElementById('chatErrorToast');
    if (toast) toast.remove();
  }

  function _renderPartyPlaceholder() {
    var container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML =
      '<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.9rem;">' +
        '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">No Party Yet</p>' +
        '<p>You are not in a party yet. Join or create one to chat with your companions!</p>' +
      '</div>';
  }

  function _renderOnlineUsers() {
    var container = document.getElementById('onlineUsers');
    if (!container) return;

    container.innerHTML = '';
    _onlineUsers.forEach(function (user) {
      var name = _escapeHtml(user.username || 'Unknown');
      var initial = name.charAt(0).toUpperCase();
      var el = document.createElement('div');
      el.className = 'online-user';
      el.dataset.user = name;
      el.innerHTML =
        '<div class="online-user-avatar">' + initial + '</div>' +
        '<span class="online-user-name">' + name + '</span>';
      el.addEventListener('click', function () {
        var input = document.getElementById('chatInput');
        if (input) {
          input.value = '@' + name + ' ' + input.value;
          input.focus();
        }
      });
      container.appendChild(el);
    });

    // Update online count
    var countEl = document.getElementById('onlineCountText');
    if (countEl) {
      countEl.textContent = _onlineUsers.length + ' online';
    }
  }

  function _updateNotificationBadge() {
    var badge = document.getElementById('chatNotification');
    if (!badge) return;

    if (_unreadCount > 0) {
      badge.textContent = _unreadCount > 9 ? '9+' : _unreadCount;
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }

  function _updateConnectionIndicator(status) {
    var dot = document.querySelector('.online-dot');
    if (!dot) return;

    switch (status) {
      case 'connected':
        dot.style.background = '#4ade80';
        break;
      case 'connecting':
        dot.style.background = '#facc15';
        break;
      case 'disconnected':
        dot.style.background = '#ef4444';
        break;
    }
  }

  function _scrollToBottom() {
    var container = document.getElementById('chatMessages');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // ====== INFINITE SCROLL (older messages) ======

  function _setupScrollListener() {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    container.addEventListener('scroll', function () {
      if (container.scrollTop === 0 && !_loadingMore) {
        _loadOlderMessages();
      }
    });
  }

  async function _loadOlderMessages() {
    var tab = _currentTab;
    var convId = _conversations[tab];
    if (!convId || !_hasMore[tab]) return;

    _loadingMore = true;
    _pages[tab]++;

    var msgs = await _fetchMessages(convId, _pages[tab]);
    _loadingMore = false;

    if (!msgs || msgs.length === 0) {
      _hasMore[tab] = false;
      return;
    }

    if (msgs.length < PAGE_SIZE) {
      _hasMore[tab] = false;
    }

    var container = document.getElementById('chatMessages');
    var prevScrollHeight = container ? container.scrollHeight : 0;

    // Prepend older messages
    msgs.forEach(function (m) {
      if (!_messageIds.has(m.id)) {
        _addMessage(tab, m);
      }
    });

    // Sort messages by timestamp
    _messages[tab].sort(function (a, b) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    _renderMessages(tab);

    // Maintain scroll position
    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    }
  }

  // ====== TAB LISTENERS ======

  function _setupTabListeners() {
    document.querySelectorAll('.chat-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.dataset.tab);
      });
    });
  }

  // ====== UTILITIES ======

  function _escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function _formatTime(isoString) {
    if (!isoString) return '';
    try {
      var d = new Date(isoString);
      return d.getHours().toString().padStart(2, '0') + ':' +
             d.getMinutes().toString().padStart(2, '0');
    } catch (e) {
      return '';
    }
  }

  // ====== EXPOSE PUBLIC API ======
  return {
    init: init,
    destroy: destroy,
    toggleChat: toggleChat,
    sendMessage: sendMessage,
    handleKeypress: handleKeypress,
    switchTab: switchTab,
    _retry: function () {
      _renderMessages(_currentTab); // clear error screen
      _resolveConversations();
      _connectWebSocket();
    }
  };
})();
