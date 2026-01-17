// ============================================
// DEV MODE CONFIGURATION
// Set to true to force all API calls to localhost:8000
// Set to false for production (auto-detects based on hostname)
// ============================================
const DEV_MODE = false;
const DEV_SERVER_URL = 'http://localhost:8000';

// Helper function to get server URLs based on dev mode
function getServerUrls() {
    if (DEV_MODE) {
        return [DEV_SERVER_URL];
    }
    return (window.location.hostname === 'antonjijo.github.io' || window.location.hostname === 'nvidia-nim.pages.dev')
        ? ['https://nvidia-nim-bot.onrender.com', 'https://nvidia.pythonanywhere.com']
        : ['http://localhost:8000'];
}

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
                            <i class="far fa-clone"></i>
                            <span class="copy-text">Copy code</span>
                        </button>
                    </div>
                    <div class="code-content hljs language-${lang}" id="${id}">${highlightedCode}</div>
                </div>
            `;
        };

        // Custom link renderer for ChatGPT-style secure links
        // Note: Content blocking is handled by AI via system prompt, not frontend
        renderer.link = (href, title, text) => {
            // Handle Marked newer versions where first arg is a token object
            let url = href;
            let linkText = text;
            let linkTitle = title;

            if (typeof href === 'object' && href !== null && href.href) {
                url = href.href;
                linkText = href.text || href.href;
                linkTitle = href.title;
            }

            // Sanitize the URL
            const safeUrl = this.escapeHTML(url || '');
            const safeText = linkText || safeUrl;
            const safeTitleAttr = linkTitle ? ` title="${this.escapeHTML(linkTitle)}"` : '';

            // Check if it's an external link (various protocols)
            const externalProtocols = ['http://', 'https://', 'ftp://', 'ftps://', 'sftp://'];
            const isExternal = externalProtocols.some(protocol => safeUrl.toLowerCase().startsWith(protocol));

            // Special protocols that open apps (mailto, tel, etc.)
            const appProtocols = ['mailto:', 'tel:', 'sms:', 'whatsapp:', 'skype:'];
            const isAppLink = appProtocols.some(protocol => safeUrl.toLowerCase().startsWith(protocol));

            if (isExternal) {
                // External web link with security icon and click interception
                return `<a href="${safeUrl}" class="secure-link" data-external="true"${safeTitleAttr}>${safeText}<svg class="external-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
            } else if (isAppLink) {
                // App protocol links (mailto, tel, etc.) - show with different icon
                return `<a href="${safeUrl}" class="app-link"${safeTitleAttr}>${safeText}<svg class="app-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></a>`;
            } else {
                // Internal/relative link (rare in chat context)
                return `<a href="${safeUrl}"${safeTitleAttr}>${safeText}</a>`;
            }
        };

        marked.setOptions({
            renderer: renderer,
            breaks: true,
            gfm: true
        });
    }

    renderMarkdown(text) {
        if (typeof marked === 'undefined') return this.escapeHTML(text);

        // Normalize tags (handle both variations)
        let processedText = text.replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>');

        // Process thinking blocks BEFORE passing to marked
        // Server sends: <think start="TIMESTAMP">...content...</think>
        // We need to extract these, render their content separately, then inject back

        const thinkBlocksData = [];
        let blockIndex = 0;

        // Use a unique marker that won't be touched by markdown
        // Use a unique marker that won't be touched by markdown
        // Regex matches <think start="..." duration="...">content</think>
        processedText = processedText.replace(/<think(?: start="([^"]*)")?(?: duration="([^"]*)")?>([\s\S]*?)(<\/think>|$)/g, (match, startTs, durationAttr, content, closingTag) => {
            const isClosed = closingTag === '</think>';

            // Calculate duration
            let durationText = "Thinking";

            if (durationAttr) {
                // Static duration from saved history
                durationText = `Thought for ${durationAttr}s`;
            } else if (startTs) {
                // Live duration
                const startTime = parseInt(startTs, 10);
                const durationSeconds = Math.round((Date.now() - startTime) / 1000);
                if (isClosed) {
                    // Temporarily show live duration until finalized
                    durationText = `Thought for ${durationSeconds}s`;
                } else {
                    durationText = "Thinking";
                }
            }

            const activeClass = !isClosed ? ' thinking-active expanded' : '';

            // Parse the INNER content of the think block with marked
            const parsedInnerContent = marked.parse(content || '');

            // Build the complete HTML block
            const blockHtml = `<div class="thought-block${activeClass}" data-thought-id="${blockIndex}">
                <div class="thought-toggle">
                    <span class="thought-icon">
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 1L7 5L3 9"/>
                        </svg>
                    </span>
                    <span class="thought-label">${durationText}</span>
                </div>
                <div class="thought-content">${parsedInnerContent}</div>
            </div>`;

            thinkBlocksData.push(blockHtml);

            // Return a marker that markdown WON'T touch (no underscores, special chars)
            return `THINKMARKER${blockIndex++}ENDMARKER`;
        });

        // Now parse the rest with marked
        let html = marked.parse(processedText);

        // Replace markers with actual HTML
        thinkBlocksData.forEach((blockHtml, idx) => {
            // Marked might wrap our marker in <p> tags
            html = html.replace(`<p>THINKMARKER${idx}ENDMARKER</p>`, blockHtml);
            html = html.replace(`THINKMARKER${idx}ENDMARKER`, blockHtml);
        });

        // Sanitize HTML - MUST allow onclick or use data attributes
        if (typeof DOMPurify !== 'undefined') {
            html = DOMPurify.sanitize(html, {
                ADD_TAGS: ['div', 'span', 'i', 'button', 'svg', 'path', 'polyline', 'line', 'details', 'summary'],
                ADD_ATTR: ['target', 'class', 'id', 'data-code-id', 'data-external', 'title', 'viewBox', 'fill', 'stroke', 'stroke-width', 'd', 'points', 'x1', 'y1', 'x2', 'y2', 'open', 'data-thought-id']
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
        this.currentMode = 'default';
        this.reasoningMode = false; // New: explicit reasoning mode toggle
        this.activeModes = []; // Track order of mode activation
        this.slashMenu = null;

        // Models that support reasoning mode
        this.REASONING_CAPABLE_MODELS = ['deepseek-ai/deepseek-r1', 'moonshotai/kimi-k2-thinking'];

        this.setupMarkdown(); // Initialize Markdown pipeline

        this.initializeElements();
        this.setupEventListeners();
        this.autoResizeTextarea();
        this.initServerHealthCheck();
        this.setupSessionControls();
        this.setupSecureLinkHandler(); // ChatGPT-style link confirmation

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
            return existingSessionId;
        }

        // Generate a unique session ID for conversation persistence
        const newSessionId = 'session_' + Date.now() + '_' + this._secureRandomString(16);

        localStorage.setItem('chatbot_session_id', newSessionId);

        return newSessionId;
    }

    _validateSessionId(sessionId) {
        // Validate session ID format
        if (!sessionId || typeof sessionId !== 'string') {
            return false;
        }

        // Check format: session_timestamp_randomstring
        // Random part can be 8-32 chars (Math.random gives ~11 chars, crypto gives 32)
        const sessionPattern = /^session_\d+_[a-z0-9]{8,32}$/;
        return sessionPattern.test(sessionId);
    }

    createNewSession() {
        let newSessionId;

        if (this.sessionId && (!this.messages || this.messages.length === 0)) {
            newSessionId = this.sessionId;
        } else {
            // Force create a new session and store it
            newSessionId = 'session_' + Date.now() + '_' + this._secureRandomString(16);
        }

        localStorage.setItem('chatbot_session_id', newSessionId);
        this.sessionId = newSessionId;

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
            const servers = getServerUrls();

            for (const serverURL of servers) {
                try {
                    const response = await fetch(`${serverURL}/api/conversation/stats?session_id=${this.sessionId}`);
                    if (response.ok) {
                        this.conversationStats = await response.json();

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
                    // Failed to get stats from server
                }
            }
        } catch (error) {
            console.error('Failed to get conversation stats:', error);
        }
        return null;
    }

    async clearConversation() {
        try {
            const servers = getServerUrls();

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

                        return true;
                    }
                } catch (error) {
                    // Failed to clear conversation
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
        this.setupMobileViewport();
        this.setupGlobalScrolling();

        // File Upload Elements
        this.fileInput = document.getElementById('fileInput');
        this.attachBtn = document.getElementById('attachBtn');
        this.filePreviewArea = document.getElementById('filePreviewArea');



        if (this.attachBtn && this.fileInput) {
            // Updated: Plus icon now toggles the slash menu (ChatGPT style)
            this.attachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.isLoading) {
                    this.showToast('Please wait for generation to complete', 'warning');
                    return;
                }
                this.slashMenu?.classList.toggle('visible');
            });

            this.fileInput.addEventListener('change', (e) => {
                this.handleFileSelect(e);
            });
        }

        // Initialize Slash Menu
        this.createSlashMenu();
        if (this.messageInput) {
            this.messageInput.addEventListener('input', (e) => this.handleSlashInput(e));
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
            // Thought Toggle - Global Delegation
            const thoughtToggle = e.target.closest('.thought-toggle');
            if (thoughtToggle) {
                e.preventDefault();
                e.stopPropagation();
                // Find parent block
                const block = thoughtToggle.closest('.thought-block');
                if (block) {
                    block.classList.toggle('expanded');
                }
                return; // Stop processing
            }

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
        if (this.isLoading) {
            this.showToast('Please wait for generation to complete before changing models', 'warning');
            return;
        }

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
        this.modelSelect.value = newModel;
        this.updateCustomDropdownDisplay(newModel);

        // Hide loader until actual conversation starts
        const statsElement = document.getElementById('conversationStats');
        if (statsElement) {
            statsElement.style.display = 'none';
        }

        // Reset conversation stats - loader will only show after real usage
        this.conversationStats = null;

        // Update reasoning mode state based on new model
        if (!this.REASONING_CAPABLE_MODELS.includes(newModel)) {
            // Disable reasoning mode if switching to non-reasoning model
            if (this.reasoningMode) {
                this.reasoningMode = false;
                this.activeModes = this.activeModes.filter(m => m !== 'reasoning');
                this.renderModeBadge();
            }
        }

        // Update slash menu reasoning item state
        this.updateReasoningSlashItem();
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

        // Centralized Sidebar Toggle Helper
        this.toggleSidebar = (show) => {
            if (show) {
                this.sidebar?.classList.add('expanded');
                this.sidebarOverlay?.classList.add('active');
                localStorage.setItem('sidebar_expanded', 'true');
            } else {
                this.sidebar?.classList.remove('expanded');
                this.sidebarOverlay?.classList.remove('active');
                localStorage.setItem('sidebar_expanded', 'false');
            }
        };

        // Restore sidebar state (Default to Expanded on Desktop)
        if (this.sidebar) {
            const savedState = localStorage.getItem('sidebar_expanded');
            const isDesktop = window.innerWidth > 768;

            if (savedState === 'true' || (savedState === null && isDesktop)) {
                this.toggleSidebar(true);
            } else {
                this.toggleSidebar(false);
            }
        }

        // Sidebar Toggle Button - collapse sidebar
        if (this.sidebarToggle) {
            this.sidebarToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSidebar(false);
            });
        }

        // Click on sidebar logo area
        if (this.sidebarLogoWrap) {
            this.sidebarLogoWrap.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.sidebar?.classList.contains('expanded')) {
                    // Sidebar is open - open external link
                    window.open('https://nvidia-nim.pages.dev/', '_blank');
                } else {
                    // Sidebar is closed - expand it
                    this.toggleSidebar(true);
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
                    this.toggleSidebar(true);
                }
            });
        }

        // Mobile menu button
        if (this.mobileMenuBtn) {
            this.mobileMenuBtn.addEventListener('click', () => {
                this.toggleSidebar(true);
            });
        }

        // Sidebar overlay click to close
        if (this.sidebarOverlay) {
            this.sidebarOverlay.addEventListener('click', () => {
                this.toggleSidebar(false);
            });
        }

        // DOCUMENT CLICK LISTENER (Failsafe for mobile)
        document.addEventListener('click', (e) => {
            // Only relevant on mobile or when overlay should be active
            if (window.innerWidth <= 768 && this.sidebar?.classList.contains('expanded')) {
                // Ignore clicks inside the sidebar itself
                if (this.sidebar.contains(e.target)) return;

                // Ignore clicks on the toggle button that opened it
                if (this.mobileMenuBtn?.contains(e.target)) return;

                // Close it
                this.toggleSidebar(false);
            }
        });

        // New chat button
        if (this.newChatBtn) {
            this.newChatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showNewSessionDialog();
                if (window.innerWidth <= 768) this.toggleSidebar(false);
            });
        }

        // Model selector dropdown
        if (this.modelSelector) {
            this.modelSelector.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.isLoading) {
                    this.showToast('Please wait for generation to complete before changing models', 'warning');
                    return;
                }
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
                    if (window.innerWidth <= 768) this.toggleSidebar(false);
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
        const stats = await this.getConversationStats();
        if (stats) {
            this.updateConversationStatsUI();
        }
    }

    showNewSessionDialog() {
        if (this.isLoading) {
            this.showToast('Please wait for generation to complete before starting a new chat', 'warning');
            return;
        }
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

    handleSlashInput(e) {
        const val = this.messageInput.value;
        if (val.startsWith('/')) {
            if (this.isLoading) {
                this.messageInput.value = '';
                this.showToast('Please wait for generation to complete before using commands', 'warning');
                return;
            }
            if (this.slashMenu) {
                this.slashMenu.classList.add('visible');
                // Added: Filtering logic
                const query = val.slice(1).toLowerCase();
                const items = this.slashMenu.querySelectorAll('.slash-item');
                let visibleCount = 0;

                items.forEach(item => {
                    const text = item.querySelector('span')?.textContent.toLowerCase() || '';
                    if (text.includes(query)) {
                        item.style.display = 'flex';
                        visibleCount++;
                    } else {
                        item.style.display = 'none';
                    }
                });

                // Hide menu if no results
                if (visibleCount === 0) {
                    this.slashMenu.classList.remove('visible');
                }
            }
        } else {
            if (this.slashMenu) this.slashMenu.classList.remove('visible');
        }
        this.autoResizeTextarea();
    }

    createSlashMenu() {
        const inputWrapper = document.getElementById('inputWrapper');
        if (!inputWrapper) return;

        const menu = document.createElement('div');
        menu.className = 'slash-menu';

        // Add Photos & Files Item
        const fileItem = document.createElement('div');
        fileItem.className = 'slash-item item-files';
        fileItem.innerHTML = `
            <img src="https://img.icons8.com/ios/50/attach.png" 
                 alt="Files" 
                 class="slash-item-icon">
            <span>Add photos & files</span>
        `;
        fileItem.onclick = () => {
            this.fileInput?.click();
            menu.classList.remove('visible');
            if (this.messageInput.value.startsWith('/')) this.messageInput.value = '';
        };
        menu.appendChild(fileItem);

        // Reasoning Mode Item (with capability check)
        const reasoningItem = document.createElement('div');
        reasoningItem.className = 'slash-item item-thinking';
        reasoningItem.id = 'reasoningSlashItem';
        reasoningItem.innerHTML = `
            <img src="https://img.icons8.com/ios/50/idea.png" 
                 alt="Reasoning" 
                 class="slash-item-icon">
            <span>Thinking</span>
        `;
        reasoningItem.onclick = (e) => {
            if (reasoningItem.classList.contains('disabled')) {
                e.stopPropagation();
                this.showToast('Switch to DeepSeek R1 or Kimi K2 to enable Thinking Mode', 'warning');
                return;
            }
            this.toggleReasoningMode();
            menu.classList.remove('visible');
            if (this.messageInput.value.startsWith('/')) this.messageInput.value = '';
        };
        menu.appendChild(reasoningItem);

        // Study Mode Item
        const studyItem = document.createElement('div');
        studyItem.className = 'slash-item item-study';
        studyItem.innerHTML = `
            <img src="https://img.icons8.com/ios/50/student-registration.png" 
                 alt="Study" 
                 class="slash-item-icon">
            <span>Study & Learn</span>
        `;
        studyItem.onclick = () => {
            this.setMode('study');
            menu.classList.remove('visible');
            if (this.messageInput.value.startsWith('/')) this.messageInput.value = '';
        };
        menu.appendChild(studyItem);

        inputWrapper.appendChild(menu);
        this.slashMenu = menu;
        this.slashMenu = menu;

        // Update reasoning item state when model changes
        this.updateReasoningSlashItem();

        // Hide menu on outside click
        document.addEventListener('click', (e) => {
            if (this.slashMenu && this.slashMenu.classList.contains('visible') && !this.slashMenu.contains(e.target) && e.target !== this.messageInput) {
                this.slashMenu.classList.remove('visible');
            }
        });
    }

    isReasoningCapableModel() {
        const currentModel = this.modelSelect ? this.modelSelect.value : '';
        return this.REASONING_CAPABLE_MODELS.includes(currentModel);
    }

    updateReasoningSlashItem() {
        const reasoningItem = document.getElementById('reasoningSlashItem');
        if (!reasoningItem) return;

        if (this.isReasoningCapableModel()) {
            reasoningItem.classList.remove('disabled');
        } else {
            reasoningItem.classList.add('disabled');
        }
    }

    toggleReasoningMode() {
        if (this.isLoading) {
            this.showToast('Please wait for generation to complete before changing modes', 'warning');
            return;
        }

        if (!this.isReasoningCapableModel()) {
            // Show tooltip/alert that model doesn't support reasoning
            this.showToast('Switch to DeepSeek R1 or Kimi K2 to enable Reasoning Mode', 'warning');
            return;
        }

        this.reasoningMode = !this.reasoningMode;

        // Track activation order
        if (this.reasoningMode) {
            if (!this.activeModes.includes('reasoning')) {
                this.activeModes.push('reasoning');
            }
        } else {
            this.activeModes = this.activeModes.filter(m => m !== 'reasoning');
        }

        if (this.slashMenu) this.slashMenu.classList.remove('visible');
        this.messageInput.value = '';
        this.autoResizeTextarea();
        this.renderModeBadge();
        this.messageInput.focus();
    }

    setMode(mode) {
        if (this.isLoading) {
            this.showToast('Please wait for generation to complete before changing modes', 'warning');
            return;
        }

        const wasStudy = this.currentMode === 'study';
        this.currentMode = mode;

        // Track activation order
        if (mode === 'study') {
            if (!this.activeModes.includes('study')) {
                this.activeModes.push('study');
            }
        } else {
            this.activeModes = this.activeModes.filter(m => m !== 'study');
        }

        if (this.slashMenu) this.slashMenu.classList.remove('visible');
        this.messageInput.value = ''; // Clear slash
        this.autoResizeTextarea();
        this.renderModeBadge();
        this.messageInput.focus();
    }

    renderModeBadge() {
        // Remove existing badges and container
        const wrapper = document.getElementById('inputWrapper');
        if (!wrapper) return;

        const existingContainer = wrapper.querySelector('.badges-container');
        if (existingContainer) existingContainer.remove();

        // Create container for badges (flexbox with gap)
        const hasModes = (this.currentMode === 'study' || this.reasoningMode);

        if (hasModes) {
            const badgesContainer = document.createElement('div');
            badgesContainer.className = 'badges-container';

            // Render badges in activation order
            for (const mode of this.activeModes) {
                if (mode === 'study' && this.currentMode === 'study') {
                    const badge = document.createElement('div');
                    badge.className = 'mode-badge study';
                    badge.title = "Click to exit Study Mode";
                    badge.onclick = () => { this.setMode('default'); };

                    badge.innerHTML = `
                        <img src="https://img.icons8.com/ios/50/book-and-pencil.png" 
                             alt="Study Mode" 
                             class="study-mode-icon">
                        <span class="study-mode-text">Study</span>
                    `;
                    badgesContainer.appendChild(badge);
                }

                if (mode === 'reasoning' && this.reasoningMode) {
                    const badge = document.createElement('div');
                    badge.className = 'mode-badge reasoning';
                    badge.title = "Click to exit Reasoning Mode";
                    badge.onclick = () => { this.toggleReasoningMode(); };

                    badge.innerHTML = `
                        <img src="https://img.icons8.com/pastel-glyph/64/brain-3--v2.png" 
                             alt="Reasoning Mode" 
                             class="reasoning-mode-icon">
                        <span class="reasoning-mode-text">Thinking</span>
                    `;
                    badgesContainer.appendChild(badge);
                }
            }

            // Insert after left actions
            const leftActions = wrapper.querySelector('.input-left-actions');
            if (leftActions) {
                leftActions.insertAdjacentElement('afterend', badgesContainer);
            } else {
                wrapper.prepend(badgesContainer);
            }

            wrapper.classList.add('has-mode');
        } else {
            wrapper.classList.remove('has-mode');
        }
    }

    showTypingIndicator() {
        if (this.isTyping) return;
        this.isTyping = true;

        // Use premium Cognitive Indicator from AnimationController
        this.currentTypingIndicator = window.animationController
            ? window.animationController.showCognitiveIndicator(this.chatMessages)
            : null;

        this.scrollToBottom();
    }

    showAnalyzingIndicator(type) {
        if (this.isAnalyzing) return;
        this.isAnalyzing = true;
        this.isTyping = true;

        // Remove any existing indicator
        const existingIndicator = document.getElementById('analyzingIndicator');
        if (existingIndicator) existingIndicator.remove();

        const chatMessages = document.querySelector('.chat-messages');
        if (!chatMessages) return;

        // Create premium processing indicator
        const indicatorWrapper = document.createElement('div');
        indicatorWrapper.className = 'processing-indicator';
        indicatorWrapper.id = 'analyzingIndicator';

        const isImage = type === 'image';
        const isWiki = type === 'wiki';

        let iconSrc, statusText;
        if (isImage) {
            iconSrc = 'https://img.icons8.com/ios/50/image-gallery.png';
            statusText = 'Analyzing visual data';
        } else if (isWiki) {
            iconSrc = 'https://img.icons8.com/ios/50/search--v1.png';
            statusText = 'Searching the web';
        } else {
            iconSrc = 'https://img.icons8.com/ios/50/document.png';
            statusText = 'Processing file content';
        }

        indicatorWrapper.innerHTML = `
            <div class="processing-content">
                <div class="processing-icon-wrapper">
                    <img src="${iconSrc}" alt="Processing" class="processing-icon">
                    <div class="processing-ring"></div>
                    <div class="processing-ring ring-2"></div>
                </div>
                <div class="processing-text-wrapper">
                    <span class="processing-status">${statusText}</span>
                    <span class="processing-dots">
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                    </span>
                </div>
            </div>
            <div class="processing-progress">
                <div class="processing-progress-bar"></div>
            </div>
        `;

        chatMessages.appendChild(indicatorWrapper);
        this.scrollToBottom();
    }

    hideAnalyzingIndicator() {
        const indicator = document.getElementById('analyzingIndicator');
        if (indicator) {
            indicator.classList.add('fade-out');
            setTimeout(() => indicator.remove(), 300);
        }
        this.isAnalyzing = false;
        this.isTyping = false;
    }

    hideTypingIndicator() {
        if (window.animationController) {
            window.animationController.hideCognitiveIndicator();
        } else {
            const indicator = document.getElementById('typingIndicator') || document.getElementById('cognitiveIndicator');
            if (indicator) indicator.remove();
        }
        this.isTyping = false;
        this.currentTypingIndicator = null;
    }

    setLoadingState(loading) {
        this.isLoading = loading;
        if (loading) {
            document.body.classList.add('is-generating');
        } else {
            document.body.classList.remove('is-generating');
        }
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

        // Store file reference before clearing preview (for API call)
        const fileToSend = this.selectedFile;
        const fileContentToSend = this.selectedFileContent;

        // Clear file preview immediately for better UX (file is already shown in chat)
        if (hasFile && this.filePreviewArea) {
            this.filePreviewArea.innerHTML = '';
        }

        this.messageInput.value = '';
        this.updateCharCount();
        this.autoResizeTextarea();

        // Set loading state to enable typing animation
        this.setLoadingState(true);

        // Determine analysis type for UI feedback
        let analysisType = null;
        if (hasFile) {
            analysisType = this.isImageFile(fileToSend) ? 'image' : 'file';
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
                        const servers = getServerUrls();
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
                        // Intent check failed
                    }
                })();
            }
        }

        try {
            const response = await this.callNvidiaAPI(message);

            // Finalize the streaming message (add buttons, save to memory)
            // The streaming content was already rendered during callNvidiaAPI
            this.finalizeStreamingMessage(response);
        } catch (error) {
            // Always show the same generic error message to users
            // Log the actual error details for developers (in console only)
            console.error('Chat API Error:', error);

            // Reset loading state
            this.setLoadingState(false);

            // Show generic user-friendly error
            this.showErrorMessage(error.message || 'Unknown error occurred');
        } finally {
            // Clean up file state (preview already cleared above for UX)
            this.selectedFile = null;
            this.selectedFileContent = null;
            if (this.fileInput) this.fileInput.value = '';
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

    showToast(message, type = 'info') {
        // Create toast element
        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        toast.innerHTML = `
            <i class="fas ${type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle'}"></i>
            <span>${message}</span>
        `;

        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    async callNvidiaAPI(message) {
        const selectedModel = this.modelSelect.value;

        // Define server URLs for Production/Dev
        const servers = getServerUrls();

        let lastError = null;
        let finalMessage = message;

        // Try each server in sequence until one works
        for (let i = 0; i < servers.length; i++) {
            const serverURL = servers[i];

            try {

                let options = {
                    method: 'POST',
                    timeout: 60000 // Increased timeout for file processing
                };

                // Check if we have text content extracted from a text file
                const hasTextFileContent = this.selectedFile && this.selectedFileContent;

                if (this.selectedFile && !hasTextFileContent) {
                    // Image file - use multipart form data
                    const formData = new FormData();
                    formData.append('message', finalMessage);
                    formData.append('session_id', this.sessionId);
                    formData.append('model', selectedModel);
                    formData.append('mode', this.currentMode); // Add mode
                    formData.append('reasoning_mode', this.reasoningMode.toString()); // Add reasoning mode
                    formData.append('file', this.selectedFile);

                    options.body = formData;
                } else {
                    // Text-only OR text file with extracted content
                    options.headers = { 'Content-Type': 'application/json' };

                    // If we have extracted text content from a file, prepend it to the message
                    if (hasTextFileContent) {
                        const fileName = this.selectedFile.name;
                        finalMessage = `User uploaded a file: ${fileName}\n\nFile content:\n\`\`\`\n${this.selectedFileContent}\n\`\`\`\n\nUser question: ${message || 'Analyze this file'}`;
                    }

                    options.body = JSON.stringify({
                        message: finalMessage,
                        model: selectedModel,
                        session_id: this.sessionId,
                        mode: this.currentMode, // Send current mode (study/default)
                        reasoning_mode: this.reasoningMode, // Send reasoning mode toggle
                        max_tokens: 1024,
                        temperature: 0.7
                    });
                }

                // Unified request handling for all modes (Default & Study)
                const response = await fetch(`${serverURL}/api/chat`, options);

                if (!response.ok) {
                    let errorMsg = `HTTP error! status: ${response.status}`;
                    try {
                        const errData = await response.json();
                        if (errData.error) errorMsg = errData.error;
                    } catch (e) { }
                    throw new Error(errorMsg);
                }

                // Determine if response is JSON (Non-Streaming) or Stream
                const contentType = response.headers.get('content-type');

                // Initialize message bubble
                this.addMessageWithTyping("", 'bot', true, true);

                if (contentType && contentType.includes('application/json')) {
                    // Handle JSON Response (Non-Streaming)
                    const data = await response.json();

                    if (data.error) throw new Error(data.error);

                    // Update Tokens and Persist properly
                    if (data.conversation_stats) {
                        this.conversationStats = data.conversation_stats;
                        this.updateConversationStatsUI(true);
                        if (window.chatSaver) {
                            window.chatSaver.updateChatStats(this.sessionId, this.conversationStats);
                        }
                    }

                    // Render Content
                    this.streamToMessage(data.response);

                    return data.response;

                } else {
                    // Handle Streaming Response
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder("utf-8");
                    let bufferedText = "";
                    let fullMessage = "";
                    let isFirstChunk = true;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        bufferedText += chunk;
                        fullMessage += chunk;

                        // Parse potential error JSON in first chunk
                        if (isFirstChunk && chunk.trim().startsWith('{') && chunk.includes('"error"')) {
                            try {
                                const errObj = JSON.parse(chunk);
                                if (errObj.error) throw new Error(errObj.error);
                            } catch (e) {
                                // ignore if not valid json
                            }
                        }

                        // Update UI
                        this.streamToMessage(bufferedText);
                        bufferedText = fullMessage; // Keep full message state

                        isFirstChunk = false;
                    }

                    return fullMessage;
                }

            } catch (error) {
                lastError = error;
                if (i < servers.length - 1) continue;
            }
        }

        this.updateStatus('Connection Failed', '#ef4444');
        throw lastError || new Error('All servers are unavailable');
    }

    // Restoring standard addMessage for compatibility with ChatSaver and non-streaming calls
    addMessage(content, sender, save = true, loadedIndex = null) {
        // Use the unified method but ensuring legacy behavior for storage
        // If loadedIndex is provided, it's a restore operation

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
            // User message - bubble with actions below (ChatGPT style)
            // Track message index for editing (use loadedIndex for restored chats, or compute for new)
            const msgIndex = loadedIndex !== null ? loadedIndex : (save ? this.messages.length - 1 : -1);
            messageDiv.dataset.msgIndex = msgIndex;

            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = content;

            // Action buttons below message (Copy and Edit)
            const actions = document.createElement('div');
            actions.className = 'message-actions user-actions';
            actions.innerHTML = `
                <button class="action-btn copy-action" title="Copy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button class="action-btn edit-action" title="Edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
            `;

            messageDiv.appendChild(bubble);
            messageDiv.appendChild(actions);

            this.attachUserActionListeners(actions, content, messageDiv, msgIndex);
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

        // Append message to chat
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
        return messageDiv;
    }

    // New Helper to add message scaffolding for streaming
    addMessageWithTyping(content, sender, save = true, isStreaming = false) {
        // ... (existing logic for setup)
        const storageRole = (sender === 'bot') ? 'assistant' : sender;
        if (save) {
            // We will update the content later if streaming
            if (!isStreaming) {
                this.messages.push({ role: storageRole, content: content });
                if (window.chatSaver) window.chatSaver.saveCurrentChat();
            }
        }

        this.hideWelcomeScreen();

        // Remove indicators
        const typingIndicator = document.getElementById('typingIndicator');
        const analyzingIndicator = document.getElementById('analyzingIndicator');
        if (typingIndicator) typingIndicator.remove();
        if (analyzingIndicator) analyzingIndicator.remove();

        // Create Message Div
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        messageDiv.dataset.streaming = isStreaming ? "true" : "false";

        // Bot message structure
        const inner = document.createElement('div');
        inner.className = 'message-inner';

        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = '<p></p>'; // Start empty

        inner.appendChild(messageContent);
        messageDiv.appendChild(inner);

        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();

        // Store reference to current streaming elements
        if (isStreaming) {
            this.currentStreamContent = messageContent;
            this.currentStreamInner = inner;
            this.currentStreamMessageDiv = messageDiv;
            this.currentFullText = "";
        } else {
            // Static content (legacy)
            this.displayMessageInstantly(content, messageContent, inner);
        }
    }

    streamToMessage(fullText) {
        if (!this.currentStreamContent) return;
        this.currentFullText = fullText;

        // Sanitize & Render
        let renderedHTML = this.renderMarkdown(fullText);

        // Smart Update: Prevent header flickering by updating content only if possible
        const parsingContainer = document.createElement('div');
        parsingContainer.innerHTML = renderedHTML;
        const newActiveBlock = parsingContainer.querySelector('.thought-block.thinking-active');
        const currentActiveBlock = this.currentStreamContent.querySelector('.thought-block.thinking-active');

        // If we have a matching active block in both new and current, update in-place
        if (newActiveBlock && currentActiveBlock &&
            newActiveBlock.dataset.thoughtId === currentActiveBlock.dataset.thoughtId) {

            const newInner = newActiveBlock.querySelector('.thought-content');
            const currentInner = currentActiveBlock.querySelector('.thought-content');

            if (newInner && currentInner) {
                if (currentInner.innerHTML !== newInner.innerHTML) {
                    currentInner.innerHTML = newInner.innerHTML;
                }
                this.scrollToBottom();
                return; // Skip full re-render to preserve animation state
            }
        }

        // Fallback: Full Re-render
        // Capture currently expanded blocks by ID to persist state across re-renders
        const expandedIds = new Set();
        this.currentStreamContent.querySelectorAll('.thought-block.expanded').forEach(block => {
            if (block.dataset.thoughtId) expandedIds.add(block.dataset.thoughtId);
        });

        // Re-apply expanded state
        expandedIds.forEach(id => {
            // Regex to find the div for this ID and inject 'expanded' class
            const regex = new RegExp(`(<div class="thought-block[^"]*)"([^>]*data-thought-id="${id}")`, 'g');
            renderedHTML = renderedHTML.replace(regex, '$1 expanded"$2');
        });

        // Update DOM
        this.currentStreamContent.innerHTML = renderedHTML;

        // Auto Scroll
        this.scrollToBottom();
    }

    // Finalize the streaming message - add action buttons, save to memory
    finalizeStreamingMessage(fullText) {
        if (!this.currentStreamContent || !this.currentStreamInner) return;

        // Hide any remaining indicators
        this.hideTypingIndicator();
        this.hideAnalyzingIndicator();

        // Calculate and bake in duration for thought blocks to stop the timer
        const now = Date.now();
        fullText = fullText.replace(/<think start="([^"]*)">/g, (match, startTs) => {
            const startTime = parseInt(startTs, 10);
            const duration = Math.round((now - startTime) / 1000);
            return `<think start="${startTs}" duration="${duration}">`;
        });

        // Final render with correct durations
        this.streamToMessage(fullText);

        // Add action buttons now that streaming is complete
        if (!this.currentStreamInner.querySelector('.message-actions')) {
            this.addMessageActions(this.currentStreamInner, fullText);
        }

        // Setup copy listeners for code blocks
        this.attachCopyListeners(this.currentStreamContent);

        // Save to memory
        this.messages.push({ role: 'assistant', content: fullText });
        if (window.chatSaver) window.chatSaver.saveCurrentChat();

        // Clear streaming state
        this.currentStreamContent = null;
        this.currentStreamInner = null;

        // Fetch updated stats to ensure token counts and session info are current
        this.getConversationStats();
        this.currentStreamMessageDiv = null;
        this.currentFullText = "";

        // Reset loading state
        this.setLoadingState(false);
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

            // Like button - only activate on click, hide other when selected
            const likeBtn = actionsEl.querySelector('button[title="Good response"]');
            const dislikeBtn = actionsEl.querySelector('button[title="Bad response"]');

            if (likeBtn) {
                likeBtn.addEventListener('click', () => {
                    likeBtn.classList.add('active');
                    // Hide the dislike button when like is selected
                    if (dislikeBtn) {
                        dislikeBtn.style.display = 'none';
                    }
                });
            }

            // Dislike button - only activate on click, hide other when selected
            if (dislikeBtn) {
                dislikeBtn.addEventListener('click', () => {
                    dislikeBtn.classList.add('active');
                    // Hide the like button when dislike is selected
                    if (likeBtn) {
                        likeBtn.style.display = 'none';
                    }
                });
            }
        }
    }

    // Handle user message actions (Copy + Edit)
    attachUserActionListeners(actionsEl, content, messageDiv, msgIndex) {
        // Copy button
        const copyBtn = actionsEl.querySelector('.copy-action');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(content).then(() => {
                    copyBtn.classList.add('copied');
                    setTimeout(() => copyBtn.classList.remove('copied'), 2000);
                });
            });
        }

        // Edit button
        const editBtn = actionsEl.querySelector('.edit-action');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.enableMessageEdit(messageDiv, content, msgIndex);
            });
        }
    }

    // Enable inline editing of user message (ChatGPT style)
    enableMessageEdit(messageDiv, originalContent, msgIndex) {
        // Store original structure
        const originalHTML = messageDiv.innerHTML;
        const bubble = messageDiv.querySelector('.message-bubble');
        const actions = messageDiv.querySelector('.message-actions');

        if (!bubble) return;

        // Hide original content
        bubble.style.display = 'none';
        if (actions) actions.style.display = 'none';

        // Create edit container
        const editContainer = document.createElement('div');
        editContainer.className = 'message-edit-container';
        editContainer.innerHTML = `
            <textarea class="message-edit-textarea">${this.escapeHTML(originalContent)}</textarea>
            <div class="message-edit-actions">
                <button class="edit-cancel-btn">Cancel</button>
                <button class="edit-send-btn">Send</button>
            </div>
        `;

        messageDiv.appendChild(editContainer);

        const textarea = editContainer.querySelector('.message-edit-textarea');
        const cancelBtn = editContainer.querySelector('.edit-cancel-btn');
        const sendBtn = editContainer.querySelector('.edit-send-btn');

        // Focus and select all text
        textarea.focus();
        textarea.select();

        // Auto-resize textarea
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        };
        autoResize();
        textarea.addEventListener('input', autoResize);

        // Cancel button
        cancelBtn.addEventListener('click', () => {
            editContainer.remove();
            bubble.style.display = '';
            if (actions) actions.style.display = '';
        });

        // Send button
        sendBtn.addEventListener('click', () => {
            const newContent = textarea.value.trim();
            if (newContent && newContent !== originalContent) {
                this.submitEditedMessage(messageDiv, newContent, msgIndex);
            } else {
                // No change or empty - just cancel
                editContainer.remove();
                bubble.style.display = '';
                if (actions) actions.style.display = '';
            }
        });

        // Handle keyboard shortcuts
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                cancelBtn.click();
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendBtn.click();
            }
        });
    }

    // Submit edited message and regenerate response
    async submitEditedMessage(messageDiv, newContent, msgIndex) {
        if (msgIndex < 0 || this.isLoading) return;

        // Remove edit container and update bubble
        const editContainer = messageDiv.querySelector('.message-edit-container');
        if (editContainer) editContainer.remove();

        const bubble = messageDiv.querySelector('.message-bubble');
        const actions = messageDiv.querySelector('.message-actions');

        if (bubble) {
            bubble.textContent = newContent;
            bubble.style.display = '';
        }
        if (actions) actions.style.display = '';

        // Update the message in the messages array
        this.messages[msgIndex].content = newContent;

        // Remove all messages after this one from the array
        this.messages = this.messages.slice(0, msgIndex + 1);

        // Remove all DOM elements after this message
        let sibling = messageDiv.nextElementSibling;
        while (sibling) {
            const nextSibling = sibling.nextElementSibling;
            sibling.remove();
            sibling = nextSibling;
        }

        // Save updated conversation
        if (window.chatSaver) window.chatSaver.saveCurrentChat();

        // Now send the edited message to get a new AI response
        this.isLoading = true;
        this.showTypingIndicator();

        // Check for Web Search Requirement (Non-blocking / Parallel)
        if (newContent && newContent.length > 5) {
            (async () => {
                try {
                    const servers = getServerUrls();
                    const serverURL = servers[0];

                    const checkResp = await fetch(`${serverURL}/api/classify`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: newContent })
                    });

                    if (checkResp.ok) {
                        const checkData = await checkResp.json();
                        if (checkData.web_required && this.isLoading && document.getElementById('typingIndicator')) {
                            this.hideTypingIndicator();
                            this.showAnalyzingIndicator('wiki');
                        }
                    }
                } catch (e) {
                    // Intent check failed
                }
            })();
        }

        try {
            const response = await this.callNvidiaAPI(newContent);
            // Finalize the streaming message (add buttons, save to memory)
            this.finalizeStreamingMessage(response);
        } catch (error) {
            console.error('Chat API Error:', error);
            this.isLoading = false;
            this.showErrorMessage(error.message || 'Unknown error occurred');
        }
    }

    // Legacy typing animation method (for non-streaming scenarios like stop/resume)
    addMessageWithTypingAnimation(content, sender, save = true) {
        // Store message in memory
        // Normalize role: 'bot' -> 'assistant' for storage consistency with API
        const storageRole = (sender === 'bot') ? 'assistant' : sender;
        if (save) {
            this.messages.push({ role: storageRole, content: content });
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
        // NOTE: Message saving is handled by the caller (addMessageWithTyping)
        // Do NOT push to this.messages here to avoid duplicates
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
                // NOTE: Message saving is handled by addMessageWithTyping caller
                this.hideTypingIndicator();

                // Add action buttons after typing is complete
                if (inner && !inner.querySelector('.message-actions')) {
                    this.addMessageActions(inner, content);
                }

                // Save chat after bot response completes
                if (window.chatSaver) {
                    window.chatSaver.saveCurrentChat();
                }
            }
        }, 10);
    }

    async typeCodeBlockContent(content, messageContent, messageDiv, processedContent) {
        this.safeSetHTML(messageContent, processedContent);


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
            this.typeRegularText(content, messageContent, messageDiv, processedContent);
            return;
        }

        const contentContainers = messageContent.querySelectorAll('.code-content');

        if (contentContainers.length === 0) {
            this.attachCopyListeners(messageContent);
            this.hideTypingIndicator();
            // NOTE: Message saving is handled by addMessageWithTyping caller
            // Save chat after bot response
            if (window.chatSaver) {
                window.chatSaver.saveCurrentChat();
            }
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
                this.attachCopyListeners(messageContent);
                this.scrollToBottom();
                this.hideTypingIndicator();
                // NOTE: Message saving is handled by addMessageWithTyping caller
                // Save chat after bot response
                if (window.chatSaver) {
                    window.chatSaver.saveCurrentChat();
                }
                return;
            }

            const codeBlock = codeBlocks[currentBlockIndex];
            const container = contentContainers[currentBlockIndex];

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
                    clearInterval(this.currentTypingInterval);
                    this.currentTypingInterval = null;

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
                // NOTE: Message saving is handled by addMessageWithTyping caller
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
        // Longer duration for smoother "counting up" feel
        const duration = 1500;
        const startTime = performance.now();
        const range = end - start;

        // Add counting class to parent for glow effect
        if (element.parentElement) {
            element.parentElement.classList.add('counting');
        }

        const update = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease out cubic for smooth "landing"
            const ease = 1 - Math.pow(1 - progress, 3);

            const currentVal = Math.floor(start + (range * ease));

            const displayVal = currentVal > 999 ? `${(currentVal / 1000).toFixed(1)}K` : currentVal;
            element.textContent = displayVal;

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                const finalVal = end > 999 ? `${(end / 1000).toFixed(1)}K` : end;
                element.textContent = finalVal;

                // Remove counting class
                if (element.parentElement) {
                    element.parentElement.classList.remove('counting');
                }
            }
        };

        requestAnimationFrame(update);
    }

    updateConversationStatsUI(animate = false) {
        if (!this.conversationStats) {
            // Default to 0 tokens if no stats
        }

        const stats = this.conversationStats || { total_tokens: 0, max_tokens: 128000, utilization_percent: 0, current_model: null };
        const { total_tokens, displayed_tokens, max_tokens, utilization_percent, current_model } = stats;

        // Update header context info
        if (this.contextInfo && this.contextValue) {
            this.contextInfo.style.display = 'inline-flex'; // Updated to inline-flex

            const startTokens = this.currentStatsTokens || 0;
            const endTokens = displayed_tokens || 0;
            this.currentStatsTokens = endTokens;

            if (animate && startTokens !== endTokens) {
                this.animateTokenDisplay(this.contextValue, startTokens, endTokens);
            } else {
                const contextDisplay = endTokens > 999 ? `${(endTokens / 1000).toFixed(1)}K` : endTokens;
                this.contextValue.textContent = contextDisplay;
            }

            // Use CSS classes for color states instead of inline styles
            this.contextValue.classList.remove('warning', 'danger');
            if (utilization_percent > 80) {
                this.contextValue.classList.add('danger');
            } else if (utilization_percent > 60) {
                this.contextValue.classList.add('warning');
            }
        }

        if (!current_model) {
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

        // Update status text display
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
        this.setLoadingState(false);

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

    scrollToBottom(force = false) {
        if (force) {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
            return;
        }

        // Smart scrolling: Only auto-scroll if user is near the bottom
        const threshold = 100; // pixels
        const position = this.chatMessages.scrollTop + this.chatMessages.clientHeight;
        const height = this.chatMessages.scrollHeight;

        if (height - position < threshold) {
            this.chatMessages.scrollTop = height;
        }
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

    // SERVER HEALTH STATE MACHINE
    initServerHealthCheck() {
        this.serverState = 'unknown'; // unknown, checking, online, degraded, offline
        this.healthCheckInterval = null;
        this.connectedServer = null;

        // Start polling
        this.checkServerStatus();
        this.healthCheckInterval = setInterval(() => this.checkServerStatus(), 30000); // Check every 30s
    }

    async checkServerStatus() {
        // Transition to checking state if currently unknown or offline
        if (this.serverState === 'unknown' || this.serverState === 'offline') {
            this.serverState = 'checking';
            this.updateStatus('Checking...', '#fbbf24'); // Yellow
        }

        try {
            // Define server URLs with primary and failover
            const servers = getServerUrls();

            let connected = false;
            let currentServerName = '';

            // Try each server in sequence
            for (let i = 0; i < servers.length; i++) {
                const serverURL = servers[i];

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);

                    const response = await fetch(`${serverURL}/health`, {
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (response.ok) {
                        connected = true;
                        const serverHost = (new URL(serverURL)).hostname;
                        currentServerName = serverHost.includes('render') ? 'Primary' :
                            (serverHost.includes('pythonanywhere') ? 'Failover' : 'Local');

                        if (this.connectedServer !== currentServerName || this.serverState !== 'online') {
                            // Server connected
                        }

                        this.connectedServer = currentServerName;
                        break;
                    }
                } catch (error) {
                    // Silent fail for individual servers
                }
            }

            // Update State & UI
            if (connected) {
                if (this.serverState !== 'online') {
                    this.serverState = 'online';
                    this.updateStatus(`Ready (${this.connectedServer})`, '#4ade80');
                    if (this.statusPingInner) {
                        this.statusPingInner.style.backgroundColor = '#4ade80';
                        this.statusPingInner.style.boxShadow = '0 0 10px #4ade80';
                    }
                }
            } else {
                // Only show offline if we failed after a valid check
                if (this.serverState !== 'offline') {
                    this.serverState = 'offline';
                    this.updateStatus('All Servers Offline', '#ef4444');
                    if (this.statusPingInner) {
                        this.statusPingInner.style.backgroundColor = '#ef4444';
                        this.statusPingInner.style.boxShadow = 'none';
                    }
                }
            }

        } catch (error) {
            console.error('Health check fatal error:', error);
            this.serverState = 'offline';
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
        const isActive = this.modelDropdown?.classList.contains('active');
        if (isActive) {
            this.closeDropdown();
        } else {
            this.openDropdown();
        }
    }

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

    setupMobileViewport() {
        // Fix for mobile keyboard covering input
        const setHeight = () => {
            const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            document.documentElement.style.setProperty('--app-height', `${height}px`);
        };

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', setHeight);
            window.visualViewport.addEventListener('scroll', setHeight);
        }
        window.addEventListener('resize', setHeight);
        setHeight(); // Initial set
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
            }

            this.updateCharCount();
            this.autoResizeTextarea();
            this.messageInput.focus();

            // Set timeout to stop after silence
            this.silenceTimeout = setTimeout(() => {
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

    // ============================================
    // SECURE LINK CONFIRMATION (ChatGPT Style)
    // ============================================

    setupSecureLinkHandler() {
        // Use event delegation on chat messages container
        if (this.chatMessages) {
            this.chatMessages.addEventListener('click', (e) => {
                const link = e.target.closest('.secure-link');
                if (link && link.dataset.external === 'true') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.showLinkConfirmation(link.href);
                }
            });
        }
    }

    showLinkConfirmation(url) {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'link-modal-overlay';
        overlay.innerHTML = `
            <div class="link-modal">
                <div class="link-modal-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                </div>
                <h3 class="link-modal-title">You're about to leave this site</h3>
                <p class="link-modal-text">This link will open in a new tab:</p>
                <div class="link-modal-url">${this.escapeHTML(url)}</div>
                <p class="link-modal-warning">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    Be cautious when visiting external websites
                </p>
                <div class="link-modal-actions">
                    <button class="link-modal-cancel">Cancel</button>
                    <button class="link-modal-open">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                        Open Link
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('active');
        });

        // Event handlers
        const cancelBtn = overlay.querySelector('.link-modal-cancel');
        const openBtn = overlay.querySelector('.link-modal-open');

        const closeModal = () => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 200);
        };

        cancelBtn.addEventListener('click', closeModal);

        openBtn.addEventListener('click', () => {
            // Open in new tab with security attributes
            window.open(url, '_blank', 'noopener,noreferrer');
            closeModal();
        });

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        // Close on Escape
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.chatbot = new Chatbot();
});


