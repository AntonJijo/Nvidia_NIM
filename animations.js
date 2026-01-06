/**
 * NVIDIA NIM - Premium Animations Controller
 * Handles all dynamic animations and micro-interactions
 */

class AnimationController {
    constructor() {
        this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.init();
    }

    init() {
        if (this.prefersReducedMotion) {
            return;
        }

        this.initPageLoadAnimations();
        this.initHeaderAnimations();
        this.initMessageAnimations();
        this.initInputAnimations();
        this.initHoverEffects();
        this.initScrollReveal();
        this.listenForReducedMotionChanges();
    }

    /**
     * 1. PAGE LOAD & FIRST IMPRESSIONS
     */
    /**
     * 1. PAGE LOAD & FIRST IMPRESSIONS
     */
    initPageLoadAnimations() {
        // PREMIUM LOGO LOADER - DISABLED FOR INSTANT LOAD
        this.revealAppContent();

        // Add animated background
        if (document.body) {
            document.body.classList.add('animated-background');
        }

        // Add noise overlay
        const mainContent = document.querySelector('.main-content');
        if (mainContent && !mainContent.classList.contains('noise-overlay')) {
            mainContent.classList.add('noise-overlay');
        }
    }

    revealAppContent() {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.style.opacity = '1';
        }
    }

    /**
     * 2. HEADER & NAVIGATION POLISHING
     */
    initHeaderAnimations() {
        // Header is now static - no scroll effects
        // Animated counters for context info
        this.setupAnimatedCounters();
    }

    setupAnimatedCounters() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList' || mutation.type === 'characterData') {
                    const target = mutation.target;
                    if (target.id === 'contextValue' || target.classList?.contains('stat-value')) {
                        this.animateCounter(target);
                    }
                }
            });
        });

        // Observe context info and stats
        const contextValue = document.getElementById('contextValue');
        if (contextValue) {
            observer.observe(contextValue, { childList: true, characterData: true, subtree: true });
        }

        // Observe all stat values
        document.querySelectorAll('.stat-value').forEach((el) => {
            observer.observe(el, { childList: true, characterData: true, subtree: true });
        });
    }

    animateCounter(element) {
        if (!element) return;

        element.classList.add('animated-counter', 'updating');
        setTimeout(() => {
            element.classList.remove('updating');
        }, 500);
    }

    /**
     * 3. MODEL CARDS & SELECTOR INTERACTION
     */
    initModelCardAnimations() {
        const modelCards = document.querySelectorAll('.model-card');
        const modelOptions = document.querySelectorAll('.model-option');

        // Add 3D tilt effect on mouse move
        modelCards.forEach((card) => {
            card.addEventListener('mousemove', (e) => {
                if (this.prefersReducedMotion) return;

                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const rotateX = ((y - centerY) / centerY) * 5; // Max 5deg
                const rotateY = ((x - centerX) / centerX) * -5; // Max 5deg

                card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
            });

            card.addEventListener('mouseleave', () => {
                card.style.transform = '';
            });
        });

        // Pulse animation for model logos
        modelOptions.forEach((option) => {
            option.addEventListener('mouseenter', () => {
                const icon = option.querySelector('svg, .model-logo');
                if (icon) {
                    icon.style.animation = 'gentlePulse 2s infinite';
                }
            });

            option.addEventListener('mouseleave', () => {
                const icon = option.querySelector('svg, .model-logo');
                if (icon) {
                    icon.style.animation = '';
                }
            });
        });
    }

    /**
     * 4. CHAT INITIALIZATION & COGNITIVE ANIMATION
     */
    showCognitiveIndicator(container = null) {
        // Toggle header state
        const header = document.querySelector('.chat-header');
        if (header) header.classList.add('generating');

        const chatMessages = container || document.querySelector('.chat-messages');
        if (!chatMessages) return null;

        const indicatorWrapper = document.createElement('div');
        indicatorWrapper.className = 'ai-typing-indicator';
        indicatorWrapper.id = 'cognitiveIndicator';

        // Structure for Cognitive Lattice
        indicatorWrapper.innerHTML = `
            <div class="cognitive-indicator">
                <div class="cognitive-node node-1"></div>
                <div class="cognitive-node node-2"></div>
                <div class="cognitive-node node-3"></div>
                <div class="cognitive-link link-1"></div>
                <div class="cognitive-link link-2"></div>
            </div>
            <span style="color: var(--text-secondary); font-size: 13px; margin-left: 12px;">Reasoning...</span>
        `;

        chatMessages.appendChild(indicatorWrapper);
        this.scrollToBottom(chatMessages);

        // GSAP Advanced Animation for Cognitive Lattice
        if (typeof gsap !== 'undefined' && !this.prefersReducedMotion) {
            const nodes = indicatorWrapper.querySelectorAll('.cognitive-node');
            const links = indicatorWrapper.querySelectorAll('.cognitive-link');

            // Initial positioning
            gsap.set(nodes[0], { x: -15, y: 0 });
            gsap.set(nodes[1], { x: 0, y: -10 });
            gsap.set(nodes[2], { x: 15, y: 0 });

            // Links setup (visual only, simplified)
            gsap.set(links[0], { width: 16, x: -15, y: 0, rotation: -35 });
            gsap.set(links[1], { width: 16, x: 0, y: -10, rotation: 35 });

            // Breathing / Thinking Motion
            gsap.to(nodes, {
                y: '+=3',
                duration: 1.5,
                stagger: {
                    each: 0.2,
                    yoyo: true,
                    repeat: -1
                },
                ease: 'sine.inOut'
            });

            gsap.to(nodes, {
                scale: 1.2,
                duration: 2,
                stagger: {
                    each: 0.3,
                    yoyo: true,
                    repeat: -1
                },
                ease: 'power1.inOut'
            });

            // Pulse opacity implies activity
            gsap.to(indicatorWrapper.querySelector('.cognitive-indicator'), {
                opacity: 0.7,
                duration: 1,
                yoyo: true,
                repeat: -1,
                ease: "sine.inOut"
            });
        }

        return indicatorWrapper;
    }

    hideCognitiveIndicator() {
        const header = document.querySelector('.chat-header');
        if (header) header.classList.remove('generating');

        const indicator = document.getElementById('cognitiveIndicator');
        if (indicator) {
            if (typeof gsap !== 'undefined') {
                gsap.to(indicator, {
                    opacity: 0,
                    scale: 0.9,
                    duration: 0.3,
                    onComplete: () => indicator.remove()
                });
            } else {
                indicator.style.animation = 'fadeOut 0.3s ease-out';
                setTimeout(() => indicator.remove(), 300);
            }
        }
    }

    // Legacy method for compatibility - maps to new visual
    showTypingIndicator() {
        return this.showCognitiveIndicator();
    }

    hideTypingIndicator() {
        this.hideCognitiveIndicator();
    }

    /**
     * Consume Image Input Animation
     * Shrinks the preview into the chat bubble
     */
    async consumeImageInput(previewElement) {
        if (!previewElement || this.prefersReducedMotion) return Promise.resolve();

        return new Promise((resolve) => {
            if (typeof gsap !== 'undefined') {
                gsap.to(previewElement, {
                    scale: 0.1,
                    y: -50,
                    opacity: 0,
                    duration: 0.4,
                    ease: "back.in(1.7)",
                    onComplete: resolve
                });
            } else {
                // Fallback
                previewElement.style.transition = 'all 0.4s ease-in';
                previewElement.style.transform = 'scale(0.1) translateY(-50px)';
                previewElement.style.opacity = '0';
                setTimeout(resolve, 400);
            }
        });
    }

    /**
     * 5. MESSAGE FLOW DYNAMICS
     */
    initMessageAnimations() {
        // Observe new messages being added
        const chatMessages = document.querySelector('.chat-messages');
        if (!chatMessages) return;

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1 && node.classList?.contains('message')) {
                        this.animateMessage(node);

                        // Set Chat Active State
                        document.body.classList.add('chat-active');
                        const header = document.querySelector('.chat-header');
                        if (header) header.classList.add('compact');
                    }
                });
            });
        });

        observer.observe(chatMessages, { childList: true, subtree: true });
    }

    animateMessage(messageElement) {
        if (!messageElement || this.prefersReducedMotion) return;

        // Entrance animation
        messageElement.style.opacity = '0';
        messageElement.style.transform = 'translateY(20px)';

        requestAnimationFrame(() => {
            messageElement.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
            messageElement.style.opacity = '1';
            messageElement.style.transform = 'translateY(0)';
        });

        // Staggered word reveal for bot messages
        if (messageElement.classList.contains('bot-message')) {
            this.staggerWordReveal(messageElement);
        }
    }

    staggerWordReveal(messageElement) {
        const content = messageElement.querySelector('.message-content');
        if (!content) return;

        const text = content.textContent;
        const words = text.split(' ');

        if (words.length > 50 || this.prefersReducedMotion) return; // Skip for long messages

        content.innerHTML = '';
        words.forEach((word, index) => {
            const span = document.createElement('span');
            span.className = 'word-reveal';
            span.textContent = word + ' ';
            span.style.animationDelay = `${index * 0.03}s`;
            content.appendChild(span);
        });
    }

    /**
     * 6. USER INTERACTION FEEDBACK
     */
    initInputAnimations() {
        const inputWrapper = document.getElementById('inputWrapper');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');

        if (!inputWrapper || !messageInput) return;

        // Focus effects
        messageInput.addEventListener('focus', () => {
            inputWrapper.classList.add('focused');
        });

        messageInput.addEventListener('blur', () => {
            inputWrapper.classList.remove('focused');
        });

        // Send button elastic bounce
        if (sendButton) {
            sendButton.addEventListener('click', () => {
                if (!this.prefersReducedMotion) {
                    sendButton.classList.add('sending');
                    setTimeout(() => {
                        sendButton.classList.remove('sending');
                    }, 600);
                }
            });
        }
    }

    /**
     * 7. ANIMATED RESPONSE STREAMING
     */
    animateStreamingText(element, text, speed = 20) {
        if (!element || this.prefersReducedMotion) {
            element.textContent = text;
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            element.textContent = '';
            let index = 0;

            const interval = setInterval(() => {
                if (index < text.length) {
                    const char = document.createElement('span');
                    char.className = 'streaming-char';
                    char.textContent = text[index];
                    char.style.animationDelay = '0s';
                    element.appendChild(char);
                    index++;
                } else {
                    clearInterval(interval);
                    resolve();
                }
            }, speed);
        });
    }

    /**
     * 8. HOVER & MICRO-INTERACTIONS
     */
    initHoverEffects() {
        // Add lift effect to all buttons
        document.querySelectorAll('button:not(.no-lift)').forEach((btn) => {
            btn.classList.add('btn-lift');
        });

        // Icon hover effects
        document.querySelectorAll('.sidebar-menu-item svg, .input-action-btn svg').forEach((icon) => {
            icon.classList.add('icon-hover');
        });

        // Message bubble hover
        const observer = new MutationObserver(() => {
            document.querySelectorAll('.user-message .message-bubble').forEach((bubble) => {
                if (!bubble.dataset.hoverAdded) {
                    bubble.dataset.hoverAdded = 'true';
                }
            });
        });

        const chatMessages = document.querySelector('.chat-messages');
        if (chatMessages) {
            observer.observe(chatMessages, { childList: true, subtree: true });
        }
    }

    /**
     * 9. ERROR & RECOVERY UI STATES
     */
    showErrorAnimation(element, message) {
        if (!element) return;

        element.classList.add('error-shake');

        // Create error message
        const errorMsg = document.createElement('div');
        errorMsg.className = 'error-message';
        errorMsg.innerHTML = `
            <i class="fas fa-exclamation-circle"></i>
            <span>${message}</span>
        `;
        errorMsg.style.cssText = 'color: #ef4444; padding: 8px; animation: fadeInScale 0.3s ease;';

        element.appendChild(errorMsg);

        setTimeout(() => {
            element.classList.remove('error-shake');
            errorMsg.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => errorMsg.remove(), 300);
        }, 3000);
    }

    showSuccessAnimation(element) {
        if (!element) return;

        element.classList.add('success-bounce', 'sparkle');

        setTimeout(() => {
            element.classList.remove('success-bounce', 'sparkle');
        }, 1000);
    }

    /**
     * 10. SCROLL REVEAL
     */
    initScrollReveal() {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                    }
                });
            },
            { threshold: 0.1 }
        );

        // Observe all scroll-reveal elements
        document.querySelectorAll('.scroll-reveal').forEach((el) => {
            observer.observe(el);
        });
    }

    /**
     * UTILITY METHODS
     */
    scrollToBottom(container, smooth = true) {
        if (!container) return;

        if (smooth && !this.prefersReducedMotion) {
            container.scrollTo({
                top: container.scrollHeight,
                behavior: 'smooth'
            });
        } else {
            container.scrollTop = container.scrollHeight;
        }
    }

    listenForReducedMotionChanges() {
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        mediaQuery.addEventListener('change', (e) => {
            this.prefersReducedMotion = e.matches;
        });
    }

    /**
     * Quick Reply Buttons Animation
     */
    showQuickReplies(replies, container) {
        if (!container || !replies) return;

        const repliesContainer = document.createElement('div');
        repliesContainer.className = 'quick-replies';
        repliesContainer.style.cssText = 'display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;';

        replies.forEach((reply, index) => {
            const btn = document.createElement('button');
            btn.className = 'quick-reply-btn btn-lift';
            btn.textContent = reply;
            btn.style.cssText = `
                padding: 8px 16px;
                background: var(--bg-hover);
                border: 1px solid var(--border-color);
                border-radius: 16px;
                color: var(--text-primary);
                font-size: 14px;
                cursor: pointer;
                animation-delay: ${index * 0.1}s;
            `;

            repliesContainer.appendChild(btn);
        });

        container.appendChild(repliesContainer);
    }

    /**
     * Enhanced Status Updates
     */
    updateStatusWithAnimation(statusElement, text, color) {
        if (!statusElement) return;

        statusElement.style.animation = 'fadeSlideIn 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
        statusElement.textContent = text;

        if (color) {
            statusElement.style.color = color;
        }
    }

    /**
     * Model Change Animation
     */
    animateModelChange(oldModel, newModel) {
        const modelName = document.getElementById('currentModelName');
        if (!modelName) return;

        // Fade out
        modelName.style.transition = 'opacity 0.2s ease';
        modelName.style.opacity = '0';

        setTimeout(() => {
            modelName.textContent = newModel;
            modelName.style.opacity = '1';

            // Add glow effect temporarily
            modelName.classList.add('glow-text');
            setTimeout(() => {
                modelName.classList.remove('glow-text');
            }, 2000);
        }, 200);
    }
}

// Keyframe animations that need to be added via JS
const additionalKeyframes = `
    @keyframes fadeOut {
        from {
            opacity: 1;
            transform: scale(1);
        }
        to {
            opacity: 0;
            transform: scale(0.9);
        }
    }
`;

// Add additional keyframes to document
const styleSheet = document.createElement('style');
styleSheet.textContent = additionalKeyframes;
document.head.appendChild(styleSheet);

// Initialize animation controller when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.animationController = new AnimationController();
    });
} else {
    window.animationController = new AnimationController();
}

// Export for use in other scripts
window.AnimationController = AnimationController;
