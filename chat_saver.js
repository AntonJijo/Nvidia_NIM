class ChatSaver {
    constructor() {
        this.storageKey = 'nvidia_nim_chat_history';
        this.consentKey = 'nvidia_nim_cookie_consent';
        this.currentChatId = null;
        this.initialized = false;
        this.searchQuery = '';
    }

    init() {
        if (this.initialized) return;

        // Check consent status
        const consent = localStorage.getItem(this.consentKey);
        console.log('ChatSaver: Initializing, consent status:', consent);

        if (consent === 'accepted') {
            this.enableHistory();
        } else if (consent === 'declined') {
            this.disableHistory();
        } else {
            this.showConsentPopup();
        }

        // Search Popup Logic
        const searchBtn = document.getElementById('searchChatsBtn');
        const searchPopup = document.getElementById('searchPopup');
        const searchInput = document.getElementById('searchInput');

        if (searchBtn && searchPopup && searchInput) {
            // Toggle Popup
            searchBtn.addEventListener('click', (e) => {
                e.stopPropagation();

                // Auto-expand sidebar if collapsed to show results
                const sidebar = document.getElementById('sidebar');
                if (sidebar && !sidebar.classList.contains('expanded')) {
                    sidebar.classList.add('expanded');
                    localStorage.setItem('sidebar_expanded', 'true');
                }

                // Position logic
                const rect = searchBtn.getBoundingClientRect();
                searchPopup.style.top = (rect.bottom + 5) + 'px';
                searchPopup.style.left = rect.left + 'px';
                // Adjust if narrow screen or sidebar collapsed (optional specific positioning)

                // Show/Hide
                const isActive = searchPopup.classList.contains('active');

                if (!isActive) {
                    searchPopup.classList.add('active');
                    searchInput.focus();
                } else {
                    searchPopup.classList.remove('active');
                }
            });

            // Prevent closing when clicking inside popup
            searchPopup.addEventListener('click', (e) => e.stopPropagation());

            // Close when clicking outside
            document.addEventListener('click', () => {
                // Only hide if it's currently shown
                if (searchPopup.classList.contains('active')) {
                    searchPopup.classList.remove('active');
                }
            });

            // Input Logic
            searchInput.addEventListener('input', (e) => {
                const currentConsent = localStorage.getItem(this.consentKey);
                if (currentConsent !== 'accepted') {
                    e.target.value = '';
                    const originalPlaceholder = e.target.placeholder;
                    e.target.placeholder = "Enable history to search!";
                    e.target.classList.add('placeholder-red-400'); // Assuming Tailwind or add style
                    // Add temporary red color style just in case
                    e.target.style.color = '#ef4444';

                    setTimeout(() => {
                        e.target.placeholder = "Search chats...";
                        e.target.classList.remove('placeholder-red-400');
                        e.target.style.color = '#fff';
                    }, 2000);
                    return;
                }
                this.searchQuery = e.target.value;
                this.renderSidebar();
            });
        }

        // Hook into the sidebar conversation list
        this.renderSidebar();

        this.initialized = true;
    }

    showConsentPopup() {
        console.log('ChatSaver: Showing consent popup');
        // Remove existing popup if any
        const existing = document.getElementById('cookie-consent-popup');
        if (existing) existing.remove();

        if (!document.body) {
            console.error('ChatSaver: document.body is missing!');
            return;
        }

        const popup = document.createElement('div');
        popup.id = 'cookie-consent-popup';
        // Use inline z-index AND positioning AND flex layout to ensure it works without JIT
        popup.className = 'shadow-lg animate-slide-up';
        popup.style.cssText = 'position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999; background-color: #171717; border-top: 1px solid rgba(255,255,255,0.1); padding: 16px 24px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;';

        popup.innerHTML = `
            <div style="flex: 1; min-width: 250px;">
                <h3 style="color: white; font-weight: 500; margin-bottom: 4px;">We use cookies</h3>
                <p style="color: #9ca3af; font-size: 14px;">
                    We use cookies to save your chat history locally so you can access your past conversations. 
                    Without this, your chats will disappear when you close the page.
                    <a href="cookie_policy.html" target="_blank" style="text-decoration: underline; color: #9ca3af;" onmouseover="this.style.color='white'" onmouseout="this.style.color='#9ca3af'">Cookie Policy</a>.
                </p>
            </div>
            <div style="display: flex; align-items: center; gap: 12px; white-space: nowrap;">
                <button id="cookie-decline" style="padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: transparent; color: white; font-size: 14px; cursor: pointer;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                    Decline
                </button>
                <button id="cookie-accept" style="padding: 8px 16px; border-radius: 8px; border: none; background: white; color: black; font-size: 14px; font-weight: 500; cursor: pointer;" onmouseover="this.style.backgroundColor='#e5e7eb'" onmouseout="this.style.backgroundColor='white'">
                    Accept all
                </button>
            </div>
        `;

        document.body.appendChild(popup);
        console.log('ChatSaver: Popup appended to body');

        // Add event listeners
        document.getElementById('cookie-accept').addEventListener('click', () => this.handleConsent(true));
        document.getElementById('cookie-decline').addEventListener('click', () => this.handleConsent(false));
    }

    handleConsent(accepted) {
        if (accepted) {
            localStorage.setItem(this.consentKey, 'accepted');
            this.enableHistory();
        } else {
            localStorage.setItem(this.consentKey, 'declined');
            this.disableHistory();
        }

        const popup = document.getElementById('cookie-consent-popup');
        if (popup) popup.remove();

        this.renderSidebar();
    }

    enableHistory() {
        console.log('Chat history enabled');
        // If we have a current active chat, try to save it if it's new
        if (window.chatbot && window.chatbot.messages.length > 0) {
            this.saveCurrentChat();
        }
    }

    disableHistory() {
        console.log('Chat history disabled');
        // We don't delete existing history, just stop showing/saving it
    }

    resetConsent() {
        localStorage.removeItem(this.consentKey);
        this.showConsentPopup();
    }

    startSession(sessionId) {
        if (localStorage.getItem(this.consentKey) !== 'accepted') return;

        const history = this.getHistory();
        // Check if already exists (shouldn't, but safely check)
        if (history.find(c => c.id === sessionId)) return;

        const newChat = {
            id: sessionId,
            title: 'New Chat',
            timestamp: Date.now(),
            messages: [],
            model: window.chatbot.modelSelect ? window.chatbot.modelSelect.value : 'unknown'
        };

        history.unshift(newChat);
        if (history.length > 100) history.pop();

        localStorage.setItem(this.storageKey, JSON.stringify(history));
        this.renderSidebar();
    }

    updateChatStats(chatId, stats) {
        if (!chatId || !stats) return;

        let history = this.getHistory();
        const chatIndex = history.findIndex(c => c.id === chatId);

        if (chatIndex >= 0) {
            history[chatIndex].stats = stats;
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(history));
            } catch (e) {
                console.error("Failed to save chat stats", e);
            }
        }
    }

    saveCurrentChat() {
        if (localStorage.getItem(this.consentKey) !== 'accepted') return;
        if (!window.chatbot) return;

        const messages = window.chatbot.messages;
        if (messages.length === 0) return;

        const history = this.getHistory();
        const sessionId = window.chatbot.sessionId;

        // Find existing chat or create new
        let chatIndex = history.findIndex(c => c.id === sessionId);
        let chatData = null;

        if (chatIndex >= 0) {
            chatData = history[chatIndex];
        } else {
            // Should have been created by startSession, but fallback
            chatData = {
                id: sessionId,
                title: 'New Chat',
                timestamp: Date.now(),
                messages: [],
                model: window.chatbot.modelSelect ? window.chatbot.modelSelect.value : 'unknown'
            };
            history.unshift(chatData);
            chatIndex = 0;
        }

        // Update basic data
        chatData.messages = messages;
        chatData.timestamp = Date.now(); // Update timestamp on new message
        chatData.model = window.chatbot.modelSelect ? window.chatbot.modelSelect.value : 'unknown';

        // Title Logic
        let currentTitle = chatData.title;
        let newTitle = currentTitle;

        // If title is "New Chat" and we have a user message, update it to message content first
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (!chatData.isTitleGenerated && firstUserMsg && currentTitle === 'New Chat') {
            newTitle = firstUserMsg.content.substring(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '');
        }

        const titleChanged = newTitle !== currentTitle;
        chatData.title = newTitle;

        history[chatIndex] = chatData;

        // Trigger AI Generation if needed
        if (!chatData.isTitleGenerated && firstUserMsg && !chatData.isGeneratingTitle) {
            chatData.isGeneratingTitle = true;
            this.generateTitle(sessionId, firstUserMsg.content, chatData.model);
        }

        // Save
        localStorage.setItem(this.storageKey, JSON.stringify(history));

        // Render or Animate
        if (titleChanged) {
            this.animateTitleUpdate(sessionId, newTitle);
        } else {
            // Only re-render if we didn't animate (animation handles UI)
            // But we might need to update active state or reorder?
            // "New Chat" is usually top. Just re-render to be safe unless we are mid-animation?
            // If we re-render, we lose animation state. 
            // Only re-render if structure changed (new item). Here we updated existing.
            // But if we moved it to top? (It's already at top usually).
            this.renderSidebar();
        }
    }

    // Helper to animate title update in sidebar
    animateTitleUpdate(chatId, newTitle) {
        // First, ensure sidebar has the item (re-render just in case, but preserving state?)
        // If we re-render, text updates instantly.
        // Strategy: Render with NEW title, then find element, clear it, and type it.
        this.renderSidebar();

        const item = document.querySelector(`.conversation-item[data-id="${chatId}"] span`);
        if (item) {
            this.typeText(item, newTitle);
        }
    }

    typeText(element, text) {
        element.textContent = '';
        let i = 0;
        // Faster typing for clearer effect
        const speed = 30;

        function type() {
            if (i < text.length) {
                element.textContent += text.charAt(i);
                i++;
                setTimeout(type, speed);
            }
        }
        type();
    }

    async generateTitle(chatId, firstMessage, model) {
        // Define server URLs matching script.js logic
        const servers = window.location.hostname === 'antonjijo.github.io'
            ? [
                'https://nvidia-nim-bot.onrender.com',
                'https://Nvidia.pythonanywhere.com'
            ]
            : ['http://localhost:8000'];

        try {
            // Use a temporary session ID to avoid polluting the chat context
            const tempSessionId = 'title_gen_' + Date.now();
            const prompt = `Generate a very short, concise title (maximum 4-5 words) for a conversation that starts with this message: "${firstMessage}". Do not use quotes. Return ONLY the title.`;

            let title = null;

            // Try servers
            for (const server of servers) {
                try {
                    const response = await fetch(`${server}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            message: prompt,
                            model: model || 'meta/llama-3.1-405b-instruct', // Fallback
                            session_id: tempSessionId,
                            max_tokens: 50,
                            temperature: 0.5
                        })
                    });

                    if (response.ok) {
                        const data = await response.json();
                        title = data.response || data.message;
                        if (title) break;
                    }
                } catch (e) {
                    console.warn(`Title generation failed on ${server}`, e);
                }
            }

            if (title) {
                // Clean up title
                title = title.replace(/"/g, '').trim();
                if (title.length > 50) title = title.substring(0, 50) + '...';

                // Update history
                const history = this.getHistory();
                const chatIndex = history.findIndex(c => c.id === chatId);
                if (chatIndex >= 0) {
                    history[chatIndex].title = title;
                    history[chatIndex].isTitleGenerated = true;
                    delete history[chatIndex].isGeneratingTitle;
                    localStorage.setItem(this.storageKey, JSON.stringify(history));

                    // Use animation for AI title too
                    this.animateTitleUpdate(chatId, title);
                }
            }
        } catch (err) {
            console.error('Error generating title:', err);
        }
    }

    getHistory() {
        try {
            return JSON.parse(localStorage.getItem(this.storageKey) || '[]');
        } catch (e) {
            console.error('Failed to parse chat history', e);
            return [];
        }
    }

    renderSidebar() {
        const container = document.getElementById('conversationList');
        if (!container) return;

        const consent = localStorage.getItem(this.consentKey);

        if (consent === 'declined') {
            container.innerHTML = `
                <div style="padding: 16px; text-align: center;">
                    <p style="color: #6b7280; font-size: 12px; margin-bottom: 12px;">Chat history is disabled</p>
                    <button id="enable-history-btn" style="font-size: 12px; padding: 6px 12px; background: rgba(74, 222, 128, 0.1); color: #4ade80; border-radius: 4px; border: 1px solid rgba(74, 222, 128, 0.2); cursor: pointer; width: 100%;" onmouseover="this.style.backgroundColor='rgba(74, 222, 128, 0.2)'" onmouseout="this.style.backgroundColor='rgba(74, 222, 128, 0.1)'">
                        Enable History
                    </button>
                </div>
            `;
            document.getElementById('enable-history-btn')?.addEventListener('click', () => this.resetConsent());
            return;
        }

        if (consent !== 'accepted') {
            // Pending consent or not set
            return;
        }

        const history = this.getHistory();

        // Filter history based on search query
        const filteredHistory = this.searchQuery
            ? history.filter(chat => chat.title.toLowerCase().includes(this.searchQuery.toLowerCase()))
            : history;

        let html = '';

        // Active session ID
        const currentSessionId = window.chatbot ? window.chatbot.sessionId : null;
        const currentMessages = window.chatbot ? window.chatbot.messages : [];
        const isNewUnsavedChat = currentSessionId && currentMessages.length === 0 && !history.find(c => c.id === currentSessionId);

        // Prepend "New Chat" if we are in a new unsaved session and NOT searching
        if (isNewUnsavedChat && !this.searchQuery) {
            html += `
                <div class="conversation-item active" onclick="/* Already here */">
                    <div style="display: flex; align-items: center; gap: 10px; overflow: hidden; width: 100%;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; color: #ececec;"> <!-- White/Primary for active -->
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500;">New chat</span>
                    </div>
                </div>
            `;
        }

        filteredHistory.forEach(chat => {
            const isActive = chat.id === currentSessionId;
            // Format date if needed, for now just title
            html += `
                <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${chat.id}">
                    <div class="conversation-content" onclick="window.chatSaver.loadChat('${chat.id}')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; color: #6b7280;">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span class="conversation-title">${this.escapeHTML(chat.title)}</span>
                    </div>
                    <button class="conversation-delete-btn" onclick="event.stopPropagation(); window.chatSaver.deleteChat('${chat.id}')" title="Delete chat">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;
        });

        if (history.length === 0) {
            html = `
                <div class="text-gray-500 text-xs p-4 text-center italic">
                    No saved chats yet
                </div>
            `;
        } else if (filteredHistory.length === 0) {
            html = `
                <div class="text-gray-500 text-xs p-4 text-center italic">
                    No results found
                </div>
            `;
        }

        container.innerHTML = html;
    }

    loadChat(chatId) {
        if (!window.chatbot) return;

        const history = this.getHistory();
        const chat = history.find(c => c.id === chatId);

        if (chat) {
            // Restore session
            window.chatbot.sessionId = chat.id;
            window.chatbot.messages = chat.messages || []; // Ensure array

            // Clear UI
            const messagesContainer = document.getElementById('chatMessages');
            messagesContainer.innerHTML = ''; // Start clean

            // Reset or Restore stats UI
            window.chatbot.conversationStats = chat.stats || null;
            // Animate transition (even to 0)
            window.chatbot.updateConversationStatsUI(true);

            // Re-render messages
            if (chat.messages.length === 0) {
                window.chatbot.addWelcomeMessage();
            } else {
                chat.messages.forEach(msg => {
                    // Use addMessage with save=false to avoid duplication and typing animation
                    // IMPORTANT: addMessage returns the element but doesn't append it for non-user roles in script.js
                    const msgEl = window.chatbot.addMessage(msg.content, msg.role, false);

                    if (msg.role !== 'user' && msgEl) {
                        messagesContainer.appendChild(msgEl);
                        // Ensure copy listeners are attached (addMessage does this internally)
                    }
                });
                // Scroll to bottom
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }

            // Restore model if possible
            if (chat.model && window.chatbot.modelSelect) {
                window.chatbot.modelSelect.value = chat.model;
                if (window.chatbot.updateCustomDropdownDisplay) {
                    window.chatbot.updateCustomDropdownDisplay(chat.model);
                }
            }

            // Re-render sidebar to highlight active
            this.renderSidebar();

            // Close mobile sidebar if open
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            if (sidebar) sidebar.classList.remove('expanded');
            if (overlay) overlay.classList.remove('active');
        }
    }

    deleteChat(chatId) {
        // Get chat title for display
        const history = this.getHistory();
        const chat = history.find(c => c.id === chatId);
        const chatTitle = chat ? chat.title : 'this conversation';

        // Create custom modal
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'delete-modal-overlay';
        modalOverlay.innerHTML = `
            <div class="delete-modal">
                <div class="delete-modal-icon">
                    <i class="fas fa-trash-alt"></i>
                </div>
                <h3 class="delete-modal-title">Delete Conversation?</h3>
                <p class="delete-modal-text">"${this.escapeHTML(chatTitle.substring(0, 50))}${chatTitle.length > 50 ? '...' : ''}"</p>
                <p class="delete-modal-warning">This action cannot be undone.</p>
                <div class="delete-modal-actions">
                    <button class="delete-modal-cancel">Cancel</button>
                    <button class="delete-modal-confirm">Delete</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalOverlay);

        // Trigger animation
        requestAnimationFrame(() => {
            modalOverlay.classList.add('active');
        });

        // Handle actions
        const closeModal = () => {
            modalOverlay.classList.remove('active');
            setTimeout(() => modalOverlay.remove(), 200);
        };

        modalOverlay.querySelector('.delete-modal-cancel').onclick = closeModal;
        modalOverlay.querySelector('.delete-modal-confirm').onclick = () => {
            // Perform deletion
            let updatedHistory = this.getHistory().filter(c => c.id !== chatId);
            localStorage.setItem(this.storageKey, JSON.stringify(updatedHistory));

            // If we deleted the active chat, reset to fresh state (like ChatGPT)
            if (window.chatbot && window.chatbot.sessionId === chatId) {
                // Generate new session ID but DON'T save to history yet
                const newSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 16);
                localStorage.setItem('chatbot_session_id', newSessionId);
                window.chatbot.sessionId = newSessionId;

                // Clear UI
                window.chatbot.messages = [];
                if (window.chatbot.chatMessages) {
                    window.chatbot.chatMessages.innerHTML = '';
                }
                window.chatbot.addWelcomeMessage();
                window.chatbot.conversationStats = null;

                const statsEl = document.getElementById('conversationStats');
                if (statsEl) statsEl.style.display = 'none';
            }

            // Re-render sidebar (will show "New chat" if in fresh state)
            this.renderSidebar();
            closeModal();
            console.log('Chat deleted:', chatId);
        };

        // Close on overlay click
        modalOverlay.onclick = (e) => {
            if (e.target === modalOverlay) closeModal();
        };

        // Close on Escape
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    escapeHTML(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    window.chatSaver = new ChatSaver();

    // Give script.js time to initialize chatbot
    setTimeout(() => {
        window.chatSaver.init();
    }, 500);
});

// Add animation styles dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes slide-up {
        from { transform: translateY(100%); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }
    .animate-slide-up {
        animation: slide-up 0.5s ease-out;
    }
`;
document.head.appendChild(style);
