// ====== TAVERN CHAT MODULE ======
// WebSocket + REST integration with chat-service (port 8086)
// Tabs: Tavern (global GROUP), Groups (custom groups), Private (1-to-1 DMs)
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

  let _currentTab = 'tavern';           // 'tavern' | 'groups' | 'private'
  let _tavernConvId = null;              // ID of the Tavern GROUP conversation
  let _tavernMessages = [];              // messages for Tavern
  let _messageIds = new Set();
  let _onlineUsers = [];
  let _unreadCount = 0;
  let _chatOpen = false;
  let _backendAvailable = false;
  let _username = '';
  let _userId = null;

  // Tavern pagination
  let _tavernPage = 0;
  let _tavernHasMore = true;
  let _loadingMore = false;

  // Groups state
  let _groupConversations = [];          // [{id, type, name, participants, lastMessage, lastMessageTime, unreadCount}]
  let _messagesByConv = {};              // convId -> [msgs]
  let _pagesByConv = {};                 // convId -> pageNum
  let _hasMoreByConv = {};               // convId -> bool
  let _activeConv = { groups: null, private: null };    // currently open convId per tab
  let _viewMode = { groups: 'list', private: 'list' };  // 'list' | 'messages' | 'new'
  let _selectedGroupMembers = [];

  // Private (DM) state
  let _privateConversations = [];        // [{id, type, name, participants, lastMessage, lastMessageTime, unreadCount}]
  let _searchDebounce = null;

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
    _injectDynamicUI();
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
    clearTimeout(_searchDebounce);
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
      var convId = _getActiveConvId();
      if (convId) _markAsRead(convId);
      _scrollToBottom();
    }
  }

  function sendMessage() {
    var input = document.getElementById('chatInput');
    if (!input) return;

    var content = input.value.trim();
    if (!content) return;

    var convId = _getActiveConvId();
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
    _addMessage(convId, optimisticMsg);
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

    var chatWindow = document.getElementById('chatWindow');
    var subHeader = document.querySelector('.chat-sub-header');

    if (tab === 'tavern') {
      // Tavern: simple message view, online users visible, no sub-header
      if (subHeader) subHeader.classList.remove('active');
      if (chatWindow) {
        chatWindow.classList.remove('hide-online');
        chatWindow.classList.remove('hide-input');
      }

      _renderTavernMessages();

      if (!_backendAvailable && !_tavernConvId) {
        _renderConnectionError();
        return;
      }

      _scrollToBottom();

      if (_tavernConvId && _chatOpen) _markAsRead(_tavernConvId);

      // Load messages if none yet
      if (_tavernMessages.length === 0 && _tavernConvId) {
        _fetchMessages(_tavernConvId, 0).then(function (msgs) {
          if (msgs && msgs.length > 0) {
            msgs.forEach(function (m) { _addMessage(_tavernConvId, m); });
            _renderTavernMessages();
            _scrollToBottom();
          }
        });
      }
    } else {
      // Groups: hide online users, show sub-header context
      if (chatWindow) chatWindow.classList.add('hide-online');

      var mode = _viewMode[tab];
      if (mode === 'list') {
        _showListView(tab);
      } else if (mode === 'messages') {
        _openConversation(_activeConv[tab], tab, true);
      } else if (mode === 'new') {
        _showNewView(tab);
      }
    }
  }

  // ====== DYNAMIC UI INJECTION ======

  function _injectDynamicUI() {
    var tabsBar = document.querySelector('.chat-tabs');
    if (!tabsBar) return;

    // Create sub-header bar (inserted after .chat-tabs)
    var subHeader = document.createElement('div');
    subHeader.className = 'chat-sub-header';
    subHeader.innerHTML =
      '<button class="chat-back-btn" title="Back">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>' +
      '<span class="chat-sub-title"></span>' +
      '<button class="chat-new-btn" title="New">+</button>';

    tabsBar.insertAdjacentElement('afterend', subHeader);

    // Event listeners
    subHeader.querySelector('.chat-back-btn').addEventListener('click', function () {
      _showListView(_currentTab);
    });
    subHeader.querySelector('.chat-new-btn').addEventListener('click', function () {
      _showNewView(_currentTab);
    });
  }

  // ====== VIEW MANAGEMENT ======

  function _getActiveConvId() {
    if (_currentTab === 'tavern') return _tavernConvId;
    return _activeConv[_currentTab] || null;
  }

  function _showListView(tab) {
    if (!tab) tab = _currentTab;
    _viewMode[tab] = 'list';
    _activeConv[tab] = null;

    var subHeader = document.querySelector('.chat-sub-header');
    var chatWindow = document.getElementById('chatWindow');

    var title = tab === 'private' ? 'Private' : 'Groups';

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = title;
      subHeader.querySelector('.chat-back-btn').style.display = 'none';
      subHeader.querySelector('.chat-new-btn').style.display = 'flex';
    }

    if (chatWindow) chatWindow.classList.add('hide-input');

    _renderConversationList(tab);
  }

  function _showNewView(tab) {
    if (!tab) tab = _currentTab;

    if (tab === 'private') {
      _showNewPrivateView();
      return;
    }

    _viewMode[tab] = 'new';
    _selectedGroupMembers = [];

    var subHeader = document.querySelector('.chat-sub-header');
    var chatWindow = document.getElementById('chatWindow');

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = 'New Group';
      subHeader.querySelector('.chat-back-btn').style.display = 'flex';
      subHeader.querySelector('.chat-new-btn').style.display = 'none';
    }

    if (chatWindow) chatWindow.classList.add('hide-input');

    var container = document.getElementById('chatMessages');
    if (!container) return;

    // Groups: search + group creation form
    container.innerHTML =
      '<div class="chat-new-view">' +
        '<input type="text" class="chat-group-name-input" placeholder="Group name..." id="chatGroupName">' +
        '<input type="text" class="chat-search-input" placeholder="Search members..." id="chatUserSearch" style="margin-top:0.5rem">' +
        '<div class="member-chips" id="memberChips"></div>' +
        '<div id="chatSearchResults"></div>' +
        '<button class="chat-create-group-btn" id="createGroupBtn" disabled>Create Group</button>' +
      '</div>';

    var searchInput = document.getElementById('chatUserSearch');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var q = searchInput.value.trim();
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(function () { _searchUsers(q); }, 300);
      });
    }

    var createBtn = document.getElementById('createGroupBtn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var nameInput = document.getElementById('chatGroupName');
        var name = nameInput ? nameInput.value.trim() : '';
        if (!name || _selectedGroupMembers.length === 0) return;
        _createGroupConversation(name, _selectedGroupMembers.map(function (m) { return m.id; }));
      });
    }

    // Show online users as initial suggestions
    _renderUserResults(_onlineUsers.filter(function (u) {
      return u.id && u.id.toString() !== _userId;
    }));
  }

  function _showNewPrivateView() {
    _viewMode['private'] = 'new';

    var subHeader = document.querySelector('.chat-sub-header');
    var chatWindow = document.getElementById('chatWindow');

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = 'New Message';
      subHeader.querySelector('.chat-back-btn').style.display = 'flex';
      subHeader.querySelector('.chat-new-btn').style.display = 'none';
    }

    if (chatWindow) chatWindow.classList.add('hide-input');

    var container = document.getElementById('chatMessages');
    if (!container) return;

    container.innerHTML =
      '<div class="chat-new-view">' +
        '<input type="text" class="chat-search-input" placeholder="Search users..." id="chatUserSearch">' +
        '<div id="chatSearchResults"></div>' +
      '</div>';

    var searchInput = document.getElementById('chatUserSearch');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var q = searchInput.value.trim();
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(function () { _searchUsersForDM(q); }, 300);
      });
    }

    // Show online users as initial suggestions
    _renderDMUserResults(_onlineUsers.filter(function (u) {
      return u.id && u.id.toString() !== _userId;
    }));
  }

  function _renderConversationList(tab) {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    var list = tab === 'private' ? _privateConversations : _groupConversations;

    // Sort by lastMessageTime descending
    list.sort(function (a, b) {
      var ta = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      var tb = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return tb - ta;
    });

    if (list.length === 0) {
      var msg = tab === 'private' ? 'No private messages yet' : 'No groups yet';
      var hint = 'Tap + to start a conversation';
      container.innerHTML =
        '<div class="chat-empty-state">' +
          '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">' + msg + '</p>' +
          '<p>' + hint + '</p>' +
        '</div>';
      return;
    }

    container.innerHTML = '';
    list.forEach(function (conv) {
      var displayName = _getConvDisplayName(conv);
      var initial = displayName.charAt(0).toUpperCase();
      var preview = conv.lastMessage ? _escapeHtml(conv.lastMessage) : '';
      var time = conv.lastMessageTime ? _formatSmartTime(conv.lastMessageTime) : '';
      var unread = conv.unreadCount || 0;

      var item = document.createElement('div');
      item.className = 'conv-list-item';
      item.innerHTML =
        '<div class="conv-list-avatar">' + initial + '</div>' +
        '<div class="conv-list-details">' +
          '<div class="conv-list-name">' + _escapeHtml(displayName) + '</div>' +
          '<div class="conv-list-preview">' + preview + '</div>' +
        '</div>' +
        '<div class="conv-list-meta">' +
          '<div class="conv-list-time">' + time + '</div>' +
          (unread > 0 ? '<div class="conv-list-unread">' + (unread > 9 ? '9+' : unread) + '</div>' : '') +
        '</div>';

      item.addEventListener('click', function () {
        _openConversation(conv.id, tab);
      });
      container.appendChild(item);
    });
  }

  function _openConversation(convId, tab, skipSetMode) {
    if (!tab) tab = _currentTab;
    if (!skipSetMode) _viewMode[tab] = 'messages';
    _activeConv[tab] = convId;

    var chatWindow = document.getElementById('chatWindow');
    var subHeader = document.querySelector('.chat-sub-header');

    // Find conv to get display name
    var conv = _findConversation(convId);
    var displayName = conv ? _getConvDisplayName(conv) : 'Chat';

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = displayName;
      subHeader.querySelector('.chat-back-btn').style.display = 'flex';
      subHeader.querySelector('.chat-new-btn').style.display = 'none';
    }

    if (chatWindow) chatWindow.classList.remove('hide-input');

    // Render messages
    var msgs = _messagesByConv[convId];
    if (msgs && msgs.length > 0) {
      _renderConvMessages(convId);
      _scrollToBottom();
    } else {
      // Fetch messages
      var container = document.getElementById('chatMessages');
      if (container) container.innerHTML = '';
      _fetchMessages(convId, 0).then(function (fetched) {
        if (fetched && fetched.length > 0) {
          fetched.forEach(function (m) { _addMessage(convId, m); });
        }
        if (!_pagesByConv[convId]) _pagesByConv[convId] = 0;
        if (!_hasMoreByConv.hasOwnProperty(convId)) _hasMoreByConv[convId] = true;
        if (fetched && fetched.length < PAGE_SIZE) _hasMoreByConv[convId] = false;
        _renderConvMessages(convId);
        _scrollToBottom();
      });
    }

    if (_chatOpen) _markAsRead(convId);

    // Reset unread in the list
    if (conv) conv.unreadCount = 0;
  }

  // ====== SEARCH & GROUP CREATION ======

  async function _searchUsers(query) {
    var resultsContainer = document.getElementById('chatSearchResults');
    if (!resultsContainer) return;

    if (!query || query.length < 1) {
      // Show online users as suggestions
      _renderUserResults(_onlineUsers.filter(function (u) {
        return u.id && u.id.toString() !== _userId;
      }));
      return;
    }

    // Try backend search
    try {
      var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.USERS_SEARCH + '?q=' + encodeURIComponent(query);
      var result = await authenticatedRequest(url, { method: 'GET' });
      var users = Array.isArray(result.data) ? result.data : (result.data && result.data.content ? result.data.content : []);
      _renderUserResults(users.filter(function (u) {
        return (u.id || u.userId) && (u.id || u.userId).toString() !== _userId;
      }));
    } catch (e) {
      // Fallback: filter online users
      var filtered = _onlineUsers.filter(function (u) {
        return u.username && u.username.toLowerCase().indexOf(query.toLowerCase()) !== -1 &&
               u.id && u.id.toString() !== _userId;
      });
      _renderUserResults(filtered);
    }
  }

  function _renderUserResults(users) {
    var resultsContainer = document.getElementById('chatSearchResults');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = '';
    if (!users || users.length === 0) {
      resultsContainer.innerHTML = '<div class="chat-empty-state">No users found</div>';
      return;
    }

    users.forEach(function (user) {
      var uid = user.id || user.userId;
      var uname = user.username || 'Unknown';
      var initial = uname.charAt(0).toUpperCase();
      var isSelected = _selectedGroupMembers.some(function (m) { return (m.id || m.userId) === uid; });

      var item = document.createElement('div');
      item.className = 'chat-user-result';
      item.innerHTML =
        '<div class="conv-list-avatar">' + initial + '</div>' +
        '<span style="color:var(--text-light);font-size:0.85rem;">' + _escapeHtml(uname) + '</span>' +
        (isSelected ? '<span style="color:var(--gold);margin-left:auto;font-size:0.75rem;">Added</span>' : '');

      item.addEventListener('click', function () {
        _toggleGroupMember(uid, uname);
      });
      resultsContainer.appendChild(item);
    });
  }

  function _toggleGroupMember(userId, username) {
    var idx = _selectedGroupMembers.findIndex(function (m) { return m.id === userId; });
    if (idx >= 0) {
      _selectedGroupMembers.splice(idx, 1);
    } else {
      _selectedGroupMembers.push({ id: userId, username: username });
    }
    _renderMemberChips();
    _updateCreateGroupBtn();

    // Re-render search results to update "Added" status
    var searchInput = document.getElementById('chatUserSearch');
    var q = searchInput ? searchInput.value.trim() : '';
    if (q) {
      _searchUsers(q);
    } else {
      _renderUserResults(_onlineUsers.filter(function (u) {
        return u.id && u.id.toString() !== _userId;
      }));
    }
  }

  function _renderMemberChips() {
    var container = document.getElementById('memberChips');
    if (!container) return;

    container.innerHTML = '';
    _selectedGroupMembers.forEach(function (member) {
      var chip = document.createElement('div');
      chip.className = 'member-chip';
      chip.innerHTML =
        _escapeHtml(member.username) +
        '<span class="member-chip-remove">&times;</span>';
      chip.querySelector('.member-chip-remove').addEventListener('click', function () {
        _toggleGroupMember(member.id, member.username);
      });
      container.appendChild(chip);
    });
  }

  function _updateCreateGroupBtn() {
    var btn = document.getElementById('createGroupBtn');
    var nameInput = document.getElementById('chatGroupName');
    if (!btn) return;
    var name = nameInput ? nameInput.value.trim() : '';
    btn.disabled = !name || _selectedGroupMembers.length === 0;

    // Also listen for name input changes
    if (nameInput && !nameInput._listening) {
      nameInput._listening = true;
      nameInput.addEventListener('input', function () {
        _updateCreateGroupBtn();
      });
    }
  }

  async function _createGroupConversation(name, memberIds) {
    var created = await _createConversation('GROUP', name, memberIds);
    if (created) {
      var conv = {
        id: created.id,
        type: 'GROUP',
        name: created.name || name,
        participants: created.participants || [],
        lastMessage: null,
        lastMessageTime: null,
        unreadCount: 0
      };
      _groupConversations.unshift(conv);
      _openConversation(created.id, 'groups');
    }
  }

  // ====== PRIVATE (DM) ======

  async function _searchUsersForDM(query) {
    var resultsContainer = document.getElementById('chatSearchResults');
    if (!resultsContainer) return;

    if (!query || query.length < 1) {
      _renderDMUserResults(_onlineUsers.filter(function (u) {
        return u.id && u.id.toString() !== _userId;
      }));
      return;
    }

    try {
      var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.USERS_SEARCH + '?q=' + encodeURIComponent(query);
      var result = await authenticatedRequest(url, { method: 'GET' });
      var users = Array.isArray(result.data) ? result.data : (result.data && result.data.content ? result.data.content : []);
      _renderDMUserResults(users.filter(function (u) {
        return (u.id || u.userId) && (u.id || u.userId).toString() !== _userId;
      }));
    } catch (e) {
      var filtered = _onlineUsers.filter(function (u) {
        return u.username && u.username.toLowerCase().indexOf(query.toLowerCase()) !== -1 &&
               u.id && u.id.toString() !== _userId;
      });
      _renderDMUserResults(filtered);
    }
  }

  function _renderDMUserResults(users) {
    var resultsContainer = document.getElementById('chatSearchResults');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = '';
    if (!users || users.length === 0) {
      resultsContainer.innerHTML = '<div class="chat-empty-state">No users found</div>';
      return;
    }

    users.forEach(function (user) {
      var uid = user.id || user.userId;
      var uname = user.username || 'Unknown';
      var initial = uname.charAt(0).toUpperCase();

      var item = document.createElement('div');
      item.className = 'chat-user-result';
      item.innerHTML =
        '<div class="conv-list-avatar">' + initial + '</div>' +
        '<span style="color:var(--text-light);font-size:0.85rem;">' + _escapeHtml(uname) + '</span>';

      item.addEventListener('click', function () {
        _openOrCreateDM(uid, uname);
      });
      resultsContainer.appendChild(item);
    });
  }

  function _findExistingDM(userId) {
    return _privateConversations.find(function (c) {
      return c.participants && c.participants.some(function (p) {
        var pid = p.userId || p.id;
        return pid && pid.toString() === userId.toString();
      });
    }) || null;
  }

  async function _openOrCreateDM(userId, username) {
    var existing = _findExistingDM(userId);
    if (existing) {
      _openConversation(existing.id, 'private');
      return;
    }
    await _createPrivateConversation(userId, username);
  }

  async function _createPrivateConversation(userId, username) {
    var created = await _createConversation('PRIVATE', null, [userId]);
    if (created) {
      var conv = {
        id: created.id,
        type: 'PRIVATE',
        name: created.name || username,
        participants: created.participants || [{ userId: userId, username: username }],
        lastMessage: null,
        lastMessageTime: null,
        unreadCount: 0
      };
      _privateConversations.unshift(conv);
      _openConversation(created.id, 'private');
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
      _removeOptimisticMessage(msg);
      return;
    }

    var convId = msg.conversationId;

    if (convId === _tavernConvId) {
      // Tavern message
      _addMessage(convId, msg);
      if (_currentTab === 'tavern') {
        _renderSingleMessage(msg);
        _scrollToBottom();
      }
    } else {
      // Group message
      _addMessage(convId, msg);

      var tab = _getTabForConversation(convId);
      if (!tab) {
        // Unknown conversation — fetch and add
        _fetchSingleConversation(convId);
        return;
      }

      // Update conversation preview
      _updateConversationPreview(convId, msg);

      // If this conversation is currently open, render the message
      if (_currentTab === tab && _activeConv[tab] === convId && _viewMode[tab] === 'messages') {
        _renderSingleMessage(msg);
        _scrollToBottom();
      }

      // If viewing the list for this tab, re-render the list
      if (_currentTab === tab && _viewMode[tab] === 'list') {
        _renderConversationList(tab);
      }
    }

    // Notification if chat is closed or different tab/conv
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
    // Poll Tavern
    if (_tavernConvId) {
      _fetchMessages(_tavernConvId, 0).then(function (msgs) {
        if (!msgs) return;
        var newMsgs = false;
        msgs.forEach(function (m) {
          if (!_messageIds.has(m.id)) {
            _addMessage(_tavernConvId, m);
            newMsgs = true;
          }
        });
        if (newMsgs && _currentTab === 'tavern') {
          _renderTavernMessages();
          _scrollToBottom();
        }
      });
    }

    // Poll active Groups or Private conversation
    var activeTab = _currentTab;
    if ((activeTab === 'groups' || activeTab === 'private') && _viewMode[activeTab] === 'messages') {
      var convId = _activeConv[activeTab];
      if (convId) {
        _fetchMessages(convId, 0).then(function (msgs) {
          if (!msgs) return;
          var newMsgs = false;
          msgs.forEach(function (m) {
            if (!_messageIds.has(m.id)) {
              _addMessage(convId, m);
              newMsgs = true;
            }
          });
          if (newMsgs && _activeConv[_currentTab] === convId) {
            _renderConvMessages(convId);
            _scrollToBottom();
          }
        });
      }
    }
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

  async function _fetchSingleConversation(convId) {
    // Re-fetch all conversations to find the new one
    var convs = await _fetchConversations();
    var found = convs.find(function (c) { return c.id === convId; });
    if (!found) return;

    if (found.type === 'PRIVATE') {
      if (!_privateConversations.find(function (c) { return c.id === found.id; })) {
        _privateConversations.unshift(_normalizeConversation(found));
      }
    } else if (found.type === 'GROUP' && found.name !== 'Tavern') {
      if (!_groupConversations.find(function (c) { return c.id === found.id; })) {
        _groupConversations.unshift(_normalizeConversation(found));
      }
    }
  }

  // ====== CONVERSATION RESOLUTION ======

  async function _resolveConversations() {
    var convs = await _fetchConversations();

    // If fetch returned empty and no Tavern was previously resolved, backend is down
    if (convs.length === 0 && !_tavernConvId) {
      _backendAvailable = false;
      _renderConnectionError();
      return;
    }

    _backendAvailable = true;
    _clearChatError();

    // Ensure convs is an array
    if (!Array.isArray(convs)) convs = [];

    // Find Tavern group conversation
    var tavern = convs.find(function (c) {
      return c.type === 'GROUP' && c.name === 'Tavern';
    });
    if (tavern) {
      _tavernConvId = tavern.id;
    } else {
      // Try to create Tavern
      var created = await _createConversation('GROUP', 'Tavern', []);
      if (created) _tavernConvId = created.id;
    }

    // Collect group and private conversations (excluding Tavern)
    _groupConversations = [];
    _privateConversations = [];

    convs.forEach(function (c) {
      if (c.type === 'PRIVATE') {
        _privateConversations.push(_normalizeConversation(c));
      } else if (c.type === 'GROUP' && c.name !== 'Tavern') {
        _groupConversations.push(_normalizeConversation(c));
      }
    });

    // Load initial messages for current tab
    if (_currentTab === 'tavern' && _tavernConvId) {
      var msgs = await _fetchMessages(_tavernConvId, 0);
      if (msgs && msgs.length > 0) {
        msgs.forEach(function (m) { _addMessage(_tavernConvId, m); });
        _renderTavernMessages();
        _scrollToBottom();
      }
    } else if (_currentTab === 'groups' || _currentTab === 'private') {
      _showListView(_currentTab);
    }
  }

  function _normalizeConversation(conv) {
    return {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      participants: conv.participants || [],
      lastMessage: conv.lastMessage || (conv.lastMessageContent || null),
      lastMessageTime: conv.lastMessageTime || (conv.lastMessageCreatedAt || conv.updatedAt || null),
      unreadCount: conv.unreadCount || 0
    };
  }

  // ====== MESSAGE MANAGEMENT ======

  function _addMessage(convId, msg) {
    if (msg.id && _messageIds.has(msg.id)) return;
    if (msg.id) _messageIds.add(msg.id);

    if (convId === _tavernConvId) {
      _tavernMessages.push(msg);
    } else {
      if (!_messagesByConv[convId]) _messagesByConv[convId] = [];
      _messagesByConv[convId].push(msg);
    }
  }

  function _removeOptimisticMessage(confirmedMsg) {
    var convId = confirmedMsg.conversationId;

    if (convId === _tavernConvId) {
      _tavernMessages = _tavernMessages.filter(function (m) {
        if (m._optimistic && m.senderUsername === confirmedMsg.senderUsername && m.content === confirmedMsg.content) {
          return false;
        }
        return true;
      });
    } else if (_messagesByConv[convId]) {
      _messagesByConv[convId] = _messagesByConv[convId].filter(function (m) {
        if (m._optimistic && m.senderUsername === confirmedMsg.senderUsername && m.content === confirmedMsg.content) {
          return false;
        }
        return true;
      });
    }

    // Add the confirmed message
    _addMessage(convId, confirmedMsg);
    var tab = _getTabForConversation(convId);
    if (tab === 'tavern' && _currentTab === 'tavern') {
      _renderTavernMessages();
      _scrollToBottom();
    } else if (tab && _currentTab === tab && _activeConv[tab] === convId) {
      _renderConvMessages(convId);
      _scrollToBottom();
    }
  }

  function _getTabForConversation(convId) {
    if (_tavernConvId === convId) return 'tavern';
    if (_groupConversations.find(function (c) { return c.id === convId; })) return 'groups';
    if (_privateConversations.find(function (c) { return c.id === convId; })) return 'private';
    return null;
  }

  function _findConversation(convId) {
    return _groupConversations.find(function (c) { return c.id === convId; }) ||
           _privateConversations.find(function (c) { return c.id === convId; }) ||
           null;
  }

  function _updateConversationPreview(convId, msg) {
    var conv = _findConversation(convId);
    if (!conv) return;
    conv.lastMessage = msg.content;
    conv.lastMessageTime = msg.createdAt;
    if (_activeConv[_currentTab] !== convId) {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
  }

  // ====== UI RENDERING ======

  function _renderTavernMessages() {
    var container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    _tavernMessages.forEach(function (msg) {
      container.appendChild(_createMessageElement(msg));
    });
  }

  function _renderConvMessages(convId) {
    var container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    var msgs = _messagesByConv[convId] || [];
    msgs.forEach(function (msg) {
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

    container.innerHTML =
      '<div style="text-align:center;padding:2rem 1rem;font-size:0.9rem;">' +
        '<div style="width:48px;height:48px;margin:0 auto 1rem;border-radius:50%;background:rgba(239,68,68,0.15);display:flex;align-items:center;justify-content:center;">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        '</div>' +
        '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">Tavern Unreachable</p>' +
        '<p style="color:var(--text-muted);margin-bottom:1rem;">The chat server is not responding. Check that the service is running.</p>' +
        '<button onclick="TavernChat._retry()" style="padding:0.6rem 1.5rem;background:linear-gradient(135deg,var(--primary),#5a1414);border:1px solid var(--gold);border-radius:10px;color:var(--gold);font-family:Cinzel,serif;font-size:0.85rem;cursor:pointer;transition:all 0.3s ease;">Retry</button>' +
      '</div>';
  }

  function _showChatError(message) {
    _clearChatError();
    var container = document.getElementById('chatMessages');
    if (!container) return;

    var toast = document.createElement('div');
    toast.id = 'chatErrorToast';
    toast.style.cssText = 'padding:0.6rem 1rem;margin:0.25rem 0;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:10px;font-size:0.8rem;color:#fca5a5;text-align:center;animation:messageSlide 0.3s ease;';
    toast.textContent = message;
    container.appendChild(toast);
    _scrollToBottom();

    setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 4000);
  }

  function _clearChatError() {
    var toast = document.getElementById('chatErrorToast');
    if (toast) toast.remove();
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
    if (_currentTab === 'tavern') {
      if (!_tavernConvId || !_tavernHasMore) return;

      _loadingMore = true;
      _tavernPage++;

      var msgs = await _fetchMessages(_tavernConvId, _tavernPage);
      _loadingMore = false;

      if (!msgs || msgs.length === 0) {
        _tavernHasMore = false;
        return;
      }
      if (msgs.length < PAGE_SIZE) _tavernHasMore = false;

      var container = document.getElementById('chatMessages');
      var prevScrollHeight = container ? container.scrollHeight : 0;

      msgs.forEach(function (m) {
        if (!_messageIds.has(m.id)) {
          _addMessage(_tavernConvId, m);
        }
      });

      _tavernMessages.sort(function (a, b) {
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      _renderTavernMessages();

      if (container) {
        container.scrollTop = container.scrollHeight - prevScrollHeight;
      }
    } else {
      // Groups
      var convId = _activeConv[_currentTab];
      if (!convId) return;
      if (!_hasMoreByConv.hasOwnProperty(convId)) _hasMoreByConv[convId] = true;
      if (!_hasMoreByConv[convId]) return;

      _loadingMore = true;
      if (!_pagesByConv[convId]) _pagesByConv[convId] = 0;
      _pagesByConv[convId]++;

      var msgs = await _fetchMessages(convId, _pagesByConv[convId]);
      _loadingMore = false;

      if (!msgs || msgs.length === 0) {
        _hasMoreByConv[convId] = false;
        return;
      }
      if (msgs.length < PAGE_SIZE) _hasMoreByConv[convId] = false;

      var container = document.getElementById('chatMessages');
      var prevScrollHeight = container ? container.scrollHeight : 0;

      msgs.forEach(function (m) {
        if (!_messageIds.has(m.id)) {
          _addMessage(convId, m);
        }
      });

      if (_messagesByConv[convId]) {
        _messagesByConv[convId].sort(function (a, b) {
          return new Date(a.createdAt) - new Date(b.createdAt);
        });
      }

      _renderConvMessages(convId);

      if (container) {
        container.scrollTop = container.scrollHeight - prevScrollHeight;
      }
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

  function _formatSmartTime(isoString) {
    if (!isoString) return '';
    try {
      var d = new Date(isoString);
      var now = new Date();
      var diffMs = now - d;
      var diffDays = Math.floor(diffMs / 86400000);

      if (diffDays === 0) {
        // Today — show HH:MM
        return d.getHours().toString().padStart(2, '0') + ':' +
               d.getMinutes().toString().padStart(2, '0');
      } else if (diffDays === 1) {
        return 'Yesterday';
      } else if (diffDays < 7) {
        var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return days[d.getDay()];
      } else {
        return d.getDate().toString().padStart(2, '0') + '/' +
               (d.getMonth() + 1).toString().padStart(2, '0') + '/' +
               (d.getFullYear() % 100).toString().padStart(2, '0');
      }
    } catch (e) {
      return '';
    }
  }

  function _getConvDisplayName(conv) {
    if (!conv) return 'Chat';
    if (conv.type === 'PRIVATE') {
      // Show the other participant's username
      if (conv.participants && conv.participants.length > 0) {
        var other = conv.participants.find(function (p) {
          var pid = (p.userId || p.id || '').toString();
          return pid !== _userId;
        });
        if (other) return other.username || 'Unknown';
      }
      return conv.name || 'Private';
    }
    return conv.name || 'Group';
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
      if (_currentTab === 'tavern') {
        _renderTavernMessages();
      }
      _resolveConversations();
      _connectWebSocket();
    }
  };
})();
