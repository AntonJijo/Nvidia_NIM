class Chatbot {
    // Escape HTML meta-characters from a string
    escapeHTML(str) {
        if (typeof str !== 'string') return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Safe DOM manipulation to prevent XSS
    safeSetHTML(element, content) {
        if (!element || typeof content !== 'string') return;

        // Clear existing content safely
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }

        // Create a temporary container to parse HTML safely
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;

        // Move all child nodes safely
        while (tempDiv.firstChild) {
            element.appendChild(tempDiv.firstChild);
        }

    }

    setupMarkdown() {
        if (typeof marked === 'undefined') {
            console.error('Marked library not loaded');
            return;
        }

        const renderer = new marked.Renderer();
        renderer.code = (code, language) => {
            // Handle Marked newer versions where first arg is a token object
            let text = code;
            let langArg = language;

            if (typeof code === 'object' && code !== null && code.text) {
                text = code.text;
                langArg = code.lang;
            }

            const lang = (langArg || 'text').split(/\s+/)[0];
            const id = 'code-' + Math.random().toString(36).substr(2, 9);

            let highlightedCode = text;
            if (typeof hljs !== 'undefined') {
                const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
                try {
                    highlightedCode = hljs.highlight(text, { language: validLang }).value;
                } catch (e) {
                    console.error('Highlight error:', e);
                }
            }

            return `
                <div class="code-block">
                    <div class="code-header">
                        <div class="code-language-info">
                            <span class="code-language">${this.getLanguageDisplayName(lang)}</span>
                        </div>
                        <button class="copy-button" data-code-id="${id}" title="Copy code">
                            <i class="fas fa-copy"></i>
                            <span class="copy-text">Copy code</span>
                        </button>
                    </div>
                    <div class="code-content hljs language-${lang}" id="${id}">${highlightedCode}</div>
                </div>
            `;
        };

        marked.setOptions({
            renderer: renderer,
            breaks: true,
            gfm: true
        });
    }

    renderMarkdown(text) {
        if (typeof marked === 'undefined') return this.escapeHTML(text);

        // Parse markdown to HTML
        let html = marked.parse(text);

        // Sanitize HTML
        if (typeof DOMPurify !== 'undefined') {
            html = DOMPurify.sanitize(html, {
                ADD_TAGS: ['div', 'span', 'i', 'button'],
                ADD_ATTR: ['target', 'class', 'id', 'data-code-id', 'title']
            });
        }

        return html;
    }

    constructor() {
        this.messages = [];
        this.isLoading = false;
        this.currentTypingInterval = null;
        this.sessionId = this.generateSessionId();
        this.conversationStats = null;
        this.selectedFile = null;

        this.setupMarkdown(); // Initialize Markdown pipeline

        this.initializeElements();
        this.setupEventListeners();
        this.autoResizeTextarea();
        this.checkServerStatus();
        this.setupSessionControls();

        // Load initial conversation stats
        this.loadInitialStats();

        // Set initial status color after a short delay to ensure elements are loaded
        setTimeout(() => {
            if (this.statusPingOuter && this.statusPingInner) {
                this.updateStatus('Ready', '#4ade80');
            }
        }, 100);
    }

    generateSessionId() {
        // Check for existing session in localStorage first
        const existingSessionId = localStorage.getItem('chatbot_session_id');

        if (existingSessionId && this._validateSessionId(existingSessionId)) {
            console.log('Resuming existing session:', existingSessionId);
            return existingSessionId;
        }

        // Generate a unique session ID for conversation persistence
        const newSessionId = 'session_' + Date.now() + '_' + this._secureRandomString(16);

        // Store the new session ID in localStorage
        localStorage.setItem('chatbot_session_id', newSessionId);
        console.log('Created new session:', newSessionId);

        return newSessionId;
    }

    _validateSessionId(sessionId) {
        // Validate session ID format
        if (!sessionId || typeof sessionId !== 'string') {
            return false;
        }

        // Check format: session_timestamp_randomstring
        const sessionPattern = /^session_\d+_[a-f0-9]{16}$/;
        return sessionPattern.test(sessionId);
    }

    createNewSession() {
        let newSessionId;

        // Reuse current session if it's effectively empty (no user messages)
        // This prevents duplicate "New Chat" entries in sidebar when switching models in a fresh chat
        if (this.sessionId && (!this.messages || this.messages.length === 0)) {
            console.log('Reusing empty session:', this.sessionId);
            newSessionId = this.sessionId;
        } else {
            // Force create a new session and store it
            newSessionId = 'session_' + Date.now() + '_' + this._secureRandomString(16);
        }

        localStorage.setItem('chatbot_session_id', newSessionId);
        this.sessionId = newSessionId;

        console.log('Forced new session creation:', newSessionId);

        // Clear UI immediately (synchronously)
        this.messages = [];
        if (this.chatMessages) {
            while (this.chatMessages.firstChild) {
                this.chatMessages.removeChild(this.chatMessages.firstChild);
            }
        }
        this.addWelcomeMessage();
        this.conversationStats = null;
        this.currentStatsTokens = 0;
        this.updateConversationStatsUI();

        // Clear conversation on server (fire and forget)
        this.clearConversation();

        // Update sidebar to reflect new session immediately (start "New Chat")
        if (window.chatSaver) {
            window.chatSaver.startSession(newSessionId);
        }

        return newSessionId;
    }

    /**
     * Generate a cryptographically secure random string
     * @param {number} length - number of bytes, not final string length
     */
    _secureRandomString(length) {
        const array = new Uint8Array(length);
        window.crypto.getRandomValues(array);
        // Convert bytes to hex string
        return Array.from(array).map(b => ('0' + b.toString(16)).slice(-2)).join('');
    }

    async getConversationStats() {
        try {
            const servers = window.location.hostname === 'antonjijo.github.io'
                ? ['https://nvidia-nim-bot.onrender.com', 'https://Nvidia.pythonanywhere.com']
                : ['http://localhost:8000'];

            for (const serverURL of servers) {
                try {
                    console.log(`Fetching stats from: ${serverURL}/api/conversation/stats?session_id=${this.sessionId}`);
                    const response = await fetch(`${serverURL}/api/conversation/stats?session_id=${this.sessionId}`);
                    if (response.ok) {
                        this.conversationStats = await response.json();
                        console.log('Stats fetched successfully:', this.conversationStats);

                        // Save stats to persistent storage
                        if (window.chatSaver) {
                            window.chatSaver.updateChatStats(this.sessionId, this.conversationStats);
                        }

                        this.updateConversationStatsUI(true);
                        return this.conversationStats;
                    } else {
                        console.warn(`Failed to fetch stats from ${serverURL}: ${response.status}`);
                    }
                } catch (error) {
                    console.warn(`Failed to get stats from ${serverURL}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to get conversation stats:', error);
        }
        return null;
    }

    async clearConversation() {
        try {
            const servers = window.location.hostname === 'antonjijo.github.io'
                ? ['https://nvidia-nim-bot.onrender.com', 'https://Nvidia.pythonanywhere.com']
                : ['http://localhost:8000']; // DEV_MODE: Change to 5000 for production

            for (const serverURL of servers) {
                try {
                    const response = await fetch(`${serverURL}/api/conversation/clear`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            session_id: this.sessionId,
                            keep_system_prompt: true
                        })
                    });

                    if (response.ok) {
                        // Clear the UI messages as well
                        this.messages = [];
                        // Clear messages safely
                        while (this.chatMessages.firstChild) {
                            this.chatMessages.removeChild(this.chatMessages.firstChild);
                        }

                        // Add welcome message back
                        this.addWelcomeMessage();

                        // Update conversation stats
                        const result = await response.json();
                        this.conversationStats = result.stats;
                        this.updateConversationStatsUI(true); // Animate reset

                        console.log('Conversation cleared successfully');
                        return true;
                    }
                } catch (error) {
                    console.warn(`Failed to clear conversation on ${serverURL}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to clear conversation:', error);
        }
        return false;
    }

    addWelcomeMessage() {
        // Show the welcome screen
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) {
            welcomeScreen.style.display = 'flex';
        }
    }

    hideWelcomeScreen() {
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) {
            welcomeScreen.style.display = 'none';
        }
    }

    initializeElements() {
        this.chatMessages = document.getElementById('chatMessages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.charCount = document.getElementById('charCount');
        this.statusPing = document.getElementById('statusPing');
        this.statusPingOuter = document.getElementById('statusPingOuter');
        this.statusPingInner = document.getElementById('statusPingInner');
        this.modelSelect = document.getElementById('modelSelect');

        // New ChatGPT-style elements
        this.sidebar = document.getElementById('sidebar');
        this.sidebarToggle = document.getElementById('sidebarToggle');
        this.sidebarOverlay = document.getElementById('sidebarOverlay');
        this.mobileMenuBtn = document.getElementById('mobileMenuBtn');
        this.newChatBtn = document.getElementById('newChatBtn');
        this.modelDropdownBtn = document.getElementById('modelDropdownBtn');
        this.modelDropdown = document.getElementById('modelDropdown');
        this.currentModelName = document.getElementById('currentModelName');
        this.currentModelName = document.getElementById('currentModelName');
        this.welcomeScreen = document.getElementById('welcomeScreen');

        // New status and context display
        this.statusText = document.getElementById('statusText');
        this.contextInfo = document.getElementById('contextInfo');
        this.contextValue = document.getElementById('contextValue');

        this.initializeChatGPTUI();
        this.setupGlobalScrolling();

        // File Upload Elements
        this.fileInput = document.getElementById('fileInput');
        this.attachBtn = document.getElementById('attachBtn');
        this.filePreviewArea = document.getElementById('filePreviewArea');



        if (this.attachBtn && this.fileInput) {
            this.attachBtn.addEventListener('click', () => {
                this.fileInput.click();
            });
            this.fileInput.addEventListener('change', (e) => {
                this.handleFileSelect(e);
            });
        }



        // Image Preview Modal Elements
        this.imagePreviewModal = document.getElementById('imagePreviewModal');
        this.imagePreviewImg = document.getElementById('imagePreviewImg');
        this.imagePreviewCaption = document.getElementById('imagePreviewCaption');
        const imagePreviewClose = document.querySelector('.image-preview-close');
        if (imagePreviewClose) {
            imagePreviewClose.addEventListener('click', () => {
                this.closeImagePreview();
            });
        }
        // Close on outside click
        if (this.imagePreviewModal) {
            this.imagePreviewModal.addEventListener('click', (e) => {
                if (e.target === this.imagePreviewModal) {
                    this.closeImagePreview();
                }
            });
        }

        // Voice Input Elements
        this.micBtn = document.getElementById('micBtn');
        this.isRecording = false;
        this.setupVoiceInput();
    }

    setupEventListeners() {
        this.sendButton.addEventListener('click', (e) => {
            if (this.sendButton.disabled) {
                e.preventDefault();
                this.showErrorPopup('Maximum character limit (5000) reached!');
                return;
            }
            if (this.isLoading) {
                this.stopGeneration();
            } else {
                this.sendMessage();
            }
        });

        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (this.sendButton.disabled) {
                    this.showErrorPopup('Maximum character limit (5000) reached!');
                    return;
                }
                this.sendMessage();
            }
        });

        this.messageInput.addEventListener('input', (e) => {
            if (this.messageInput.value.includes("Hello! I'm your NVIDIA-powered chatbot with advanced capabilities")) {
                this.messageInput.value = this.messageInput.value.replace(/Hello! I'm your NVIDIA-powered chatbot with advanced capabilities[\s\S]*/, '');
            }
            if (this.messageInput.value.length >= 5000) {
                this.messageInput.value = this.messageInput.value.substring(0, 5000);
                this.showErrorPopup('Maximum character limit (5000) reached!');
                e.preventDefault();
            }
            this.updateCharCount();
            this.autoResizeTextarea(); // keep resizing on input
        });

        // Paste event listener for clipboard images
        this.messageInput.addEventListener('paste', (e) => {
            this.handlePaste(e);
        });

        // Drag and drop file upload - Global drop zone with input-box visual feedback
        const dropZone = document.body; // Accept drops anywhere
        const inputWrapper = document.getElementById('inputWrapper'); // Visual feedback only here

        // Prevent default drag behavior globally
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        // Visual feedback when dragging - show only on input wrapper
        dropZone.addEventListener('dragenter', (e) => {
            if (inputWrapper) {
                inputWrapper.classList.add('drag-over');
            }
        });

        dropZone.addEventListener('dragleave', (e) => {
            // Only remove if we've left the document entirely
            if (e.clientX === 0 && e.clientY === 0) {
                if (inputWrapper) {
                    inputWrapper.classList.remove('drag-over');
                }
            }
        });

        dropZone.addEventListener('drop', (e) => {
            if (inputWrapper) {
                inputWrapper.classList.remove('drag-over');
            }

            const files = e.dataTransfer.files;
            if (files.length > 0) {
                // Only handle the first file (Beta: 1 file at a time)
                const file = files[0];
                this.handleFileSelect(file);
            }
        });

        // Simple model dropdown change handler
        this.modelSelect.addEventListener('change', (e) => {
            this.handleModelChange(e.target.value);
        });

        // Delegated copy button logic for Markdown code blocks
        document.addEventListener('click', (e) => {
            const copyBtn = e.target.closest('.copy-button');
            if (copyBtn) {
                e.preventDefault();
                e.stopPropagation();
                const codeBlock = copyBtn.closest('.code-block');
                if (codeBlock) {
                    const codeContent = codeBlock.querySelector('.code-content');
                    if (codeContent) {
                        const code = codeContent.textContent; // Safe way to get text
                        navigator.clipboard.writeText(code).then(() => {
                            copyBtn.classList.add('copied');
                            const copyText = copyBtn.querySelector('.copy-text');
                            const originalText = 'Copy code';
                            if (copyText) copyText.textContent = 'Copied!';

                            setTimeout(() => {
                                copyBtn.classList.remove('copied');
                                if (copyText) copyText.textContent = originalText;
                            }, 2000);
                        });
                    }
                }
            }
        });
    }

    async handleModelChange(newModel) {
        // If this is the first model selection or no conversation exists, just switch
        if (!this.conversationStats || this.conversationStats.total_messages <= 1) {
            this.switchModel(newModel);
            return;
        }

        // Show confirmation dialog for model change
        this.showModelChangeConfirmation(newModel);
    }

    showModelChangeConfirmation(newModel) {
        const stats = this.conversationStats;
        const currentModel = stats.current_model || 'Unknown';

        // Create modal overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-overlay';
        // Create modal content safely
        const modal = document.createElement('div');
        modal.className = 'confirmation-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'modal-header';
        const h3 = document.createElement('h3');
        h3.textContent = 'Change Model & Start New Session?';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.setAttribute('aria-label', 'Close');
        const closeIcon = document.createElement('i');
        closeIcon.className = 'fas fa-times';
        closeBtn.appendChild(closeIcon);
        header.appendChild(h3);
        header.appendChild(closeBtn);

        // Content
        const content = document.createElement('div');
        content.className = 'modal-content';

        const modelChangeInfo = document.createElement('div');
        modelChangeInfo.className = 'model-change-info';

        // Current session stats
        const currentStats = document.createElement('div');
        currentStats.className = 'current-session-stats';
        const currentH4 = document.createElement('h4');
        currentH4.textContent = 'Current Session';
        currentStats.appendChild(currentH4);

        const statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';

        const statData = [
            ['Model:', this.escapeHTML(this.getModelDisplayName(currentModel))],
            ['Messages:', stats.total_messages.toString()],
            ['Tokens:', stats.total_tokens.toLocaleString()],
            ['Utilization:', stats.utilization_percent + '%']
        ];

        statData.forEach(([label, value]) => {
            const statItem = document.createElement('div');
            statItem.className = 'stat-item';

            const statLabel = document.createElement('span');
            statLabel.className = 'stat-label';
            statLabel.textContent = label;

            const statValue = document.createElement('span');
            statValue.className = 'stat-value';
            statValue.textContent = value;

            statItem.appendChild(statLabel);
            statItem.appendChild(statValue);
            statsGrid.appendChild(statItem);
        });

        currentStats.appendChild(statsGrid);
        modelChangeInfo.appendChild(currentStats);

        // Arrow divider
        const arrowDiv = document.createElement('div');
        arrowDiv.className = 'arrow-divider';
        const arrowIcon = document.createElement('i');
        arrowIcon.className = 'fas fa-arrow-down';
        arrowDiv.appendChild(arrowIcon);
        modelChangeInfo.appendChild(arrowDiv);

        // New session info
        const newSessionInfo = document.createElement('div');
        newSessionInfo.className = 'new-session-info';
        const newH4 = document.createElement('h4');
        newH4.textContent = 'New Session';
        newSessionInfo.appendChild(newH4);

        const newModelDisplay = document.createElement('div');
        newModelDisplay.className = 'new-model-display';
        const newModelName = document.createElement('span');
        newModelName.className = 'new-model-name';
        newModelName.textContent = this.escapeHTML(this.getModelDisplayName(newModel));
        const freshStart = document.createElement('span');
        freshStart.className = 'fresh-start';
        freshStart.textContent = 'Fresh conversation start';
        newModelDisplay.appendChild(newModelName);
        newModelDisplay.appendChild(freshStart);
        newSessionInfo.appendChild(newModelDisplay);
        modelChangeInfo.appendChild(newSessionInfo);

        content.appendChild(modelChangeInfo);

        // Warning notice
        const warning = document.createElement('div');
        warning.className = 'warning-notice';
        const warningIcon = document.createElement('i');
        warningIcon.className = 'fas fa-exclamation-triangle';
        const warningText = document.createElement('span');
        warningText.textContent = 'Changing models will start a new session. Your current conversation will be cleared.';
        warning.appendChild(warningIcon);
        warning.appendChild(warningText);
        content.appendChild(warning);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cancel-btn';
        cancelBtn.setAttribute('data-action', 'cancel');
        const cancelIcon = document.createElement('i');
        cancelIcon.className = 'fas fa-times';
        cancelBtn.appendChild(cancelIcon);
        cancelBtn.appendChild(document.createTextNode(' Keep Current Session'));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'confirm-btn';
        confirmBtn.setAttribute('data-action', 'confirm');
        const confirmIcon = document.createElement('i');
        confirmIcon.className = 'fas fa-check';
        confirmBtn.appendChild(confirmIcon);
        confirmBtn.appendChild(document.createTextNode(' Change Model & Start New'));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        modal.appendChild(header);
        modal.appendChild(content);
        modal.appendChild(actions);
        modalOverlay.appendChild(modal);

        document.body.appendChild(modalOverlay);

        // Add event listeners
        const handleAction = (action) => {
            if (action === 'confirm') {
                this.switchModel(newModel);
                this.createNewSession();
            } else {
                // Reset the dropdown to the current model
                this.modelSelect.value = currentModel;
                this.updateCustomDropdownDisplay(currentModel);
            }
            document.body.removeChild(modalOverlay);
        };

        modalOverlay.querySelector('.cancel-btn').addEventListener('click', () => handleAction('cancel'));
        modalOverlay.querySelector('.confirm-btn').addEventListener('click', () => handleAction('confirm'));
        modalOverlay.querySelector('.modal-close').addEventListener('click', () => handleAction('cancel'));

        // Close on overlay click
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                handleAction('cancel');
            }
        });

        // Close on Escape key
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                handleAction('cancel');
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
    }

    switchModel(newModel) {
        console.log('Model changed to:', newModel);
        // Update the model select value
        this.modelSelect.value = newModel;
        this.updateCustomDropdownDisplay(newModel);

        // Hide loader until actual conversation starts
        const statsElement = document.getElementById('conversationStats');
        if (statsElement) {
            statsElement.style.display = 'none';
        }

        // Reset conversation stats - loader will only show after real usage
        this.conversationStats = null;
    }

    getModelDisplayName(modelValue) {
        const modelNames = {
            'meta/llama-4-maverick-17b-128e-instruct': 'Llama 4 Maverick 17B',
            'deepseek-ai/deepseek-r1': 'DeepSeek R1',
            'qwen/qwen2.5-coder-32b-instruct': 'Qwen2.5 Coder 32B',
            'qwen/qwen3-coder-480b-a35b-instruct': 'Qwen3 Coder 480B',
            'deepseek-ai/deepseek-v3.1': 'DeepSeek V3.1',
            'openai/gpt-oss-120b': 'GPT-OSS 120B',
            'qwen/qwen3-235b-a22b:free': 'Qwen3 235B A22B',
            'google/gemma-3-27b-it:free': 'Gemma 3 27B IT',
            'deepseek-ai/deepseek-v3.2': 'DeepSeek V3.2',
            'moonshotai/kimi-k2-thinking': 'Kimi K2 Thinking'
        };
        return modelNames[modelValue] || modelValue;
    }
    updateCustomDropdownDisplay(modelValue) {
        const displayName = this.getModelDisplayName(modelValue);

        // Update the current model name in header
        if (this.currentModelName) {
            // this.currentModelName.textContent = displayName; // Keep "NVIDIA NIM" static
        }

        // Update selected state in dropdown options
        const options = document.querySelectorAll('.model-option');
        options.forEach(option => {
            option.classList.remove('selected');
            if (option.dataset.value === modelValue) {
                option.classList.add('selected');
            }
        });
    }

    initializeChatGPTUI() {
        // Get new element references
        this.modelSelector = document.getElementById('modelSelector');
        this.modelDropdown = document.getElementById('modelDropdown');
        this.sidebarLogoWrap = document.querySelector('.sidebar-logo-wrap');

        // Restore sidebar state (Default to Expanded on Desktop)
        if (this.sidebar) {
            const savedState = localStorage.getItem('sidebar_expanded');
            const isDesktop = window.innerWidth > 768;

            if (savedState === 'true' || (savedState === null && isDesktop)) {
                this.sidebar.classList.add('expanded');
            } else {
                this.sidebar.classList.remove('expanded');
            }
        }

        // Sidebar Toggle Button - collapse sidebar
        if (this.sidebarToggle) {
            this.sidebarToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sidebar?.classList.remove('expanded');
                localStorage.setItem('sidebar_expanded', 'false');
                // DEV_MODE: Also hide overlay on mobile
                this.sidebarOverlay?.classList.remove('active');
            });
        }

        // Click on sidebar logo area
        if (this.sidebarLogoWrap) {
            this.sidebarLogoWrap.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.sidebar?.classList.contains('expanded')) {
                    // Sidebar is open - open external link
                    window.open('https://antonjijo.github.io/Nvidia_NIM/', '_blank');
                } else {
                    // Sidebar is closed - expand it
                    this.sidebar?.classList.add('expanded');
                    localStorage.setItem('sidebar_expanded', 'true');
                }
            });
        }

        // Click anywhere on collapsed sidebar to expand (but not on action buttons)
        if (this.sidebar) {
            this.sidebar.addEventListener('click', (e) => {
                // Don't expand if clicking on action buttons or toggle
                const isMenuButton = e.target.closest('.sidebar-menu-item');
                const isToggleButton = e.target.closest('.sidebar-toggle-btn');
                const isLogoWrap = e.target.closest('.sidebar-logo-wrap');

                if (!this.sidebar.classList.contains('expanded') &&
                    !isMenuButton && !isToggleButton && !isLogoWrap) {
                    this.sidebar.classList.add('expanded');
                    localStorage.setItem('sidebar_expanded', 'true');
                }
            });
        }

        // Mobile menu button
        if (this.mobileMenuBtn) {
            this.mobileMenuBtn.addEventListener('click', () => {
                this.sidebar?.classList.add('expanded');
                this.sidebarOverlay?.classList.add('active');
            });
        }

        // Sidebar overlay click to close
        if (this.sidebarOverlay) {
            this.sidebarOverlay.addEventListener('click', () => {
                this.sidebar?.classList.remove('expanded');
                this.sidebarOverlay?.classList.remove('active');
            });
        }

        // New chat button
        if (this.newChatBtn) {
            this.newChatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showNewSessionDialog();
            });
        }

        // Model selector dropdown
        if (this.modelSelector) {
            this.modelSelector.addEventListener('click', (e) => {
                e.stopPropagation();
                this.modelSelector.classList.toggle('active');
                this.modelDropdown?.classList.toggle('active');
            });
        }

        // Close model dropdown on outside click
        document.addEventListener('click', (e) => {
            if (!this.modelSelector?.contains(e.target) && !this.modelDropdown?.contains(e.target)) {
                this.modelSelector?.classList.remove('active');
                this.modelDropdown?.classList.remove('active');
            }
        });

        // Model option selection
        const modelOptions = document.querySelectorAll('.model-option');
        modelOptions.forEach(option => {
            option.addEventListener('click', () => {
                const modelValue = option.dataset.value;
                if (modelValue) {
                    this.handleModelChange(modelValue);
                    this.modelSelector?.classList.remove('active');
                    this.modelDropdown?.classList.remove('active');
                }
            });
        });

        // Models Explorer setup
        this.setupModelsExplorer();
    }

    setupModelsExplorer() {
        const exploreBtn = document.getElementById('exploreModelsBtn');
        const overlay = document.getElementById('modelsExplorerOverlay');
        const backBtn = document.getElementById('modelsExplorerBack');
        const searchInput = document.getElementById('modelsSearchInput');
        const modelsGrid = document.getElementById('modelsGrid');

        if (!exploreBtn || !overlay) return;

        // Open Models Explorer
        exploreBtn.addEventListener('click', () => {
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
            // Close sidebar on mobile
            this.sidebar?.classList.remove('expanded');
            this.sidebarOverlay?.classList.remove('active');
        });

        // Close Models Explorer
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                overlay.classList.remove('active');
                document.body.style.overflow = '';
            });
        }

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                overlay.classList.remove('active');
                document.body.style.overflow = '';
            }
        });

        // Model card click - select model and go back to chat
        if (modelsGrid) {
            modelsGrid.addEventListener('click', (e) => {
                const card = e.target.closest('.model-card');
                if (card) {
                    const modelValue = card.dataset.model;
                    if (modelValue) {
                        this.handleModelChange(modelValue);
                        overlay.classList.remove('active');
                        document.body.style.overflow = '';
                    }
                }
            });
        }

        // Search functionality
        if (searchInput && modelsGrid) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase().trim();
                const cards = modelsGrid.querySelectorAll('.model-card');

                cards.forEach(card => {
                    const name = card.querySelector('h3')?.textContent?.toLowerCase() || '';
                    const provider = card.querySelector('.model-provider')?.textContent?.toLowerCase() || '';
                    const desc = card.querySelector('.model-desc')?.textContent?.toLowerCase() || '';

                    if (name.includes(query) || provider.includes(query) || desc.includes(query)) {
                        card.style.display = '';
                    } else {
                        card.style.display = 'none';
                    }
                });
            });
        }
    }

    setupGlobalScrolling() {
        // Setup smooth scrolling for chat messages
        if (this.chatMessages) {
            this.chatMessages.addEventListener('scroll', () => {
                // Could add scroll position tracking here if needed
            });
        }
    }

    setupSessionControls() {
        // Session controls are now handled by initializeChatGPTUI
        // This method is kept for compatibility
    }

    async loadInitialStats() {
        console.log('Loading initial conversation stats...');
        // Load conversation stats on page load
        const stats = await this.getConversationStats();
        console.log('Initial stats loaded:', stats);
        if (stats) {
            this.updateConversationStatsUI();
        }
    }

    showNewSessionDialog() {
        const currentStats = this.conversationStats;
        const currentModel = this.modelSelect.value;

        // Create modal overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-overlay';
        // Create modal content safely
        const modal = document.createElement('div');
        modal.className = 'confirmation-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'modal-header';
        const h3 = document.createElement('h3');
        h3.textContent = 'Start New Conversation Session';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.setAttribute('aria-label', 'Close');
        const closeIcon = document.createElement('i');
        closeIcon.className = 'fas fa-times';
        closeBtn.appendChild(closeIcon);
        header.appendChild(h3);
        header.appendChild(closeBtn);

        // Content
        const content = document.createElement('div');
        content.className = 'modal-content';

        const newSessionConfig = document.createElement('div');
        newSessionConfig.className = 'new-session-config';

        // Model selection section
        const modelSection = document.createElement('div');
        modelSection.className = 'model-selection-section';
        const modelH4 = document.createElement('h4');
        modelH4.textContent = 'Select AI Model';
        modelSection.appendChild(modelH4);

        const modelGrid = document.createElement('div');
        modelGrid.className = 'model-grid';

        const models = [
            { value: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', desc: 'Latest Meta model with enhanced reasoning' },
            { value: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', desc: 'Advanced reasoning and problem-solving' },
            { value: 'qwen/qwen2.5-coder-32b-instruct', name: 'Qwen2.5 Coder 32B', desc: 'Specialized for coding tasks' },
            { value: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', desc: 'Advanced coding and development' },
            { value: 'deepseek-ai/deepseek-v3.1', name: 'DeepSeek V3.1', desc: 'General purpose AI assistant' },
            { value: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT variant' },
            { value: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B A22B', desc: 'Free tier Qwen model' },
            { value: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B IT', desc: 'Google\'s instruction-tuned model' },
            { value: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Latest DeepSeek with thinking mode' },
            { value: 'moonshotai/kimi-k2-thinking', name: 'Kimi K2 Thinking', desc: 'Moonshot AI reasoning model' }
        ];

        models.forEach(model => {
            const option = document.createElement('div');
            option.className = 'model-option';
            option.setAttribute('data-model', model.value);

            const nameDiv = document.createElement('div');
            nameDiv.className = 'model-name';
            nameDiv.textContent = model.name;

            const descDiv = document.createElement('div');
            descDiv.className = 'model-description';
            descDiv.textContent = model.desc;

            option.appendChild(nameDiv);
            option.appendChild(descDiv);
            modelGrid.appendChild(option);
        });

        modelSection.appendChild(modelGrid);
        newSessionConfig.appendChild(modelSection);

        // Current session info (conditional)
        if (currentStats && currentStats.total_tokens > 0 && currentStats.current_model) {
            const currentInfo = document.createElement('div');
            currentInfo.className = 'current-session-info';
            const currentH4 = document.createElement('h4');
            currentH4.textContent = 'Current Session';
            currentInfo.appendChild(currentH4);

            const sessionSummary = document.createElement('div');
            sessionSummary.className = 'session-summary';

            const summaryData = [
                ['Model:', this.escapeHTML(this.getModelDisplayName(currentStats.current_model || currentModel))],
                ['Tokens Used:', currentStats.total_tokens.toLocaleString()],
                ['Utilization:', currentStats.utilization_percent + '%']
            ];

            summaryData.forEach(([label, value]) => {
                const item = document.createElement('div');
                item.className = 'summary-item';

                const labelSpan = document.createElement('span');
                labelSpan.className = 'summary-label';
                labelSpan.textContent = label;

                const valueSpan = document.createElement('span');
                valueSpan.className = 'summary-value';
                valueSpan.textContent = value;

                item.appendChild(labelSpan);
                item.appendChild(valueSpan);
                sessionSummary.appendChild(item);
            });

            currentInfo.appendChild(sessionSummary);

            const warning = document.createElement('div');
            warning.className = 'warning-notice';
            const warningIcon = document.createElement('i');
            warningIcon.className = 'fas fa-exclamation-triangle';
            const warningText = document.createElement('span');
            warningText.textContent = 'Starting a new session will clear your current conversation.';
            warning.appendChild(warningIcon);
            warning.appendChild(warningText);
            currentInfo.appendChild(warning);

            newSessionConfig.appendChild(currentInfo);
        }

        content.appendChild(newSessionConfig);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cancel-btn';
        cancelBtn.setAttribute('data-action', 'cancel');
        const cancelIcon = document.createElement('i');
        cancelIcon.className = 'fas fa-times';
        cancelBtn.appendChild(cancelIcon);
        cancelBtn.appendChild(document.createTextNode(' Cancel'));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'confirm-btn';
        confirmBtn.setAttribute('data-action', 'confirm');
        const confirmIcon = document.createElement('i');
        confirmIcon.className = 'fas fa-plus';
        confirmBtn.appendChild(confirmIcon);
        confirmBtn.appendChild(document.createTextNode(' Start New Session'));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        modal.appendChild(header);
        modal.appendChild(content);
        modal.appendChild(actions);
        modalOverlay.appendChild(modal);

        document.body.appendChild(modalOverlay);

        // Mark current model as selected
        const modelOptions = modalOverlay.querySelectorAll('.model-option');
        modelOptions.forEach(option => {
            if (option.dataset.model === currentModel) {
                option.classList.add('selected');
            }

            // Add click handler for model selection
            option.addEventListener('click', () => {
                modelOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
            });
        });

        // Add event listeners
        const handleAction = (action) => {
            if (action === 'confirm') {
                const selectedModelOption = modalOverlay.querySelector('.model-option.selected');
                const selectedModel = selectedModelOption ? selectedModelOption.dataset.model : currentModel;

                // Switch to selected model and create new session
                this.switchModel(selectedModel);
                this.createNewSession();
            }
            document.body.removeChild(modalOverlay);
        };

        modalOverlay.querySelector('.cancel-btn').addEventListener('click', () => handleAction('cancel'));
        modalOverlay.querySelector('.confirm-btn').addEventListener('click', () => handleAction('confirm'));
        modalOverlay.querySelector('.modal-close').addEventListener('click', () => handleAction('cancel'));

        // Close on overlay click
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                handleAction('cancel');
            }
        });

        // Close on Escape key
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                handleAction('cancel');
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
    }


    autoResizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height =
            Math.min(this.messageInput.scrollHeight, window.innerHeight * 0.4) + 'px';
    }

    updateCharCount() {
        const count = this.messageInput.value.length;
        this.charCount.textContent = `${count}/5000`;

        // Live token estimation for user feedback
        const estimatedTokens = this.estimateTokens(this.messageInput.value);

        // Update character count with token estimate
        if (estimatedTokens > 0) {
            this.charCount.textContent = `${count}/5000 (~${estimatedTokens} tokens)`;
        }

        if (count > 4500) {
            this.charCount.style.color = '#ef4444';
        } else if (count > 3500) {
            this.charCount.style.color = '#f59e0b';
        } else {
            this.charCount.style.color = '#6b7280';
        }

        if (count >= 5000) {
            this.sendButton.disabled = true;
            this.sendButton.style.opacity = '0.5';
            this.sendButton.style.cursor = 'not-allowed';
        } else {
            this.sendButton.disabled = false;
            this.sendButton.style.opacity = '1';
            this.sendButton.style.cursor = 'pointer';
        }
    }

    // Add client-side token estimation for live feedback
    estimateTokens(text) {
        if (!text || text.trim().length === 0) return 0;

        const words = text.split(/\s+/).filter(word => word.length > 0);
        const wordCount = words.length;
        const charCount = text.length;

        // Match backend estimation logic
        let estimatedTokens = Math.floor(wordCount * 2.2);

        // Special characters
        const specialChars = (text.match(/[^\w\s]/g) || []).length;
        estimatedTokens += Math.floor(specialChars / 2);

        // Long words
        const longWords = words.filter(word => word.length > 6).length;
        estimatedTokens += longWords;

        // Long text penalty
        if (charCount > 1000) {
            estimatedTokens += Math.floor(charCount / 40);
        }

        return Math.max(1, estimatedTokens);
    }

    validateUserInput(message, hasFile) {
        if (!hasFile && message.length === 0) {
            return { isValid: false, error: 'Please enter a message' };
        }

        // Basic Length Check (Client-side)
        if (message.length > 5000) {
            return { isValid: false, error: 'Message matches character limit (5000)' };
        }

        // Suspicious Pattern Check (Client-side)
        const suspiciousPatterns = ['<script>', 'javascript:', 'data:text/html'];
        if (suspiciousPatterns.some(pattern => message.toLowerCase().includes(pattern))) {
            return { isValid: false, error: 'Invalid input detected' };
        }

        return { isValid: true };
    }

    isImageFile(file) {
        if (!file) return false;
        const allowedImageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff'];
        // Also check by extension as backup if type is empty/generic
        const ext = file.name.split('.').pop().toLowerCase();
        const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff'];
        return allowedImageTypes.includes(file.type) || imageExts.includes(ext);
    }

    showTypingIndicator() {
        if (this.isTyping) return;
        this.isTyping = true;

        const typingDiv = document.createElement('div');
        typingDiv.className = 'message bot-message typing-indicator-container';
        typingDiv.id = 'typingIndicator';
        typingDiv.innerHTML = `
             <div class="message-content">
                 <div class="typing-indicator">
                     <span></span>
                     <span></span>
                     <span></span>
                 </div>
             </div>
         `;
        this.chatMessages.appendChild(typingDiv);
        this.scrollToBottom();
    }

    showAnalyzingIndicator(type) {
        if (this.isAnalyzing) return;
        this.isAnalyzing = true;
        this.isTyping = true; // functionally similar

        const analyzingDiv = document.createElement('div');
        analyzingDiv.className = 'message bot-message';
        analyzingDiv.id = 'analyzingIndicator';

        let icon = 'fa-file-alt';
        let text = 'Processing...';

        if (type === 'image') {
            icon = 'fa-image';
            text = 'Analyzing image...';
        } else if (type === 'file') {
            icon = 'fa-file-alt';
            text = 'Analyzing file...';
        } else if (type === 'web') {
            icon = 'fa-globe';
            text = 'Searching the web...';
        } else if (type === 'wiki') {
            icon = 'fa-globe';
            text = 'Searching Wiki web...';
        }

        // Add message-inner wrapper to center it properly
        analyzingDiv.innerHTML = `
            <div class="message-inner">
                <div class="message-content" style="display:flex; align-items:center; gap:10px;">
                    <div class="typing-indicator" style="margin:0;">
                         <span></span>
                         <span></span>
                         <span></span>
                    </div>
                    <span class="analyzing-text" style="font-weight:500; color:var(--text-secondary);">
                        <i class="fas ${icon}" style="margin-right:5px;"></i> ${text}
                    </span>
                </div>
            </div>
        `;
        this.chatMessages.appendChild(analyzingDiv);
        this.scrollToBottom();
    }

    hideAnalyzingIndicator() {
        const indicator = document.getElementById('analyzingIndicator');
        if (indicator) {
            indicator.remove();
        }
        this.isAnalyzing = false;
        this.isTyping = false;
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.remove();
        }
        this.isTyping = false;
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        const hasFile = !!this.selectedFile;

        // Allow sending if there is a message OR a file
        if ((!message && !hasFile) || this.isLoading) return;

        // Client-side input validation
        const validationResult = this.validateUserInput(message, hasFile);
        if (!validationResult.isValid) {
            this.showErrorPopup(validationResult.error);
            return;
        }

        // Add user message (if text exists, or just show file icon if no text?)
        // If text is empty but file exists, we usually still want to show a user bubble indicating the file was sent
        // Add user messages to chat
        if (hasFile) {
            this.addFileMessage(this.selectedFile, 'user');
        }

        if (message) {
            this.addMessage(message, 'user');
        }

        this.messageInput.value = '';
        this.updateCharCount();
        this.autoResizeTextarea();

        // Set loading state to enable typing animation
        this.isLoading = true;

        // Determine analysis type for UI feedback
        let analysisType = null;
        if (hasFile) {
            analysisType = this.isImageFile(this.selectedFile) ? 'image' : 'file';
        }

        // Show specific analyzing/typing indicator
        if (analysisType) {
            this.showAnalyzingIndicator(analysisType);
        } else {
            this.showTypingIndicator();

            // Check for Web Search Requirement (Non-blocking / Parallel)
            if (message && message.length > 5) {
                (async () => {
                    try {
                        const servers = [
                            'https://nvidia-nim-bot.onrender.com',
                            'https://Nvidia.pythonanywhere.com'
                        ];
                        const serverURL = servers[0];

                        const checkResp = await fetch(`${serverURL}/api/classify`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ message: message })
                        });

                        if (checkResp.ok) {
                            const checkData = await checkResp.json();
                            // Only switch to 'Searching' if still waiting for response (isLoading is true)
                            // and the typing indicator is still active (hasn't been removed by error or success)
                            if (checkData.web_required && this.isLoading && document.getElementById('typingIndicator')) {
                                this.hideTypingIndicator();
                                this.showAnalyzingIndicator('wiki');
                            }
                        }
                    } catch (e) {
                        console.warn('Intent check failed', e);
                    }
                })();
            }
        }

        try {
            const response = await this.callNvidiaAPI(message);

            // Keep isLoading true for typing animation
            // The typeMessage function will set it to false when typing completes
            this.addMessageWithTyping(response, 'bot');
        } catch (error) {
            // Always show the same generic error message to users
            // Log the actual error details for developers (in console only)
            console.error('Chat API Error:', error);

            // Reset loading state
            this.isLoading = false;

            // Show generic user-friendly error
            this.showErrorMessage(error.message || 'Unknown error occurred');
        } finally {
            if (this.selectedFile) {
                this.removeFile();
            }
            // Clear extracted text content
            this.selectedFileContent = null;
        }
    }

    showErrorMessage(errorText) {
        // Always hide any loading indicators first
        this.hideTypingIndicator();
        this.hideAnalyzingIndicator();

        // Hide welcome screen
        this.hideWelcomeScreen();

        // Create compact error message container - positioned like a normal bot message
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message bot-message';

        const errorInner = document.createElement('div');
        errorInner.className = 'message-inner';
        errorInner.style.cssText = 'background: rgba(239, 68, 68, 0.1); border-left: 4px solid #ef4444; padding: 0.75rem 1rem; border-radius: 6px;';

        const errorContent = document.createElement('div');
        errorContent.className = 'message-content';
        errorContent.style.cssText = 'color: #ef4444; font-weight: 500; display: flex; align-items: center; gap: 0.5rem; font-size: 14px;';
        errorContent.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <span>An error occurred on the server. Please create an issue in the repository for further assistance.</span>
        `;

        errorInner.appendChild(errorContent);
        errorDiv.appendChild(errorInner);
        this.chatMessages.appendChild(errorDiv);
        this.scrollToBottom();

        // Update status
        this.updateStatus('Error', '#ef4444');

        // Log the actual error details for debugging (hidden from user)
        console.error('Server error occurred:', errorText);
    }

    updateAnalyzingIndicatorWithError(message) {
        const indicator = document.getElementById('analyzingIndicator');
        if (indicator) {
            const contentDiv = indicator.querySelector('.message-content');
            if (contentDiv) {
                // Replace typing dots and text with error icon and message
                contentDiv.innerHTML = `
                    <span class="analyzing-text" style="font-weight:500; color:#ef4444;">
                        <i class="fas fa-times-circle" style="margin-right:5px;"></i> Failed: ${message}
                    </span>
                `;
            }
            // Remove pulsing animation class if present
            const textSpan = indicator.querySelector('.analyzing-text');
            if (textSpan) textSpan.classList.remove('analyzing-text');

            // Auto-remove after 5 seconds
            setTimeout(() => {
                if (indicator && indicator.parentNode) {
                    indicator.remove();
                }
            }, 5000);
        }
    }

    async callNvidiaAPI(message) {
        const selectedModel = this.modelSelect.value;

        // Define server URLs for Production
        const servers = [
            'https://nvidia-nim-bot.onrender.com',
            'https://Nvidia.pythonanywhere.com'
        ];

        let lastError = null;

        // Try each server in sequence until one works
        for (let i = 0; i < servers.length; i++) {
            const serverURL = servers[i];

            try {
                console.log(`Attempting to connect to server ${i + 1}/${servers.length}: ${serverURL}`);

                let options = {
                    method: 'POST',
                    timeout: 60000 // Increased timeout for file processing
                };

                // Check if we have text content extracted from a text file
                const hasTextFileContent = this.selectedFile && this.selectedFileContent;

                if (this.selectedFile && !hasTextFileContent) {
                    // Image file - use multipart form data
                    const formData = new FormData();
                    formData.append('message', message);
                    formData.append('model', selectedModel);
                    formData.append('session_id', this.sessionId);
                    formData.append('file', this.selectedFile);


                    // Fetch will automatically set the Content-Type to multipart/form-data with boundary
                    options.body = formData;
                } else {
                    // Text-only OR text file with extracted content
                    options.headers = { 'Content-Type': 'application/json' };

                    let finalMessage = message;

                    // If we have extracted text content from a file, prepend it to the message
                    if (hasTextFileContent) {
                        const fileName = this.selectedFile.name;
                        finalMessage = `User uploaded a file: ${fileName}\n\nFile content:\n\`\`\`\n${this.selectedFileContent}\n\`\`\`\n\nUser question: ${message || 'Analyze this file'}`;
                    }

                    options.body = JSON.stringify({
                        message: finalMessage,
                        model: selectedModel,
                        session_id: this.sessionId,

                        max_tokens: 1024,
                        temperature: 0.7
                    });
                }

                const response = await fetch(`${serverURL}/api/chat`, options);

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                if (!data.response && !data.message) {
                    if (data.error) throw new Error(data.error);
                    throw new Error('Invalid response from server');
                }

                const botResponse = data.response || data.message;
                if (botResponse.includes("Hello! I'm your NVIDIA-powered chatbot with advanced capabilities")) {
                    throw new Error('NVIDIA API returned unexpected response. Please check API configuration.');
                }

                // Update conversation stats if available
                if (data.conversation_stats) {
                    console.log('Received conversation stats:', data.conversation_stats);
                    this.conversationStats = data.conversation_stats;

                    // Immediate UI update with animation
                    this.updateConversationStatsUI(true);

                    // Force refresh stats after a short delay to ensure accuracy
                    setTimeout(() => {
                        this.refreshConversationStats();
                    }, 500);
                } else {
                    console.warn('No conversation stats received from server');
                }

                // Success! Update status and return response
                let serverName = 'Local';
                try {
                    const urlObj = new URL(serverURL);
                    const hostname = urlObj.hostname;
                    if (hostname === 'render.com' || hostname.endsWith('.render.com')) {
                        serverName = 'Primary';
                    } else if (hostname === 'pythonanywhere.com' || hostname.endsWith('.pythonanywhere.com')) {
                        serverName = 'Failover';
                    }
                } catch (e) {
                    // If invalid URL, keep serverName as 'Local'
                }
                this.updateStatus(`Connected (${serverName})`, '#4ade80');
                console.log(`Successfully connected to ${serverName} server: ${serverURL}`);

                return botResponse;

            } catch (error) {
                console.warn(`Server ${i + 1} failed (${serverURL}):`, error.message);
                lastError = error;

                // If this isn't the last server, continue to next one
                if (i < servers.length - 1) {
                    console.log(`Trying next server...`);
                    continue;
                }
            }
        }

        // All servers failed
        this.updateStatus('Connection Failed', '#ef4444');
        console.error('All servers failed. Last error:', lastError);
        throw lastError || new Error('All servers are unavailable');
    }

    updateModelInfo() {
        const selectedModel = this.modelSelect.value;
        const modelNames = {
            'meta/llama-4-maverick-17b-128e-instruct': 'Llama 4 Maverick',
            'deepseek-ai/deepseek-r1': 'DeepSeek R1'
        };
    }

    addMessage(content, sender, save = true) {
        // Store message in memory
        if (save) {
            this.messages.push({ role: sender, content: content });
            // Save to local storage if enabled
            if (window.chatSaver) window.chatSaver.saveCurrentChat();
        }

        // Hide welcome screen when first message is sent
        this.hideWelcomeScreen();

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;

        if (sender === 'user') {
            // User message - simple pill bubble
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = content;

            // Action buttons (Copy only)
            const actions = document.createElement('div');
            actions.className = 'message-actions user-actions';
            actions.innerHTML = `
                <button class="action-btn copy-action" title="Copy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
            `;

            messageDiv.appendChild(actions);
            messageDiv.appendChild(bubble);

            this.attachActionListeners(actions, content);
        } else {
            // Bot message - plain text with actions
            const inner = document.createElement('div');
            inner.className = 'message-inner';

            const messageContent = document.createElement('div');
            messageContent.className = 'message-content';
            this.safeSetHTML(messageContent, this.processMessageContent(content));

            // Action buttons
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            actions.innerHTML = `
                <button class="action-btn copy-action" title="Copy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button class="action-btn" title="Good response">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                    </svg>
                </button>
                <button class="action-btn" title="Bad response">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                    </svg>
                </button>
            `;

            inner.appendChild(messageContent);
            inner.appendChild(actions);
            messageDiv.appendChild(inner);

            this.attachCopyListeners(messageContent);
            this.attachActionListeners(actions, content);
        }

        // Append message to chat if sender is user 
        // (Bot messages often need typing animation so they are appended separately or returned)
        if (sender === 'user') {
            this.chatMessages.appendChild(messageDiv);
            this.scrollToBottom();
        }
        return messageDiv;
    }

    addFileMessage(file, sender) {
        // Store message in memory
        this.messages.push({ role: sender, content: `[File Uploaded: ${file.name}]` });
        // Save to local storage if enabled
        if (window.chatSaver) window.chatSaver.saveCurrentChat();

        this.hideWelcomeScreen();

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message file-message`;
        messageDiv.style.justifyContent = 'flex-end'; // User files align right

        if (this.isImageFile(file)) {
            // Image Preview Card
            const imgContainer = document.createElement('div');
            imgContainer.className = 'user-image-container';
            imgContainer.style.maxWidth = '300px';
            imgContainer.style.borderRadius = '12px';
            imgContainer.style.overflow = 'hidden';
            imgContainer.style.cursor = 'pointer';
            imgContainer.style.border = '1px solid var(--border-light)';

            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.onload = () => { URL.revokeObjectURL(img.src); }; // Clean up memory
            img.alt = file.name;
            img.style.width = '100%';
            img.style.display = 'block';

            imgContainer.onclick = () => this.openImagePreview(file);

            imgContainer.appendChild(img);
            messageDiv.appendChild(imgContainer);
        } else {
            // File Icon Card
            const card = document.createElement('div');
            card.className = 'user-file-card';
            card.style.display = 'flex';
            card.style.alignItems = 'center';

            card.innerHTML = `
                <div style="background:rgba(255,255,255,0.1); padding:10px; border-radius:8px; margin-right:12px;">
                    <i class="fas fa-file-alt" style="font-size:20px;"></i>
                </div>
                <div>
                    <div style="font-weight:600; font-size:14px;">${this.escapeHTML(file.name)}</div>
                    <div style="font-size:12px; opacity:0.7;">${this.formatFileSize(file.size)}</div>
                </div>
            `;
            messageDiv.appendChild(card);
        }

        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    attachActionListeners(actionsEl, content) {
        // Copy button
        const copyBtn = actionsEl.querySelector('.copy-action');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                // Render markdown to HTML then get text content to strip markdown syntax
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = this.renderMarkdown(content);
                const plainText = tempDiv.innerText;

                navigator.clipboard.writeText(plainText).then(() => {
                    copyBtn.classList.add('copied');
                    setTimeout(() => copyBtn.classList.remove('copied'), 2000);
                });
            });

            // Like button
            const likeBtn = actionsEl.querySelector('button[title="Good response"]');
            if (likeBtn) {
                likeBtn.addEventListener('click', () => {
                    likeBtn.classList.toggle('active');
                    if (likeBtn.classList.contains('active')) {
                        // Disable dislike if active
                        const dislikeBtn = actionsEl.querySelector('button[title="Bad response"]');
                        if (dislikeBtn) dislikeBtn.classList.remove('active');
                        console.log('User liked the response');
                    }
                });
            }

            // Dislike button
            const dislikeBtn = actionsEl.querySelector('button[title="Bad response"]');
            if (dislikeBtn) {
                dislikeBtn.addEventListener('click', () => {
                    dislikeBtn.classList.toggle('active');
                    if (dislikeBtn.classList.contains('active')) {
                        // Disable like if active
                        const likeBtn = actionsEl.querySelector('button[title="Good response"]');
                        if (likeBtn) likeBtn.classList.remove('active');
                        console.log('User disliked the response');
                    }
                });
            }
        }
    }

    addMessageWithTyping(content, sender, save = true) {
        // Store message in memory
        if (save) {
            this.messages.push({ role: sender, content: content });
            // Save to local storage if enabled
            if (window.chatSaver) window.chatSaver.saveCurrentChat();
        }

        // Hide welcome screen when message is added
        this.hideWelcomeScreen();

        // Remove the typing/analyzing indicator element if it exists
        const typingIndicator = document.getElementById('typingIndicator');
        const analyzingIndicator = document.getElementById('analyzingIndicator');
        if (typingIndicator) typingIndicator.remove();
        if (analyzingIndicator) analyzingIndicator.remove();

        // Always add the message properly, whether loading or stopped
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;

        // Bot message - plain text with actions
        const inner = document.createElement('div');
        inner.className = 'message-inner';

        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = '<p></p>';

        inner.appendChild(messageContent);
        messageDiv.appendChild(inner);

        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();

        // If generation was stopped, show content immediately without typing
        if (!this.isLoading) {
            this.displayMessageInstantly(content, messageContent, inner);
        } else {
            // Otherwise, use typing animation
            this.typeMessage(content, messageContent, messageDiv, inner);
        }
    }

    displayMessageInstantly(content, messageContent, inner) {
        // Display message content immediately with proper processing
        messageContent.innerHTML = this.renderMarkdown(content);

        // Add action buttons if they don't exist
        if (inner && !inner.querySelector('.message-actions')) {
            this.addMessageActions(inner, content);
        }

        this.scrollToBottom();
        this.messages.push({ role: 'assistant', content });
    }

    addMessageActions(inner, content) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `
        <button class="action-btn copy-action" title="Copy">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
        </button>
            <button class="action-btn" title="Good response">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                </svg>
            </button>
            <button class="action-btn" title="Bad response">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                </svg>
            </button>
`;
        inner.appendChild(actions);
        this.attachActionListeners(actions, content);
    }



    async typeMessage(content, messageContent, messageDiv, inner) {
        let currentText = '';
        let currentIndex = 0;

        messageContent.innerHTML = ''; // Start empty

        // Use a faster interval for smoother typing
        this.currentTypingInterval = setInterval(() => {
            if (!this.isLoading) {
                clearInterval(this.currentTypingInterval);
                this.currentTypingInterval = null;
                // Final render
                messageContent.innerHTML = this.renderMarkdown(content);
                // Re-attach copy listeners if needed (though onclick handles it now)
                this.scrollToBottom();
                return;
            }

            // Chunk size
            const charsPerTick = 5;
            for (let i = 0; i < charsPerTick && currentIndex < content.length; i++) {
                currentText += content[currentIndex];
                currentIndex++;
            }

            messageContent.innerHTML = this.renderMarkdown(currentText);
            this.scrollToBottom();

            if (currentIndex >= content.length) {
                clearInterval(this.currentTypingInterval);
                this.currentTypingInterval = null;
                this.isLoading = false; // Reset loading state when typing completes
                this.messages.push({ role: 'assistant', content });
                this.hideTypingIndicator();

                // Add action buttons after typing is complete
                if (inner && !inner.querySelector('.message-actions')) {
                    this.addMessageActions(inner, content);
                }
            }
        }, 10);
    }

    async typeCodeBlockContent(content, messageContent, messageDiv, processedContent) {
        console.log('Processing code block:', { content: content.substring(0, 50) + '...', processedContentLength: processedContent.length });

        // Show the complete structure immediately (header, etc.)
        this.safeSetHTML(messageContent, processedContent);

        console.log('Message content after setting HTML:', messageContent.innerHTML.substring(0, 200) + '...');

        // Extract ALL code blocks from content
        const codeBlockRegex = /```(\w +) ?\s *\n ? ([\s\S] *?)```/g;
        const codeBlocks = [];
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            const language = match[1] || 'text';
            const code = match[2].trim();
            codeBlocks.push({ language, code });
        }

        if (codeBlocks.length === 0) {
            console.log('No code blocks found, falling back to regular text');
            this.typeRegularText(content, messageContent, messageDiv, processedContent);
            return;
        }

        console.log('Found', codeBlocks.length, 'code blocks');

        // Find all content containers to type into
        const contentContainers = messageContent.querySelectorAll('.code-content');

        console.log('Content containers found:', { count: contentContainers.length });

        if (contentContainers.length === 0) {
            console.log('No containers found, keeping as-is');
            this.attachCopyListeners(messageContent);
            this.hideTypingIndicator();
            this.messages.push({ role: 'assistant', content });
            return;
        }

        // Clear all containers and prepare for typing
        contentContainers.forEach(container => {
            container.textContent = '';
        });

        // Type into each code block sequentially
        await this.typeMultipleCodeBlocks(codeBlocks, contentContainers, messageContent, content);
    }

    async typeMultipleCodeBlocks(codeBlocks, contentContainers, messageContent, originalContent) {
        let currentBlockIndex = 0;

        const typeNextBlock = () => {
            if (currentBlockIndex >= codeBlocks.length || currentBlockIndex >= contentContainers.length) {
                // All blocks completed
                console.log('All code blocks completed');
                this.attachCopyListeners(messageContent);
                this.scrollToBottom();
                this.hideTypingIndicator();
                this.messages.push({ role: 'assistant', content: originalContent });
                return;
            }

            const codeBlock = codeBlocks[currentBlockIndex];
            const container = contentContainers[currentBlockIndex];

            console.log(`Typing block ${currentBlockIndex + 1}/${codeBlocks.length}:`, {
                language: codeBlock.language,
                codeLength: codeBlock.code.length
            });

            // Type this block
            let currentText = '';
            let currentIndex = 0;

            this.currentTypingInterval = setInterval(() => {
                if (!this.isLoading) {
                    clearInterval(this.currentTypingInterval);
                    this.currentTypingInterval = null;
                    return;
                }

                if (currentIndex < codeBlock.code.length) {
                    currentText += codeBlock.code[currentIndex];
                    currentIndex++;
                    container.textContent = currentText;
                    this.scrollToBottom();
                } else {
                    clearInterval(this.currentTypingInterval);
                    this.currentTypingInterval = null;

                    // Apply syntax highlighting when this block is complete
                    console.log(`Applying syntax highlighting for block ${currentBlockIndex + 1}, language:`, codeBlock.language);
                    this.applySafeHighlighting(container, codeBlock.language);

                    // Move to next block
                    currentBlockIndex++;

                    // Small delay before starting next block
                    setTimeout(() => {
                        typeNextBlock();
                    }, 100);
                }
            }, 3);
        };

        // Start typing the first block
        typeNextBlock();
    }

    async typeRegularText(content, messageContent, messageDiv, processedContent) {
        // For regular text (no code blocks), just type the text content without re-processing
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = processedContent;
        const textContent = tempDiv.textContent || tempDiv.innerText || '';

        messageContent.innerHTML = '<p></p>';

        let currentText = '';
        let currentIndex = 0;

        this.currentTypingInterval = setInterval(() => {
            if (!this.isLoading) {
                clearInterval(this.currentTypingInterval);
                this.currentTypingInterval = null;
                if (messageDiv && messageDiv.parentNode) {
                    messageDiv.remove();
                }
                return;
            }

            if (currentIndex < textContent.length) {
                currentText += textContent[currentIndex];
                currentIndex++;
                // Simply update text content, don't reprocess HTML
                const p = document.createElement('p');
                p.textContent = currentText;
                messageContent.innerHTML = '';
                messageContent.appendChild(p);
                this.scrollToBottom();
            } else {
                clearInterval(this.currentTypingInterval);
                this.currentTypingInterval = null;
                // Show the final processed content
                this.safeSetHTML(messageContent, processedContent);
                this.attachCopyListeners(messageContent);
                this.scrollToBottom();

                this.hideTypingIndicator();
                this.messages.push({ role: 'assistant', content });
            }
        }, 3);
    }

    getTypingDelay(char) {
        // Realistic typing delays
        switch (char) {
            case '\n': return 200; // Pause at line breaks
            case '.': case '!': case '?': return 150; // Pause at sentence endings
            case ',': case ';': case ':': return 100; // Pause at punctuation
            case ' ': return 50; // Slight pause at spaces
            case '(': case ')': case '[': case ']': case '{': case '}': return 80;
            default: return Math.random() < 0.1 ? 60 : 15; // Occasional hesitation
        }
    }
    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    safeSetHTML(element, html) {
        element.innerHTML = html;
    }

    isImageFile(file) {
        return file.type.startsWith('image/');
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    getLanguageDisplayName(language) {
        const displayNames = {
            'js': 'JavaScript',
            'ts': 'TypeScript',
            'py': 'Python',
            'cpp': 'C++',
            'c': 'C',
            'cs': 'C#',
            'rb': 'Ruby',
            'rs': 'Rust',
            'sh': 'Shell',
            'yml': 'YAML',
            'md': 'Markdown',
            'jsx': 'React JSX',
            'tsx': 'React TSX'
        };
        return displayNames[language.toLowerCase()] || language.charAt(0).toUpperCase() + language.slice(1);
    }

    processMessageContent(content) {
        return this.renderMarkdown(content);
    }

    attachCopyListeners(messageContent) {
        const copyButtons = messageContent.querySelectorAll('.copy-button');
        copyButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Handle both button and icon clicks
                const actualButton = e.target.closest('.copy-button');
                const codeId = actualButton.getAttribute('data-code-id');
                const codeElement = document.getElementById(codeId);

                if (codeElement) {
                    this.copyToClipboard(codeElement.textContent, actualButton);
                }
            });
        });
    }

    async copyToClipboard(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            const copyText = button.querySelector('.copy-text');
            const copyIcon = button.querySelector('i');

            // Update button appearance
            if (copyText) copyText.textContent = 'Copied!';
            if (copyIcon) {
                copyIcon.className = 'fas fa-check';
            }
            button.classList.add('copied');

            setTimeout(() => {
                if (copyText) copyText.textContent = 'Copy';
                if (copyIcon) {
                    copyIcon.className = 'fas fa-copy';
                }
                button.classList.remove('copied');
            }, 2000);
        } catch (err) {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);

            const copyText = button.querySelector('.copy-text');
            const copyIcon = button.querySelector('i');

            if (copyText) copyText.textContent = 'Copied!';
            if (copyIcon) {
                copyIcon.className = 'fas fa-check';
            }
            button.classList.add('copied');

            setTimeout(() => {
                if (copyText) copyText.textContent = 'Copy';
                if (copyIcon) {
                    copyIcon.className = 'fas fa-copy';
                }
                button.classList.remove('copied');
            }, 2000);
        }
    }

    showTypingIndicator() {
        this.isLoading = true;
        this.sendButton.disabled = false;
        this.updateStatus('Typing...', '#f59e0b');
        this.updateSendButtonToStop();
        this.disableModelSelection();

        // Hide welcome screen
        this.hideWelcomeScreen();

        const typingDiv = document.createElement('div');
        typingDiv.className = 'message bot-message';
        typingDiv.id = 'typingIndicator';

        const inner = document.createElement('div');
        inner.className = 'message-inner';

        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'typing-indicator';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'typing-dot';
            typingIndicator.appendChild(dot);
        }

        inner.appendChild(typingIndicator);
        typingDiv.appendChild(inner);

        this.chatMessages.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        this.isLoading = false;
        this.sendButton.disabled = false;
        this.updateStatus('Ready', '#4ade80');
        this.updateSendButtonToNormal();
        this.enableModelSelection();

        const typingIndicator = document.getElementById('typingIndicator');
        if (typingIndicator) typingIndicator.remove();
    }

    animateTokenDisplay(element, start, end) {
        const duration = 1000;
        const startTime = performance.now();
        const range = end - start;

        const update = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease out expo
            const ease = 1 - Math.pow(2, -10 * progress);

            const currentVal = Math.floor(start + (range * ease));

            const displayVal = currentVal > 999 ? `${(currentVal / 1000).toFixed(1)}K` : currentVal;
            element.textContent = displayVal;

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                const finalVal = end > 999 ? `${(end / 1000).toFixed(1)}K` : end;
                element.textContent = finalVal;
            }
        };

        requestAnimationFrame(update);
    }

    updateConversationStatsUI(animate = false) {
        console.log('updateConversationStatsUI called with stats:', this.conversationStats);

        if (!this.conversationStats) {
            // Treat as 0 tokens instead of hiding completely to allow animation
            // console.log('No conversation stats available, defaulting to 0');
        }

        const stats = this.conversationStats || { total_tokens: 0, max_tokens: 128000, utilization_percent: 0, current_model: null };
        const { total_tokens, displayed_tokens, max_tokens, utilization_percent, current_model } = stats;
        // Use displayed_tokens (user content only) if available, otherwise total
        const tokensToDisplay = displayed_tokens !== undefined ? displayed_tokens : total_tokens;

        console.log('Stats details:', { total_tokens, displayed_tokens, max_tokens, utilization_percent, current_model });

        // DEV_MODE: Update header context info
        if (this.contextInfo && this.contextValue) {
            this.contextInfo.style.display = 'flex';

            const startTokens = this.currentStatsTokens || 0;
            const endTokens = tokensToDisplay || 0;
            this.currentStatsTokens = endTokens;

            if (animate && startTokens !== endTokens) {
                this.animateTokenDisplay(this.contextValue, startTokens, endTokens);
            } else {
                const contextDisplay = endTokens > 999 ? `${(endTokens / 1000).toFixed(1)}K` : endTokens;
                this.contextValue.textContent = contextDisplay;
            }

            // Optional: Color code based on utilization
            if (utilization_percent > 80) this.contextValue.style.color = '#ef4444';
            else if (utilization_percent > 60) this.contextValue.style.color = '#f59e0b';
            else this.contextValue.style.color = ''; // remove inline style to use CSS default
        }

        // Show loader even with 0 tokens if we have valid stats and a model
        // This allows users to see that stats tracking is working
        if (!current_model) {
            console.log('No current model, hiding stats');
            const statsElement = document.getElementById('conversationStats');
            if (statsElement) {
                statsElement.style.display = 'none';
            }
            return;
        }

        // Create or update stats display
        let statsElement = document.getElementById('conversationStats');
        if (!statsElement) {
            statsElement = document.createElement('div');
            statsElement.id = 'conversationStats';
            statsElement.className = 'conversation-stats';

            // Insert after the model info in the footer
            const modelInfo = document.getElementById('modelInfo');
            if (modelInfo) {
                modelInfo.parentNode.insertBefore(statsElement, modelInfo.nextSibling);
            }
        }

        // Show the stats element
        statsElement.style.display = 'block';

        // Determine colors based on utilization
        const utilizationColor = utilization_percent > 80 ? '#ef4444' :
            utilization_percent > 60 ? '#f59e0b' : '#4ade80';

        const tokenDisplay = total_tokens > 999 ?
            `${(total_tokens / 1000).toFixed(1)}K` :
            total_tokens.toLocaleString();

        const maxTokenDisplay = max_tokens > 999 ?
            `${(max_tokens / 1000).toFixed(0)}K` :
            max_tokens.toLocaleString();

        // Create small loader with percentage on the right safely
        const container = document.createElement('div');
        container.className = 'context-loader-container';

        const loader = document.createElement('div');
        loader.className = 'small-loader';
        loader.setAttribute('data-tooltip', `Tokens: ${tokenDisplay}/${maxTokenDisplay} | Model: ${this.getModelDisplayName(current_model)}`);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'loader-circle');
        svg.setAttribute('viewBox', '0 0 20 20');

        const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        bgCircle.setAttribute('class', 'loader-bg');
        bgCircle.setAttribute('cx', '10');
        bgCircle.setAttribute('cy', '10');
        bgCircle.setAttribute('r', '8');
        bgCircle.setAttribute('fill', 'none');
        bgCircle.setAttribute('stroke', 'rgba(76, 175, 80, 0.2)');
        bgCircle.setAttribute('stroke-width', '2');

        const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        progressCircle.setAttribute('class', 'loader-progress');
        progressCircle.setAttribute('cx', '10');
        progressCircle.setAttribute('cy', '10');
        progressCircle.setAttribute('r', '8');
        progressCircle.setAttribute('fill', 'none');
        progressCircle.setAttribute('stroke', utilizationColor);
        progressCircle.setAttribute('stroke-width', '2');
        progressCircle.setAttribute('stroke-linecap', 'round');
        progressCircle.style.strokeDasharray = 2 * Math.PI * 8;
        progressCircle.style.strokeDashoffset = 2 * Math.PI * 8 * (1 - utilization_percent / 100);
        progressCircle.style.transform = 'rotate(-90deg)';
        progressCircle.style.transformOrigin = 'center';
        if (animate) {
            progressCircle.style.transition = 'stroke-dashoffset 0.8s ease-in-out';
        }

        svg.appendChild(bgCircle);
        svg.appendChild(progressCircle);
        loader.appendChild(svg);

        const percentage = document.createElement('span');
        percentage.className = 'loader-percentage';
        percentage.style.color = utilizationColor;
        if (animate) {
            percentage.style.transition = 'color 0.3s ease';
        }
        percentage.textContent = utilization_percent + '%';

        container.appendChild(loader);
        container.appendChild(percentage);

        // Clear and append safely
        while (statsElement.firstChild) {
            statsElement.removeChild(statsElement.firstChild);
        }
        statsElement.appendChild(container);

        // Apply enhanced styling for the loader
        statsElement.style.cssText = `
            margin-top: 0.5rem;
            font-size: 0.8rem;
            color: #9ca3af;
            font-family: 'JetBrains Mono', monospace;
            background: rgba(76, 175, 80, 0.05);
            border: 1px solid rgba(76, 175, 80, 0.2);
            border-radius: 8px;
            padding: 8px 12px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            transition: all 0.3s ease;
            position: relative;
            display: block;
        `;

        // Add hover effect for glassmorphism enhancement
        statsElement.addEventListener('mouseenter', () => {
            statsElement.style.borderColor = 'rgba(76, 175, 80, 0.4)';
            statsElement.style.background = 'rgba(76, 175, 80, 0.08)';
        });

        statsElement.addEventListener('mouseleave', () => {
            statsElement.style.borderColor = 'rgba(76, 175, 80, 0.2)';
            statsElement.style.background = 'rgba(76, 175, 80, 0.05)';
        });
    }

    // Force refresh conversation stats from server
    async refreshConversationStats() {
        const stats = await this.getConversationStats();
        if (stats) {
            console.log('Refreshed stats from server:', stats);
            this.updateConversationStatsUI(true);
        }
    }

    updateStatus(text, color) {
        // map color codes to tailwind classes
        const isGreen = color === '#4ade80'; // emerald-400/500
        const isAmber = color === '#f59e0b'; // amber-400/500
        const isRed = color === '#ef4444';   // red-400/500

        // update hover tooltip/title with current status
        if (this.statusPing) {
            this.statusPing.title = text;
            this.statusPing.setAttribute('aria-label', text);
        }

        // DEV_MODE: Update status text display
        if (this.statusText) {
            this.statusText.textContent = text;
            if (isGreen) this.statusText.style.color = '#34d399';
            else if (isAmber) this.statusText.style.color = '#fbbf24';
            else if (isRed) this.statusText.style.color = '#f87171';
        }

        const classSets = {
            greenOuter: ['bg-emerald-400'],
            greenInner: ['bg-emerald-500'],
            amberOuter: ['bg-amber-400'],
            amberInner: ['bg-amber-500'],
            redOuter: ['bg-red-400'],
            redInner: ['bg-red-500']
        };

        // clear previous color classes
        const allOuter = [...classSets.greenOuter, ...classSets.amberOuter, ...classSets.redOuter];
        const allInner = [...classSets.greenInner, ...classSets.amberInner, ...classSets.redInner];

        if (this.statusPingOuter && this.statusPingInner) {
            this.statusPingOuter.classList.remove(...allOuter);
            this.statusPingInner.classList.remove(...allInner);

            if (isGreen) {
                this.statusPingOuter.classList.add(...classSets.greenOuter);
                this.statusPingInner.classList.add(...classSets.greenInner);
            } else if (isAmber) {
                this.statusPingOuter.classList.add(...classSets.amberOuter);
                this.statusPingInner.classList.add(...classSets.amberInner);
            } else if (isRed) {
                this.statusPingOuter.classList.add(...classSets.redOuter);
                this.statusPingInner.classList.add(...classSets.redInner);
            } else {
                // default to green
                this.statusPingOuter.classList.add(...classSets.greenOuter);
                this.statusPingInner.classList.add(...classSets.greenInner);
            }
        }
    }

    updateSendButtonToStop() {
        const sendIcon = this.sendButton.querySelector('.send-icon');
        const stopIcon = this.sendButton.querySelector('.stop-icon');
        if (sendIcon) sendIcon.style.display = 'none';
        if (stopIcon) stopIcon.style.display = 'block';
        this.sendButton.classList.add('stop-mode');
        this.sendButton.setAttribute('data-mode', 'stop');
        this.sendButton.title = 'Stop generating';
    }

    updateSendButtonToNormal() {
        const sendIcon = this.sendButton.querySelector('.send-icon');
        const stopIcon = this.sendButton.querySelector('.stop-icon');
        if (sendIcon) sendIcon.style.display = 'block';
        if (stopIcon) stopIcon.style.display = 'none';
        this.sendButton.classList.remove('stop-mode');
        this.sendButton.setAttribute('data-mode', 'send');
        this.sendButton.title = 'Send message';
    }

    stopGeneration() {
        // Stop any ongoing typing animation immediately
        if (this.currentTypingInterval) {
            clearInterval(this.currentTypingInterval);
            this.currentTypingInterval = null;
        }

        // Remove typing indicator and reset UI state
        this.hideTypingIndicator();

        // Set status to ready instead of stopped
        this.updateStatus('Ready', '#4ade80');

        // Don't add any message to chat - just stop silently
    }

    disableModelSelection() {
        const selectContainer = document.querySelector('.custom-select-container');
        if (selectContainer) {
            selectContainer.classList.add('disabled');
        }

        // Close dropdown if open
        this.closeDropdown();
    }

    enableModelSelection() {
        const selectContainer = document.querySelector('.custom-select-container');
        if (selectContainer) {
            selectContainer.classList.remove('disabled');
        }
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showErrorPopup(message) {
        const existingPopup = document.querySelector('.error-popup');
        if (existingPopup) existingPopup.remove();

        const popup = document.createElement('div');
        popup.className = 'error-popup';
        popup.textContent = message;

        document.body.appendChild(popup);

        setTimeout(() => {
            if (popup.parentNode) popup.remove();
        }, 3000);
    }

    async checkServerStatus() {
        try {
            // Define server URLs with primary and failover
            const servers = window.location.hostname === 'antonjijo.github.io'
                ? [
                    'https://nvidia-nim-bot.onrender.com',  // Primary server (Render)
                    'https://Nvidia.pythonanywhere.com'     // Failover server (PythonAnywhere)
                ]
                : ['http://localhost:8000'];  // DEV_MODE: Change to 5000 for production

            let connected = false;
            let connectedServer = '';

            // Try each server in sequence until one works
            for (let i = 0; i < servers.length; i++) {
                const serverURL = servers[i];

                try {
                    console.log(`Checking server ${i + 1}/${servers.length}: ${serverURL}`);

                    const response = await fetch(`${serverURL}/health`, {
                        timeout: 5000  // 5 second timeout for health check
                    });

                    if (response.ok) {
                        connected = true;
                        const serverHost = (new URL(serverURL)).hostname;
                        const serverName = serverHost === 'nvidia-nim-bot.onrender.com' ? 'Primary' :
                            (serverHost === 'nvidia.pythonanywhere.com' ||
                                serverHost.endsWith('.pythonanywhere.com')) ? 'Failover' : 'Local';
                        connectedServer = serverName;
                        console.log(`Server ${serverName} is online: ${serverURL}`);
                        break; // Found working server, stop checking
                    }
                } catch (error) {
                    console.warn(`Server ${i + 1} health check failed (${serverURL}):`, error.message);
                    // Continue to next server
                }
            }

            if (connected) {
                this.updateStatus(`Ready (${connectedServer})`, '#4ade80');
            } else {
                this.updateStatus('All Servers Offline', '#ef4444');
            }

        } catch (error) {
            console.error('Health check error:', error);
            this.updateStatus('Connection Error', '#ef4444');
        }
    }

    initializeCustomDropdown() {
        if (!this.customSelectTrigger || !this.customSelectDropdown) return;

        // Toggle dropdown on trigger click
        this.customSelectTrigger.addEventListener('click', (e) => {
            e.stopPropagation();

            // Don't open dropdown if disabled
            const selectContainer = document.querySelector('.custom-select-container');
            if (selectContainer && selectContainer.classList.contains('disabled')) {
                return;
            }

            this.toggleDropdown();
        });

        // Handle option selection
        const options = this.customSelectDropdown.querySelectorAll('.select-option');
        options.forEach(option => {
            option.addEventListener('click', (e) => {
                // Don't allow selection if disabled
                const selectContainer = document.querySelector('.custom-select-container');
                if (selectContainer && selectContainer.classList.contains('disabled')) {
                    return;
                }

                this.selectOption(e.target);
            });
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.customSelectTrigger.contains(e.target) && !this.customSelectDropdown.contains(e.target)) {
                this.closeDropdown();
            }
        });

        // Mark the default option as selected
        const firstOption = options[0];
        if (firstOption) {
            firstOption.classList.add('selected');
        }
    }

    toggleDropdown() {
        // DEV_MODE: Fixed property name
        const isActive = this.modelDropdown?.classList.contains('active');
        if (isActive) {
            this.closeDropdown();
        } else {
            this.openDropdown();
        }
    }

    // DEV_MODE: Fixed property names matching initializeChatGPTUI
    openDropdown() {
        this.modelSelector?.classList.add('active');
        this.modelDropdown?.classList.add('active');
    }

    closeDropdown() {
        this.modelSelector?.classList.remove('active');
        this.modelDropdown?.classList.remove('active');
    }

    selectOption(optionElement) {
        // Get the value before making changes
        const value = optionElement.getAttribute('data-value');

        // Close the dropdown first
        this.closeDropdown();

        // Handle model change with confirmation
        this.handleModelChange(value);
    }

    setupGlobalScrolling() {
        // Enable scrolling of chat messages from anywhere in the chat container
        const chatContainer = document.querySelector('.chat-container');
        if (chatContainer) {
            chatContainer.addEventListener('wheel', (e) => {
                // Check if the scroll event should be handled by the chat messages
                const isInputFocused = document.activeElement === this.messageInput;
                const isDropdownOpen = this.customSelectDropdown && this.customSelectDropdown.classList.contains('active');

                // Only scroll chat messages if input is not focused and dropdown is not open
                if (!isInputFocused && !isDropdownOpen) {
                    e.preventDefault();
                    this.chatMessages.scrollTop += e.deltaY;
                }
            }, { passive: false });

            // Also enable touch scrolling for mobile devices
            let startY = 0;
            let scrollTop = 0;

            chatContainer.addEventListener('touchstart', (e) => {
                startY = e.touches[0].clientY;
                scrollTop = this.chatMessages.scrollTop;
            }, { passive: true });

            chatContainer.addEventListener('touchmove', (e) => {
                const isInputFocused = document.activeElement === this.messageInput;
                const isDropdownOpen = this.customSelectDropdown && this.customSelectDropdown.classList.contains('active');

                if (!isInputFocused && !isDropdownOpen) {
                    const currentY = e.touches[0].clientY;
                    const deltaY = startY - currentY;
                    this.chatMessages.scrollTop = scrollTop + deltaY;
                }
            }, { passive: true });
        }
    }
    async handleFileSelect(e) {
        let file;
        if (e.target && e.target.files) {
            file = e.target.files[0];
        } else if (e instanceof File || e instanceof Blob) {
            // Direct file object passed (e.g. from paste)
            file = e;
            // Ensure file has a name (clipboard blobs might not)
            if (!file.name || file.name === 'image.png') {
                // Generate a name with current timestamp
                const ext = file.type.split('/')[1] || 'png';
                // We can't rename a File object directly easily, so we just use it as is
                // but if it's strictly required by our validation:
                // Our validation checks file.name.split('.').pop()
                // 'image.png' works fine.
            }
        }

        if (!file) return;

        // Beta restriction: Block if file already attached
        if (this.selectedFile) {
            this.showErrorPopup("File already attached (Beta: 1 file limit)\nPlease remove the current file before uploading another.\nClick the × on the file preview to remove it.");
            if (this.fileInput) this.fileInput.value = ''; // Reset file input
            return;
        }

        // Validation (Frontend) - Blacklist binary/unsupported types
        // Support: All text-based files (code, markdown, data files, etc.)
        // Block: Binary formats (executables, archives, media except images)
        const unsupportedTypes = [
            // Executables
            'exe', 'dll', 'bin', 'app', 'dmg', 'deb', 'rpm',
            // Archives
            'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
            // Documents (not plain text)
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            // Media (except images we support)
            'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wav', 'flac',
            // Database
            'db', 'sqlite', 'mdb',
            // Other binary
            'iso', 'img'
        ];
        const ext = file.name.split('.').pop().toLowerCase();

        if (unsupportedTypes.includes(ext)) {
            this.showErrorPopup("File type not supported in Beta version.\nUnsupported: Executables, Archives, PDFs, Office docs, Videos, Audio\nSupported: Images (.png, .jpg, .webp) and All Text/Code files (.txt, .py, .js, .md, etc.)\nMax size: 5MB, 1 file at a time");
            this.fileInput.value = ''; // Reset
            return;
        }

        // Size check (5MB for Beta version)
        if (file.size > 5 * 1024 * 1024) {
            this.showErrorPopup("File is too large. Maximum size is 5MB in Beta version.");
            this.fileInput.value = '';
            return;
        }

        this.selectedFile = file;

        // Extract text content for text-based files (frontend extraction to reduce backend load)
        const textTypes = ['txt', 'md', 'json', 'csv'];
        if (textTypes.includes(ext)) {
            try {
                const text = await this.readTextFile(file);
                this.selectedFileContent = text;
                console.log(`Text file extracted on frontend (${text.length} chars)`);
            } catch (error) {
                console.error('Failed to read text file:', error);
                this.showErrorPopup('Failed to read text file');
                this.fileInput.value = '';
                return;
            }
        } else {
            // Image files - no extraction needed
            this.selectedFileContent = null;
        }

        this.showFilePreview(file);
    }

    // Helper method to read text files
    readTextFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }

    handlePaste(e) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const blob = item.getAsFile();
                if (blob) {
                    console.log('Paste detected:', blob.name, blob.type);

                    // Fix: Clipboard files usually have generic names like "image.png"
                    // If name is missing or "image.png", let's ensure it's treated correctly
                    // We need to create a new File object to ensure properties are mutable/correct if needed,
                    // mostly for consistent behavior, though blob usually works.
                    // But importantly: Check if handleFileSelect properly detects it.

                    // Simple pass-through
                    this.handleFileSelect(blob);

                    e.preventDefault(); // Prevent pasting the binary code into textarea
                    return; // Only handle one file per paste
                }
            }
        }
    }

    showFilePreview(file) {
        if (!this.filePreviewArea) return;

        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(file.name.split('.').pop().toLowerCase());
        const iconClass = isImage ? 'fa-image' : 'fa-file-alt';
        const clickableClass = isImage ? 'clickable' : '';

        this.filePreviewArea.innerHTML = `
            <div class="file-preview-item ${clickableClass}" id="previewItemChip">
                <i class="fas ${iconClass} file-preview-icon"></i>
                <span class="file-preview-name">${this.escapeHTML(file.name)}</span>
                <button class="file-preview-remove" id="removeFileBtn" title="Remove file">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        const removeBtn = document.getElementById('removeFileBtn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFile();
            });
        }

        // Add click listener for image preview
        if (isImage) {
            const chip = document.getElementById('previewItemChip');
            chip.addEventListener('click', () => {
                this.openImagePreview(file);
            });
        }
    }

    openImagePreview(file) {
        if (!this.imagePreviewModal || !this.imagePreviewImg) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            this.imagePreviewImg.src = e.target.result;
            if (this.imagePreviewCaption) {
                this.imagePreviewCaption.textContent = file.name;
            }
            this.imagePreviewModal.style.display = "block";
        };
        reader.readAsDataURL(file);
    }

    closeImagePreview() {
        if (this.imagePreviewModal) {
            this.imagePreviewModal.style.display = "none";
        }
    }

    setupVoiceInput() {
        if (!this.micBtn) return;

        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.warn('Speech Recognition not supported in this browser');
            this.micBtn.disabled = true;
            this.micBtn.title = 'Voice input not supported';
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true; // Keep listening
        this.recognition.interimResults = true; // Show interim results for animation
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        // Silence timeout
        this.silenceTimeout = null;
        this.silenceDelay = 2000; // Stop after 2 seconds of silence

        // Mic button click handler
        this.micBtn.addEventListener('click', () => {
            if (this.isRecording) {
                this.stopVoiceInput();
            } else {
                this.startVoiceInput();
            }
        });

        // Recognition event handlers
        this.recognition.onstart = () => {
            this.isRecording = true;
            this.micBtn.classList.add('recording');
            this.micBtn.title = 'Listening... Click to stop';
            this.savedInputValue = this.messageInput.value; // Save current value
            console.log('Voice recognition started');
        };

        this.recognition.onresult = (event) => {
            // Clear silence timeout on any speech
            if (this.silenceTimeout) {
                clearTimeout(this.silenceTimeout);
            }

            let interimTranscript = '';
            let finalTranscript = '';

            // Process all results
            for (let i = 0; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript + ' ';
                } else {
                    interimTranscript += transcript;
                }
            }

            // Show live interim results (with visual feedback)
            if (interimTranscript) {
                this.messageInput.value = this.savedInputValue + (this.savedInputValue ? ' ' : '') + finalTranscript + interimTranscript;
                this.micBtn.classList.add('speaking'); // Visual feedback
            } else {
                this.micBtn.classList.remove('speaking');
            }

            // Update saved value when we get final results
            if (finalTranscript) {
                this.savedInputValue = this.savedInputValue + (this.savedInputValue ? ' ' : '') + finalTranscript.trim();
                console.log('Final transcript:', finalTranscript);
            }

            this.updateCharCount();
            this.autoResizeTextarea();
            this.messageInput.focus();

            // Set timeout to stop after silence
            this.silenceTimeout = setTimeout(() => {
                console.log('Silence detected, stopping...');
                this.stopVoiceInput();
            }, this.silenceDelay);
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            this.stopVoiceInput();

            if (event.error === 'not-allowed') {
                this.showErrorPopup('Microphone access denied. Please allow microphone access in your browser settings.');
            } else if (event.error === 'no-speech') {
                this.showErrorPopup('No speech detected. Please try again.');
            } else {
                this.showErrorPopup('Voice input error. Please try again.');
            }
        };

        this.recognition.onend = () => {
            this.stopVoiceInput();
        };
    }

    startVoiceInput() {
        if (!this.recognition) return;

        try {
            this.recognition.start();
        } catch (error) {
            console.error('Failed to start voice input:', error);
            this.showErrorPopup('Failed to start voice input. Please try again.');
        }
    }

    stopVoiceInput() {
        if (!this.recognition) return;

        // Clear silence timeout
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }

        try {
            this.recognition.stop();
        } catch (error) {
            console.error('Failed to stop voice input:', error);
        }

        this.isRecording = false;
        if (this.micBtn) {
            this.micBtn.classList.remove('recording', 'speaking');
            this.micBtn.title = 'Voice input';
        }
    }

    removeFile() {
        this.selectedFile = null;
        if (this.fileInput) this.fileInput.value = '';
        if (this.filePreviewArea) this.filePreviewArea.innerHTML = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.chatbot = new Chatbot();
});
