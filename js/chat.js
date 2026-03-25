// ====== CHAT MODULE ======
// WebSocket + REST integration with chat-service
// Unified conversation list: DMs + Groups
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

  let _conversations = [];              // Unified: [{id, type, name, participants, lastMessage, lastMessageTime, unreadCount}]
  let _messagesByConv = {};             // convId -> [msgs]
  let _pagesByConv = {};                // convId -> pageNum
  let _hasMoreByConv = {};              // convId -> bool
  let _messageIds = new Set();
  let _onlineUsers = [];
  let _knownUsers = {};                 // userId -> {id, username}
  let _unreadCount = 0;
  let _chatOpen = false;
  let _backendAvailable = false;
  let _username = '';
  let _userId = null;

  let _activeConvId = null;             // Currently open conversation
  let _viewMode = 'list';              // 'list' | 'messages' | 'new_dm' | 'new_group'
  let _loadingMore = false;
  let _selectedGroupMembers = [];
  let _searchDebounce = null;
  let _onlineUsersTimer = null;

  // Archive (client-side, persisted to localStorage)
  let _archivedConvIds = new Set();
  let _showArchived = false;

  const MAX_RECONNECT_DELAY = 30000;
  const HEARTBEAT_INTERVAL = 30000;
  const POLLING_INTERVAL = 10000;
  const WS_CONNECT_TIMEOUT = 5000;
  const ONLINE_USERS_INTERVAL = 30000;
  const PAGE_SIZE = 30;

  // ====== PUBLIC API ======

  function init() {
    _username = localStorage.getItem('username') || 'Adventurer';
    _userId = localStorage.getItem('userId');
    _loadArchivedIds();

    _setupCloseButton();
    _setupScrollListener();
    _injectDynamicUI();
    _connectWebSocket();

    _wsConnectTimeout = setTimeout(function () {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        _startPolling();
      }
    }, WS_CONNECT_TIMEOUT);

    window.addEventListener('beforeunload', destroy);
    _resolveConversations();
    _startOnlineUsersPolling();
  }

  function destroy() {
    if (_ws) {
      _ws.onclose = null;
      _ws.close();
      _ws = null;
    }
    clearTimeout(_reconnectTimer);
    clearInterval(_heartbeatTimer);
    clearInterval(_pollingTimer);
    clearTimeout(_wsConnectTimeout);
    clearTimeout(_searchDebounce);
    _stopOnlineUsersPolling();
    _dismissDropdowns();
    window.removeEventListener('beforeunload', destroy);
  }

  function toggleChat() {
    var chatWindow = document.getElementById('chatWindow');
    var chatToggleBtn = document.getElementById('chatToggleBtn');
    if (!chatWindow || !chatToggleBtn) return;

    _chatOpen = !_chatOpen;
    chatWindow.classList.toggle('active', _chatOpen);
    chatToggleBtn.style.display = _chatOpen ? 'none' : '';

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
      _showChatError('Cannot send messages — the chat server is unreachable. Retrying...');
      if (!_backendAvailable) _resolveConversations();
      return;
    }

    input.value = '';

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

  // ====== CLOSE BUTTON ======

  function _setupCloseButton() {
    var header = document.querySelector('.chat-header');
    if (!header) return;

    var closeBtn = document.createElement('button');
    closeBtn.className = 'chat-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close chat';
    closeBtn.addEventListener('click', function () {
      toggleChat();
    });
    header.appendChild(closeBtn);
  }

  // ====== DYNAMIC UI INJECTION ======

  function _injectDynamicUI() {
    var header = document.querySelector('.chat-header');
    if (!header) return;

    // Create sub-header bar (inserted after .chat-header)
    var subHeader = document.createElement('div');
    subHeader.className = 'chat-sub-header active';
    subHeader.innerHTML =
      '<button class="chat-back-btn" title="Back" style="display:none">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>' +
      '<span class="chat-sub-title">Conversations</span>' +
      '<button class="chat-new-btn" title="New" style="position:relative">+</button>';

    header.insertAdjacentElement('afterend', subHeader);

    // Back button → go to list
    subHeader.querySelector('.chat-back-btn').addEventListener('click', function () {
      _showListView();
    });

    // "+" button → show dropdown
    subHeader.querySelector('.chat-new-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      _showNewConversationDropdown(this);
    });

    // Dismiss dropdowns on outside click
    document.addEventListener('click', _dismissDropdowns);
  }

  // ====== VIEW MANAGEMENT ======

  function _getActiveConvId() {
    return _activeConvId;
  }

  function _showListView() {
    _viewMode = 'list';
    _activeConvId = null;

    var subHeader = document.querySelector('.chat-sub-header');
    var chatWindow = document.getElementById('chatWindow');

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = 'Conversations';
      subHeader.querySelector('.chat-back-btn').style.display = 'none';
      subHeader.querySelector('.chat-new-btn').style.display = 'flex';
    }

    if (chatWindow) chatWindow.classList.add('hide-input');

    _renderConversationList();
  }

  function _showNewGroupView() {
    _viewMode = 'new_group';
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

    _renderUserResults(_getSearchableUsers());
  }

  function _showNewDMView() {
    _viewMode = 'new_dm';

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

    _renderDMUserResults(_getSearchableUsers());
  }

  function _renderConversationList() {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    // Separate active and archived
    var active = [];
    var archived = [];
    _conversations.forEach(function (conv) {
      if (_archivedConvIds.has(conv.id)) {
        archived.push(conv);
      } else {
        active.push(conv);
      }
    });

    // Sort by lastMessageTime descending
    var sortFn = function (a, b) {
      var ta = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      var tb = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return tb - ta;
    };
    active.sort(sortFn);
    archived.sort(sortFn);

    if (active.length === 0 && archived.length === 0) {
      container.innerHTML =
        '<div class="chat-empty-state">' +
          '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">No conversations yet</p>' +
          '<p>Tap + to start a conversation</p>' +
        '</div>';
      return;
    }

    container.innerHTML = '';

    // Render active conversations
    active.forEach(function (conv) {
      container.appendChild(_createConvListItem(conv));
    });

    // Render archived toggle if any
    if (archived.length > 0) {
      var toggle = document.createElement('div');
      toggle.className = 'conv-archive-toggle';
      toggle.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>' +
        '<span>Archived</span>' +
        '<span class="conv-archive-count">' + archived.length + '</span>' +
        '<svg style="margin-left:0.25rem;width:12px;height:12px;transform:rotate(' + (_showArchived ? '180' : '0') + 'deg);transition:transform 0.2s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

      toggle.addEventListener('click', function () {
        _showArchived = !_showArchived;
        _renderConversationList();
      });
      container.appendChild(toggle);

      if (_showArchived) {
        archived.forEach(function (conv) {
          var item = _createConvListItem(conv);
          item.style.opacity = '0.7';
          container.appendChild(item);
        });
      }
    }
  }

  function _createConvListItem(conv) {
    var displayName = _getConvDisplayName(conv);
    var initial = displayName.charAt(0).toUpperCase();
    var preview = conv.lastMessage ? _escapeHtml(conv.lastMessage) : '';
    var time = conv.lastMessageTime ? _formatSmartTime(conv.lastMessageTime) : '';
    var unread = conv.unreadCount || 0;
    var isGroup = conv.type === 'GROUP';
    var isArchived = _archivedConvIds.has(conv.id);

    var item = document.createElement('div');
    item.className = 'conv-list-item';
    item.style.position = 'relative';
    item.innerHTML =
      '<div class="conv-list-avatar" style="position:relative">' + initial +
        '<span class="conv-list-type-icon">' +
          (isGroup
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>') +
        '</span>' +
      '</div>' +
      '<div class="conv-list-details">' +
        '<div class="conv-list-name">' + _escapeHtml(displayName) + '</div>' +
        '<div class="conv-list-preview">' + preview + '</div>' +
      '</div>' +
      '<div class="conv-list-meta">' +
        '<div class="conv-list-time">' + time + '</div>' +
        (unread > 0 ? '<div class="conv-list-unread">' + (unread > 9 ? '9+' : unread) + '</div>' : '') +
        '<button class="conv-context-btn" title="More">&middot;&middot;&middot;</button>' +
      '</div>';

    // Open conversation on click
    item.addEventListener('click', function () {
      _openConversation(conv.id);
    });

    // Context menu on "..." click
    item.querySelector('.conv-context-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      _showContextMenu(conv.id, isArchived, item);
    });

    return item;
  }

  function _openConversation(convId) {
    _viewMode = 'messages';
    _activeConvId = convId;

    var chatWindow = document.getElementById('chatWindow');
    var subHeader = document.querySelector('.chat-sub-header');

    var conv = _findConversation(convId);
    var displayName = conv ? _getConvDisplayName(conv) : 'Chat';

    if (subHeader) {
      subHeader.classList.add('active');
      subHeader.querySelector('.chat-sub-title').textContent = displayName;
      subHeader.querySelector('.chat-back-btn').style.display = 'flex';
      subHeader.querySelector('.chat-new-btn').style.display = 'none';
    }

    if (chatWindow) chatWindow.classList.remove('hide-input');

    var msgs = _messagesByConv[convId];
    if (msgs && msgs.length > 0) {
      _renderConvMessages(convId);
      _scrollToBottom();
    } else {
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
    if (conv) conv.unreadCount = 0;
  }

  // ====== NEW CONVERSATION DROPDOWN ======

  function _showNewConversationDropdown(anchor) {
    _dismissDropdowns();

    var dropdown = document.createElement('div');
    dropdown.className = 'chat-new-dropdown';
    dropdown.innerHTML =
      '<div class="chat-new-dropdown-item" data-action="dm">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
        'New Message' +
      '</div>' +
      '<div class="chat-new-dropdown-item" data-action="group">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
        'New Group' +
      '</div>';

    dropdown.querySelector('[data-action="dm"]').addEventListener('click', function (e) {
      e.stopPropagation();
      _dismissDropdowns();
      _showNewDMView();
    });
    dropdown.querySelector('[data-action="group"]').addEventListener('click', function (e) {
      e.stopPropagation();
      _dismissDropdowns();
      _showNewGroupView();
    });

    anchor.appendChild(dropdown);
  }

  // ====== CONTEXT MENU (delete/archive) ======

  function _showContextMenu(convId, isArchived, anchorItem) {
    _dismissDropdowns();

    var menu = document.createElement('div');
    menu.className = 'conv-context-menu';
    menu.innerHTML =
      '<div class="conv-context-menu-item" data-action="archive">' +
        (isArchived
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>Unarchive'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>Archive') +
      '</div>' +
      '<div class="conv-context-menu-item danger" data-action="delete">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        'Delete' +
      '</div>';

    menu.querySelector('[data-action="archive"]').addEventListener('click', function (e) {
      e.stopPropagation();
      _dismissDropdowns();
      if (isArchived) {
        _unarchiveConversation(convId);
      } else {
        _archiveConversation(convId);
      }
    });

    menu.querySelector('[data-action="delete"]').addEventListener('click', function (e) {
      e.stopPropagation();
      _dismissDropdowns();
      _showConfirmDelete(convId);
    });

    anchorItem.appendChild(menu);
  }

  function _showConfirmDelete(convId) {
    var chatWindow = document.getElementById('chatWindow');
    if (!chatWindow) return;

    var overlay = document.createElement('div');
    overlay.className = 'chat-confirm-overlay';
    overlay.innerHTML =
      '<div class="chat-confirm-dialog">' +
        '<p>Delete this conversation? This cannot be undone.</p>' +
        '<div class="chat-confirm-actions">' +
          '<button class="chat-confirm-cancel">Cancel</button>' +
          '<button class="chat-confirm-delete">Delete</button>' +
        '</div>' +
      '</div>';

    overlay.querySelector('.chat-confirm-cancel').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.querySelector('.chat-confirm-delete').addEventListener('click', function () {
      overlay.remove();
      _deleteConversation(convId);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    chatWindow.appendChild(overlay);
  }

  function _dismissDropdowns() {
    document.querySelectorAll('.chat-new-dropdown, .conv-context-menu').forEach(function (el) {
      el.remove();
    });
  }

  // ====== DELETE / ARCHIVE ======

  async function _deleteConversation(convId) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.CONVERSATION.replace('{id}', convId) +
      '?userId=' + _userId;
    try {
      await authenticatedRequest(url, { method: 'DELETE' });
    } catch (e) {
      console.error('[Chat] Failed to delete conversation:', e);
    }
    // Remove from local state regardless (optimistic)
    _conversations = _conversations.filter(function (c) { return c.id !== convId; });
    delete _messagesByConv[convId];
    delete _pagesByConv[convId];
    delete _hasMoreByConv[convId];
    _archivedConvIds.delete(convId);
    _saveArchivedIds();

    if (_activeConvId === convId) {
      _showListView();
    } else if (_viewMode === 'list') {
      _renderConversationList();
    }
  }

  function _archiveConversation(convId) {
    _archivedConvIds.add(convId);
    _saveArchivedIds();
    if (_activeConvId === convId) {
      _showListView();
    } else if (_viewMode === 'list') {
      _renderConversationList();
    }
  }

  function _unarchiveConversation(convId) {
    _archivedConvIds.delete(convId);
    _saveArchivedIds();
    if (_viewMode === 'list') {
      _renderConversationList();
    }
  }

  function _loadArchivedIds() {
    try {
      var stored = JSON.parse(localStorage.getItem('chat_archived_convs') || '[]');
      _archivedConvIds = new Set(stored);
    } catch (e) {
      _archivedConvIds = new Set();
    }
  }

  function _saveArchivedIds() {
    localStorage.setItem('chat_archived_convs', JSON.stringify([..._archivedConvIds]));
  }

  // ====== SEARCH & GROUP CREATION ======

  function _searchUsers(query) {
    var users = _getSearchableUsers();
    if (query && query.length >= 1) {
      users = users.filter(function (u) {
        return u.username && u.username.toLowerCase().indexOf(query.toLowerCase()) !== -1;
      });
    }
    _renderUserResults(users);
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

    var searchInput = document.getElementById('chatUserSearch');
    var q = searchInput ? searchInput.value.trim() : '';
    if (q) {
      _searchUsers(q);
    } else {
      _renderUserResults(_getSearchableUsers());
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
      _conversations.unshift(conv);
      _openConversation(created.id);
    }
  }

  // ====== PRIVATE (DM) ======

  function _searchUsersForDM(query) {
    var users = _getSearchableUsers();
    if (query && query.length >= 1) {
      users = users.filter(function (u) {
        return u.username && u.username.toLowerCase().indexOf(query.toLowerCase()) !== -1;
      });
    }
    _renderDMUserResults(users);
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
    return _conversations.find(function (c) {
      return c.type === 'DIRECT' && c.participants && c.participants.some(function (p) {
        var pid = p.userId || p.id;
        return pid && pid.toString() === userId.toString();
      });
    }) || null;
  }

  async function _openOrCreateDM(userId, username) {
    var existing = _findExistingDM(userId);
    if (existing) {
      _openConversation(existing.id);
      return;
    }
    await _createPrivateConversation(userId, username);
  }

  async function _createPrivateConversation(userId, username) {
    var created = await _createConversation('DIRECT', null, [userId]);
    if (created) {
      var participants = created.participants || [{ userId: userId }];
      participants.forEach(function (p) {
        var pid = (p.userId || p.id || '').toString();
        if (pid === userId.toString() && !p.username) {
          p.username = username;
        }
      });
      var conv = {
        id: created.id,
        type: 'DIRECT',
        name: created.name || username,
        participants: participants,
        lastMessage: null,
        lastMessageTime: null,
        unreadCount: 0
      };
      _conversations.unshift(conv);
      _openConversation(created.id);
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
        console.error('[Chat] Token refresh failed:', e);
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
      console.error('[Chat] WebSocket creation failed:', e);
      _updateConnectionIndicator('disconnected');
      _scheduleReconnect();
      return;
    }

    _ws.onopen = function () {
      console.log('[Chat] WebSocket connected');
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
        console.warn('[Chat] Failed to parse WS message:', e);
      }
    };

    _ws.onclose = function (event) {
      console.log('[Chat] WebSocket closed:', event.code, event.reason);
      _updateConnectionIndicator('disconnected');
      _stopHeartbeat();
      _scheduleReconnect();
      if (_wsConnectedOnce) _startPolling();
    };

    _ws.onerror = function (event) {
      console.error('[Chat] WebSocket error:', event);
    };
  }

  function _handleWsMessage(data) {
    switch (data.type) {
      case 'NEW_MESSAGE':
        _onNewMessage(data);
        break;
      case 'CONNECTED':
        console.log('[Chat] WebSocket confirmed:', data.content);
        break;
      case 'ERROR':
        console.error('[Chat] Server error:', data.content || data);
        break;
      case 'PONG':
        break;
      default:
        console.log('[Chat] Unknown WS message type:', data.type, data);
    }
  }

  function _onNewMessage(data) {
    var msg = data.message || data;
    if (msg.messageId && !msg.id) msg.id = msg.messageId;
    if (msg.timestamp && !msg.createdAt) msg.createdAt = msg.timestamp;

    if (msg.id && _messageIds.has(msg.id)) {
      _removeOptimisticMessage(msg);
      return;
    }

    var convId = msg.conversationId;
    _addMessage(convId, msg);

    var conv = _findConversation(convId);
    if (!conv) {
      // Unknown conversation — fetch and add
      _fetchSingleConversation(convId);
    } else {
      _updateConversationPreview(convId, msg);
    }

    // If this conversation is currently open, render the message
    if (_activeConvId === convId && _viewMode === 'messages') {
      _renderSingleMessage(msg);
      _scrollToBottom();
    }

    // If viewing the list, re-render
    if (_viewMode === 'list') {
      _renderConversationList();
    }

    // Notification if chat is closed
    if (!_chatOpen) {
      _unreadCount++;
      _updateNotificationBadge();
    }
  }

  // ====== USERNAME RESOLUTION ======

  async function _fetchUsername(userId) {
    if (!userId) return null;
    var url = 'http://' + ENV.API_HOST + ':' + ENV.REGISTER_PORT + '/users/' + userId;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      if (result.data && result.data.username) {
        return result.data.username;
      }
      return null;
    } catch (e) {
      console.warn('[Chat] Failed to fetch username for userId:', userId, e);
      return null;
    }
  }

  async function _buildKnownUsersFromConversations(convs) {
    if (!Array.isArray(convs)) return;

    var userIds = {};
    convs.forEach(function (c) {
      if (!c.participants) return;
      c.participants.forEach(function (p) {
        var uid = (p.userId || p.id || '').toString();
        if (uid && uid !== _userId && !_knownUsers[uid]) {
          userIds[uid] = true;
        }
      });
    });

    var ids = Object.keys(userIds);
    var fetchPromises = ids.map(function (uid) {
      return _fetchUsername(uid).then(function (uname) {
        if (uname) {
          _knownUsers[uid] = { id: parseInt(uid, 10), username: uname };
        }
      });
    });

    await Promise.all(fetchPromises);

    _enrichParticipants(_conversations);
  }

  function _enrichParticipants(convList) {
    if (!Array.isArray(convList)) return;
    convList.forEach(function (conv) {
      if (!conv.participants) return;
      conv.participants.forEach(function (p) {
        if (p.username) return;
        var uid = (p.userId || p.id || '').toString();
        if (uid && _knownUsers[uid] && _knownUsers[uid].username) {
          p.username = _knownUsers[uid].username;
        }
      });
    });
  }

  async function _resolveUnknownConversationNames() {
    var toResolve = _conversations.filter(function (conv) {
      return conv.type === 'DIRECT' && _getConvDisplayName(conv) === 'Direct Message';
    });
    if (toResolve.length === 0) return;

    await Promise.all(toResolve.map(async function (conv) {
      var url = API_CONFIG.CHAT.BASE_URL +
        API_CONFIG.CHAT.CONVERSATION.replace('{id}', conv.id) +
        '?userId=' + _userId;
      try {
        var result = await authenticatedRequest(url, { method: 'GET' });
        var full = result.data;
        if (full && full.participants && full.participants.length > 0) {
          conv.participants = full.participants;
          var unknownIds = [];
          conv.participants.forEach(function (p) {
            var uid = (p.userId || p.id || '').toString();
            if (uid && uid !== _userId && !p.username) {
              if (_knownUsers[uid]) {
                p.username = _knownUsers[uid].username;
              } else {
                unknownIds.push({ uid: uid, participant: p });
              }
            }
          });
          await Promise.all(unknownIds.map(function (item) {
            return _fetchUsername(item.uid).then(function (uname) {
              if (uname) {
                _knownUsers[item.uid] = { id: parseInt(item.uid, 10), username: uname };
                item.participant.username = uname;
              }
            });
          }));
        }
      } catch (e) {
        console.warn('[Chat] Failed to resolve conv name:', conv.id, e);
      }
    }));
  }

  function _getSearchableUsers() {
    var usersMap = {};
    Object.keys(_knownUsers).forEach(function (uid) {
      if (uid !== _userId) {
        usersMap[uid] = _knownUsers[uid];
      }
    });
    _onlineUsers.forEach(function (u) {
      var uid = (u.id || '').toString();
      if (uid && uid !== _userId) {
        usersMap[uid] = u;
      }
    });
    return Object.values(usersMap);
  }

  // ====== RECONNECT / HEARTBEAT ======

  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    var delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), MAX_RECONNECT_DELAY);
    _reconnectAttempts++;
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
    _pollingTimer = setInterval(function () {
      _pollMessages();
    }, POLLING_INTERVAL);
    _pollMessages();
  }

  function _stopPolling() {
    if (_pollingTimer) {
      clearInterval(_pollingTimer);
      _pollingTimer = null;
    }
  }

  function _pollMessages() {
    if (_viewMode === 'messages' && _activeConvId) {
      _fetchMessages(_activeConvId, 0).then(function (msgs) {
        if (!msgs) return;
        var newMsgs = false;
        msgs.forEach(function (m) {
          if (!_messageIds.has(m.id)) {
            _addMessage(_activeConvId, m);
            newMsgs = true;
          }
        });
        if (newMsgs && _activeConvId) {
          _renderConvMessages(_activeConvId);
          _scrollToBottom();
        }
      });
    }
  }

  // ====== ONLINE USERS ======

  function _startOnlineUsersPolling() {
    _stopOnlineUsersPolling();
    _fetchOnlineUsers();
    _onlineUsersTimer = setInterval(function () {
      _fetchOnlineUsers();
    }, ONLINE_USERS_INTERVAL);
  }

  function _stopOnlineUsersPolling() {
    if (_onlineUsersTimer) {
      clearInterval(_onlineUsersTimer);
      _onlineUsersTimer = null;
    }
  }

  async function _fetchOnlineUsers() {
    var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.ONLINE_USERS;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      var userIds = result.data;
      if (!Array.isArray(userIds)) return;

      var users = [];
      var unknownIds = [];

      userIds.forEach(function (uid) {
        var uidStr = uid.toString();
        if (uidStr === _userId) {
          // Skip self — online count should only reflect other users
        } else if (_knownUsers[uidStr]) {
          users.push(_knownUsers[uidStr]);
        } else {
          unknownIds.push(uid);
        }
      });

      if (unknownIds.length > 0) {
        var fetchPromises = unknownIds.map(function (uid) {
          return _fetchUsername(uid).then(function (uname) {
            var user = { id: parseInt(uid.toString(), 10), username: uname || ('User #' + uid) };
            _knownUsers[uid.toString()] = user;
            users.push(user);
          });
        });
        await Promise.all(fetchPromises);
      }

      _onlineUsers = users;

      // Update online count in header
      var countEl = document.getElementById('onlineCountText');
      if (countEl) {
        countEl.textContent = _onlineUsers.length + ' online';
      }
    } catch (e) {
      console.error('[Chat] Failed to fetch online users:', e);
    }
  }

  // ====== REST API ======

  async function _fetchConversations() {
    var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.CONVERSATIONS +
      '?userId=' + _userId;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      return result.data;
    } catch (e) {
      console.error('[Chat] Failed to fetch conversations:', e);
      return [];
    }
  }

  async function _fetchMessages(convId, page) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.MESSAGES.replace('{conversationId}', convId) +
      '?page=' + page + '&pageSize=' + PAGE_SIZE + '&userId=' + _userId;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      var data = result.data;
      if (data && Array.isArray(data.content)) return data.content;
      if (Array.isArray(data)) return data;
      return [];
    } catch (e) {
      console.error('[Chat] Failed to fetch messages:', e);
      return [];
    }
  }

  async function _sendMessageREST(convId, content) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.MESSAGES.replace('{conversationId}', convId) +
      '?userId=' + _userId;
    try {
      await authenticatedRequest(url, {
        method: 'POST',
        body: JSON.stringify({ content: content, messageType: 'TEXT' })
      });
    } catch (e) {
      console.error('[Chat] Failed to send message via REST:', e);
    }
  }

  async function _markAsRead(convId) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.CONVERSATIONS_READ.replace('{id}', convId) +
      '?userId=' + _userId;
    try {
      await authenticatedRequest(url, { method: 'PUT' });
    } catch (e) {
      console.warn('[Chat] Failed to mark as read:', e);
    }
  }

  async function _createConversation(type, name, participantIds) {
    var url = API_CONFIG.CHAT.BASE_URL + API_CONFIG.CHAT.CONVERSATIONS +
      '?userId=' + _userId;
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
      console.error('[Chat] Failed to create conversation:', e);
      return null;
    }
  }

  async function _fetchSingleConversation(convId) {
    var url = API_CONFIG.CHAT.BASE_URL +
      API_CONFIG.CHAT.CONVERSATION.replace('{id}', convId) +
      '?userId=' + _userId;
    try {
      var result = await authenticatedRequest(url, { method: 'GET' });
      var found = result.data;
      if (!found) return;

      // Skip Tavern conversations
      if (found.type === 'GROUP' && found.name === 'Tavern') return;

      if (!_conversations.find(function (c) { return c.id === found.id; })) {
        var conv = _normalizeConversation(found);
        _enrichParticipants([conv]);

        // Resolve unknown usernames for DIRECT
        if (found.type === 'DIRECT') {
          var unknownIds = [];
          (conv.participants || []).forEach(function (p) {
            var uid = (p.userId || p.id || '').toString();
            if (uid && uid !== _userId && !p.username && !_knownUsers[uid]) {
              unknownIds.push(uid);
            }
          });
          if (unknownIds.length > 0) {
            await Promise.all(unknownIds.map(function (uid) {
              return _fetchUsername(uid).then(function (uname) {
                if (uname) {
                  _knownUsers[uid] = { id: parseInt(uid, 10), username: uname };
                  (conv.participants || []).forEach(function (p) {
                    if ((p.userId || p.id || '').toString() === uid) p.username = uname;
                  });
                }
              });
            }));
          }
        }

        _conversations.unshift(conv);
      }
    } catch (e) {
      console.error('[Chat] Failed to fetch conversation:', e);
    }
  }

  // ====== CONVERSATION RESOLUTION ======

  async function _resolveConversations() {
    var convs = await _fetchConversations();

    if ((!convs || convs.length === 0) && _conversations.length === 0) {
      _backendAvailable = false;
      _renderConnectionError();
      return;
    }

    _backendAvailable = true;
    _clearChatError();

    if (!Array.isArray(convs)) convs = [];

    // Build unified conversation list (exclude Tavern)
    _conversations = [];
    convs.forEach(function (c) {
      if (c.type === 'GROUP' && c.name === 'Tavern') return; // skip Tavern
      _conversations.push(_normalizeConversation(c));
    });

    // Clean up stale archived IDs
    var validIds = new Set(_conversations.map(function (c) { return c.id; }));
    _archivedConvIds.forEach(function (id) {
      if (!validIds.has(id)) _archivedConvIds.delete(id);
    });
    _saveArchivedIds();

    // Build known users cache
    await _buildKnownUsersFromConversations(convs);

    // Resolve DIRECT conversations with missing names
    await _resolveUnknownConversationNames();

    // Show conversation list
    _showListView();
  }

  function _normalizeConversation(conv) {
    return {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      createdBy: conv.createdBy || null,
      createdAt: conv.createdAt || null,
      updatedAt: conv.updatedAt || null,
      participants: conv.participants || [],
      lastMessage: null,
      lastMessageTime: conv.updatedAt || null,
      unreadCount: 0
    };
  }

  // ====== MESSAGE MANAGEMENT ======

  function _addMessage(convId, msg) {
    if (msg.id && _messageIds.has(msg.id)) return;
    if (msg.id) _messageIds.add(msg.id);

    if (!_messagesByConv[convId]) _messagesByConv[convId] = [];
    _messagesByConv[convId].push(msg);
  }

  function _removeOptimisticMessage(confirmedMsg) {
    var convId = confirmedMsg.conversationId;

    if (_messagesByConv[convId]) {
      _messagesByConv[convId] = _messagesByConv[convId].filter(function (m) {
        if (m._optimistic && m.senderId && m.senderId.toString() === (confirmedMsg.senderId || '').toString() && m.content === confirmedMsg.content) {
          return false;
        }
        return true;
      });
    }

    _addMessage(convId, confirmedMsg);
    if (_activeConvId === convId && _viewMode === 'messages') {
      _renderConvMessages(convId);
      _scrollToBottom();
    }
  }

  function _findConversation(convId) {
    return _conversations.find(function (c) { return c.id === convId; }) || null;
  }

  function _updateConversationPreview(convId, msg) {
    var conv = _findConversation(convId);
    if (!conv) return;
    conv.lastMessage = msg.content;
    conv.lastMessageTime = msg.createdAt;
    if (_activeConvId !== convId) {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
  }

  // ====== UI RENDERING ======

  function _renderConvMessages(convId) {
    var container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    var msgs = _messagesByConv[convId] || [];
    _renderMessageList(container, msgs);
  }

  function _renderMessageList(container, msgs) {
    var prevMsg = null;
    for (var i = 0; i < msgs.length; i++) {
      var dateSep = _maybeDateSeparator(prevMsg, msgs[i]);
      if (dateSep) container.appendChild(dateSep);
      container.appendChild(_createMessageElement(msgs[i], prevMsg));
      prevMsg = msgs[i];
    }
  }

  function _renderSingleMessage(msg) {
    var container = document.getElementById('chatMessages');
    if (!container) return;

    var prevMsg = _getLastMessageInCurrentList();
    var dateSep = _maybeDateSeparator(prevMsg, msg);
    if (dateSep) container.appendChild(dateSep);
    container.appendChild(_createMessageElement(msg, prevMsg));
  }

  function _getLastMessageInCurrentList() {
    if (!_activeConvId) return null;
    var msgs = _messagesByConv[_activeConvId];
    return msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
  }

  function _isSameGroup(prev, curr) {
    if (!prev || !curr) return false;
    if (String(prev.senderId) !== String(curr.senderId)) return false;
    try {
      var t1 = new Date(prev.createdAt).getTime();
      var t2 = new Date(curr.createdAt).getTime();
      return Math.abs(t2 - t1) < 60000;
    } catch (e) { return false; }
  }

  function _isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  }

  function _maybeDateSeparator(prevMsg, currMsg) {
    if (!currMsg || !currMsg.createdAt) return null;
    var currDate = new Date(currMsg.createdAt);
    if (prevMsg && prevMsg.createdAt) {
      var prevDate = new Date(prevMsg.createdAt);
      if (_isSameDay(prevDate, currDate)) return null;
    }
    var today = new Date();
    var yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    var label;
    if (_isSameDay(currDate, today)) {
      label = 'Today';
    } else if (_isSameDay(currDate, yesterday)) {
      label = 'Yesterday';
    } else {
      label = currDate.getDate().toString().padStart(2, '0') + '/' +
              (currDate.getMonth() + 1).toString().padStart(2, '0') + '/' +
              currDate.getFullYear();
    }
    var sep = document.createElement('div');
    sep.className = 'chat-date-separator';
    sep.innerHTML = '<span>' + label + '</span>';
    return sep;
  }

  function _createMessageElement(msg, prevMsg) {
    var isSent = msg.senderId && msg.senderId.toString() === _userId;
    var sender = msg.senderUsername || _resolveUsername(msg.senderId) || 'Unknown';
    var content = _escapeHtml(msg.content || '');
    var time = _formatTime(msg.createdAt);
    var continuation = _isSameGroup(prevMsg, msg);

    var div = document.createElement('div');
    div.className = 'message ' + (isSent ? 'sent' : 'received') + (continuation ? ' continuation' : '');
    if (msg.id) div.dataset.msgId = msg.id;

    var showSender = !isSent && !continuation;

    div.innerHTML =
      '<div class="message-bubble">' +
        (showSender ? '<span class="message-sender">' + _escapeHtml(sender) + '</span>' : '') +
        '<span class="message-text">' + content + '</span>' +
        '<span class="message-meta">' +
          '<span class="message-time">' + time + '</span>' +
          (isSent ? '<span class="message-status">&#10003;&#10003;</span>' : '') +
        '</span>' +
      '</div>';

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
        '<p style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:0.5rem;">Chat Unreachable</p>' +
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
    var convId = _activeConvId;
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
    if (conv.type === 'DIRECT') {
      if (conv.participants && conv.participants.length > 0) {
        var other = conv.participants.find(function (p) {
          var pid = (p.userId || p.id || '').toString();
          return pid !== _userId;
        });
        if (other) {
          var uid = (other.userId || other.id || '').toString();
          return other.username || _resolveUsername(uid) || ('User #' + uid);
        }
      }
      return conv.name || 'Direct Message';
    }
    return conv.name || 'Group';
  }

  function _resolveUsername(userId) {
    if (!userId) return null;
    var uid = userId.toString();
    if (uid === _userId) return _username;
    if (_knownUsers[uid] && _knownUsers[uid].username) return _knownUsers[uid].username;
    var online = _onlineUsers.find(function (u) { return u.id && u.id.toString() === uid; });
    if (online && online.username) return online.username;
    return null;
  }

  // ====== EXPOSE PUBLIC API ======
  return {
    init: init,
    destroy: destroy,
    toggleChat: toggleChat,
    sendMessage: sendMessage,
    handleKeypress: handleKeypress,
    _retry: function () {
      _resolveConversations();
      _connectWebSocket();
    }
  };
})();
