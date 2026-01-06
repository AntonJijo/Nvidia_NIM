/**
 * ============================================
 * CYBER-DECK LOADING SYSTEM
 * Premium Neural Intelligence Core Animation
 * ============================================
 */

class LoadingSystem {
    constructor() {
        this.tl = null;
        this.particles = [];
        this.dataStreams = [];
        this.statusMessages = [
            "ESTABLISHING UPLINK",
            "SYNCHRONIZING NEURAL WEAVE",
            "CALIBRATING QUANTUM MATRIX",
            "INITIALIZING CORE PROTOCOLS",
            "SYSTEM ONLINE"
        ];
        this.scrambleChars = "!@#$%^&*()_+-=[]{}|;:,.<>?/~`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

        // NVIDIA Logo SVG Path (simplified for animation)
        this.logoPath = `M1557.9 -0.5L1557.9 1029.78L581.99 1029.78L581.99 908.81C602.63 911.1 623.28 912.25 645.06 912.25C870.98 912.25 1269.49 797.01 1440.36 653.67C1415.13 628.45 1292.99 570.54 1263.18 546.46C1083.13 701.26 897.36 832.55 640.48 832.55C620.98 832.55 600.91 830.83 581.42 828.54L581.42 742.54C604.93 746.55 628.44 748.85 652.52 748.85C928.32 748.85 1193.23 426.63 1193.23 426.63C1193.23 426.63 962.15 124.49 608.37 136.53L580.84 138.25L580.84 -0.5L1557.9 -0.5ZM608.37 212.78C862.95 204.75 1029.81 431.79 1029.81 431.79C1029.81 431.79 849.76 681.77 656.53 681.77C630.73 681.77 605.5 677.75 581.42 669.73L581.42 387.65C680.61 399.69 700.68 443.26 759.74 542.45L892.2 431.22C892.2 431.22 795.29 304.51 632.45 304.51C615.25 303.94 598.05 305.09 580.84 306.81L580.84 213.97C299.69 236 159.4 443.26 159.4 443.26C159.4 443.26 266.63 789.55 580.84 828.54L580.84 908.81C152.52 868.67 0 427.21 0 427.21C0 427.21 269.49 163.47 581.42 138.25L581.42 213.89C590.4 213.33 599.38 212.78 608.37 212.78ZM580.84 743.11C343.46 700.69 277.52 453.58 277.52 453.58C277.52 453.58 391.63 327.45 580.84 306.81L580.84 387.07L580.27 387.07C481.07 375.03 403.09 467.91 403.09 467.91C403.09 467.91 447.24 624.43 580.84 669.73L580.84 743.11Z`;

        this.init();
    }

    /**
     * Initialize the loading system
     */
    init() {
        this.createLoaderHTML();
        this.createParticles();
        this.createDataStreams();
        this.setupTimeline();
    }

    /**
     * Create the loader HTML structure
     */
    createLoaderHTML() {
        const loader = document.createElement('div');
        loader.id = 'skeleton-loader';

        loader.innerHTML = `
            <!-- SVG Filters for Glitch Effects -->
            <svg style="position: absolute; width: 0; height: 0;">
                <defs>
                    <filter id="redChannel">
                        <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
                    </filter>
                    <filter id="blueChannel">
                        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
                    </filter>
                </defs>
            </svg>

            <!-- Ambient Background -->
            <div class="ambient-radial"></div>
            <div class="tech-hex-pattern"></div>
            <div class="tech-grid-overlay"></div>
            
            <!-- Particles Container -->
            <div class="particles-container" id="particles-container"></div>
            
            <!-- Data Streams -->
            <div class="data-streams" id="data-streams"></div>
            
            <!-- Corner Brackets -->
            <div class="corner-brackets">
                <div class="corner tl"></div>
                <div class="corner tr"></div>
                <div class="corner bl"></div>
                <div class="corner br"></div>
            </div>
            
            <!-- Core Intelligence -->
            <div class="core-intelligence">
                <div class="glow-ring"></div>
                <div class="logo-container">
                    <!-- Wireframe Layer -->
                    <svg class="logo-svg" viewBox="0 0 1559 1032" preserveAspectRatio="xMidYMid meet">
                        <path class="logo-wireframe" fill-rule="evenodd" d="${this.logoPath}"/>
                    </svg>
                    
                    <!-- Solid Layer -->
                    <svg class="logo-svg" viewBox="0 0 1559 1032" preserveAspectRatio="xMidYMid meet">
                        <path class="logo-solid" fill-rule="evenodd" d="${this.logoPath}"/>
                    </svg>
                    
                    <!-- Scanner Beam -->
                    <div class="scanner-beam"></div>
                    
                    <!-- Glitch Layers -->
                    <div class="glitch-layer red">
                        <svg viewBox="0 0 1559 1032" preserveAspectRatio="xMidYMid meet">
                            <path class="logo-glitch-path" fill-rule="evenodd" d="${this.logoPath}"/>
                        </svg>
                    </div>
                    <div class="glitch-layer blue">
                        <svg viewBox="0 0 1559 1032" preserveAspectRatio="xMidYMid meet">
                            <path class="logo-glitch-path" fill-rule="evenodd" d="${this.logoPath}"/>
                        </svg>
                    </div>
                    
                    <!-- Pulse Ring -->
                    <div class="pulse-ring"></div>
                </div>
            </div>
            
            <!-- Peripheral UI -->
            <div class="peripheral-ui">
                <div class="progress-line-container">
                    <div class="progress-line"></div>
                    <div class="progress-glow"></div>
                </div>
                <div class="status-text-loader" id="status-text">INITIALIZING...</div>
            </div>
            
            <!-- Scan Lines Overlay -->
            <div class="scan-lines"></div>
        `;

        document.body.insertBefore(loader, document.body.firstChild);
    }

    /**
     * Create floating particles
     */
    createParticles() {
        const container = document.getElementById('particles-container');
        if (!container) return;

        const particleCount = window.innerWidth < 640 ? 20 : 40;

        for (let i = 0; i < particleCount; i++) {
            const particle = document.createElement('div');
            particle.className = i % 5 === 0 ? 'particle debris' : 'particle';

            // Random position
            particle.style.left = `${Math.random() * 100}%`;
            particle.style.top = `${Math.random() * 100}%`;

            // Random animation parameters
            particle.style.setProperty('--dx', `${(Math.random() - 0.5) * 100}px`);
            particle.style.setProperty('--dy', `${(Math.random() - 0.5) * 100}px`);
            particle.style.setProperty('--dz', `${(Math.random() - 0.5) * 200}px`);
            particle.style.animationDelay = `${Math.random() * 8}s`;
            particle.style.animationDuration = `${6 + Math.random() * 6}s`;

            if (particle.classList.contains('debris')) {
                particle.style.animationDuration = `${10 + Math.random() * 10}s`;
            }

            container.appendChild(particle);
            this.particles.push(particle);
        }
    }

    /**
     * Create data stream decorations
     */
    createDataStreams() {
        const container = document.getElementById('data-streams');
        if (!container) return;

        const streamCount = window.innerWidth < 640 ? 8 : 15;

        for (let i = 0; i < streamCount; i++) {
            const stream = document.createElement('div');
            stream.className = 'data-stream';
            stream.style.left = `${Math.random() * 100}%`;
            stream.style.height = `${50 + Math.random() * 100}px`;
            stream.style.animationDelay = `${Math.random() * 3}s`;
            stream.style.animationDuration = `${2 + Math.random() * 2}s`;
            stream.style.opacity = `${0.1 + Math.random() * 0.3}`;

            container.appendChild(stream);
            this.dataStreams.push(stream);
        }
    }

    /**
     * Scramble text effect
     */
    scrambleText(element, targetText, duration = 1) {
        return new Promise((resolve) => {
            const chars = targetText.split('');
            const iterations = 8;
            let currentIteration = 0;

            const interval = setInterval(() => {
                element.innerHTML = chars.map((char, index) => {
                    if (currentIteration > iterations * (index / chars.length)) {
                        return `<span class="scramble-char">${char}</span>`;
                    }
                    const randomChar = this.scrambleChars[Math.floor(Math.random() * this.scrambleChars.length)];
                    return `<span class="scramble-char" style="color: rgba(118, 185, 0, 0.5)">${randomChar}</span>`;
                }).join('');

                currentIteration++;

                if (currentIteration > iterations) {
                    clearInterval(interval);
                    element.textContent = targetText;
                    resolve();
                }
            }, (duration * 1000) / iterations);
        });
    }

    /**
     * Setup the GSAP timeline
     */
    setupTimeline() {
        // Ensure GSAP is loaded
        if (typeof gsap === 'undefined') {
            console.error('GSAP not loaded. Loading system requires GSAP.');
            return;
        }

        this.tl = gsap.timeline({
            onComplete: () => this.onComplete()
        });

        const loader = document.getElementById('skeleton-loader');
        const wireframe = document.querySelector('.logo-wireframe');
        const solid = document.querySelector('.logo-solid');
        const scanner = document.querySelector('.scanner-beam');
        const glitchRed = document.querySelector('.glitch-layer.red');
        const glitchBlue = document.querySelector('.glitch-layer.blue');
        const progressLine = document.querySelector('.progress-line');
        const progressGlow = document.querySelector('.progress-glow');
        const statusText = document.getElementById('status-text');
        const glowRing = document.querySelector('.glow-ring');
        const pulseRing = document.querySelector('.pulse-ring');
        const corners = document.querySelectorAll('.corner');
        const coreIntelligence = document.querySelector('.core-intelligence');

        // Calculate stroke length for animation
        if (wireframe) {
            const pathLength = wireframe.getTotalLength ? wireframe.getTotalLength() : 3500;
            wireframe.style.strokeDasharray = pathLength;
            wireframe.style.strokeDashoffset = pathLength;
        }

        // ============================================
        // PHASE 1: UPLINK - Ambient Fade In
        // ============================================
        this.tl.addLabel('uplink')
            .to('.ambient-radial', {
                opacity: 1,
                duration: 0.8,
                ease: 'power2.out'
            })
            .to('.tech-hex-pattern', {
                opacity: 0.6,
                duration: 0.6,
                ease: 'power2.out'
            }, '-=0.4')
            .to('.tech-grid-overlay', {
                opacity: 0.4,
                duration: 0.6,
                ease: 'power2.out'
            }, '-=0.4')
            .to(corners, {
                opacity: 0.6,
                duration: 0.4,
                stagger: 0.1,
                ease: 'power2.out'
            }, '-=0.3')
            .to(progressLine, {
                width: '30%',
                duration: 0.8,
                ease: 'power2.out'
            }, '-=0.6')
            .to(progressGlow, {
                width: '30%',
                duration: 0.8,
                ease: 'power2.out'
            }, '-=0.8')
            .add(() => {
                this.scrambleText(statusText, this.statusMessages[0]);
            }, '-=0.5');

        // ============================================
        // PHASE 2: WIREFRAME CONSTRUCTION
        // ============================================
        this.tl.addLabel('wireframe', '+=0.3')
            .to(glowRing, {
                opacity: 0.5,
                duration: 0.5,
                ease: 'power2.out'
            })
            .to(wireframe, {
                strokeDashoffset: 0,
                duration: 2,
                ease: 'power2.inOut'
            }, '-=0.3')
            .to(progressLine, {
                width: '50%',
                duration: 1.5,
                ease: 'power2.out'
            }, '-=2')
            .to(progressGlow, {
                width: '50%',
                duration: 1.5,
                ease: 'power2.out'
            }, '-=1.5');

        // ============================================
        // PHASE 3: QUANTUM SCAN
        // ============================================
        this.tl.addLabel('scan', '+=0.2')
            .add(() => {
                this.scrambleText(statusText, this.statusMessages[1]);
            })
            .to(scanner, {
                opacity: 1,
                duration: 0.2
            })
            .to(scanner, {
                left: '120%',
                duration: 1.2,
                ease: 'power1.inOut'
            })
            .to(solid, {
                clipPath: 'circle(100% at 50% 50%)',
                duration: 1.2,
                ease: 'power1.inOut'
            }, '-=1.2')
            .to(scanner, {
                opacity: 0,
                duration: 0.2
            }, '-=0.2')
            .to(progressLine, {
                width: '70%',
                duration: 1,
                ease: 'power2.out'
            }, '-=1')
            .to(progressGlow, {
                width: '70%',
                duration: 1,
                ease: 'power2.out'
            }, '-=1');

        // ============================================
        // PHASE 4: DIMENSIONAL GLITCH
        // ============================================
        this.tl.addLabel('glitch', '+=0.1')
            .add(() => {
                this.scrambleText(statusText, this.statusMessages[2]);
            })
            // Glitch sequence
            .to(glitchRed, {
                opacity: 0.8,
                x: -8,
                y: 2,
                duration: 0.05
            })
            .to(glitchBlue, {
                opacity: 0.8,
                x: 8,
                y: -2,
                duration: 0.05
            }, '-=0.05')
            .to([glitchRed, glitchBlue], {
                opacity: 0,
                x: 0,
                y: 0,
                duration: 0.05
            })
            .to(glitchRed, {
                opacity: 0.6,
                x: 5,
                y: -3,
                duration: 0.05
            }, '+=0.1')
            .to(glitchBlue, {
                opacity: 0.6,
                x: -5,
                y: 3,
                duration: 0.05
            }, '-=0.05')
            .to([glitchRed, glitchBlue], {
                opacity: 0,
                x: 0,
                y: 0,
                duration: 0.05
            })
            // Camera shake
            .to(coreIntelligence, {
                x: 3,
                rotation: 0.5,
                duration: 0.05
            })
            .to(coreIntelligence, {
                x: -3,
                rotation: -0.5,
                duration: 0.05
            })
            .to(coreIntelligence, {
                x: 2,
                rotation: 0.3,
                duration: 0.05
            })
            .to(coreIntelligence, {
                x: 0,
                rotation: 0,
                duration: 0.1,
                ease: 'power2.out'
            })
            .to(progressLine, {
                width: '85%',
                duration: 0.5,
                ease: 'power2.out'
            }, '-=0.3')
            .to(progressGlow, {
                width: '85%',
                duration: 0.5,
                ease: 'power2.out'
            }, '-=0.5');

        // ============================================
        // PHASE 5: SYSTEM ONLINE
        // ============================================
        this.tl.addLabel('online', '+=0.2')
            .add(() => {
                this.scrambleText(statusText, this.statusMessages[3]);
            })
            .to(progressLine, {
                width: '100%',
                duration: 0.6,
                ease: 'power2.out'
            })
            .to(progressGlow, {
                width: '100%',
                duration: 0.6,
                ease: 'power2.out'
            }, '-=0.6')
            // Final pulse effect
            .to(solid, {
                scale: 1.05,
                duration: 0.15,
                ease: 'power2.out'
            })
            .to(solid, {
                scale: 1,
                duration: 0.3,
                ease: 'elastic.out(1, 0.5)'
            })
            .to(pulseRing, {
                scale: 2,
                opacity: 0,
                duration: 0.6,
                ease: 'power2.out'
            }, '-=0.3')
            .add(() => {
                this.scrambleText(statusText, this.statusMessages[4]);
                statusText.classList.add('online');
            })
            .to(glowRing, {
                opacity: 0.8,
                scale: 1.1,
                duration: 0.4,
                ease: 'power2.out'
            }, '-=0.2');

        // ============================================
        // PHASE 6: TRANSITION OUT - Fly Through
        // ============================================
        this.tl.addLabel('exit', '+=0.5')
            .to(loader, {
                scale: 3,
                opacity: 0,
                duration: 0.8,
                ease: 'power2.in'
            })
            .set(loader, {
                display: 'none'
            });
    }

    /**
     * Called when animation completes
     */
    onComplete() {
        const loader = document.getElementById('skeleton-loader');
        if (loader) {
            loader.classList.add('hidden');
        }

        // Dispatch custom event
        window.dispatchEvent(new CustomEvent('loaderComplete'));
    }

    /**
     * Skip the loading animation
     */
    skip() {
        if (this.tl) {
            this.tl.progress(1);
        }
    }

    /**
     * Restart the loading animation
     */
    restart() {
        const loader = document.getElementById('skeleton-loader');
        if (loader) {
            loader.classList.remove('hidden');
            loader.style.display = 'flex';
            loader.style.opacity = '1';
            loader.style.transform = 'scale(1)';
        }

        if (this.tl) {
            this.tl.restart();
        }
    }

    /**
     * Destroy the loader
     */
    destroy() {
        const loader = document.getElementById('skeleton-loader');
        if (loader) {
            loader.remove();
        }

        if (this.tl) {
            this.tl.kill();
        }
    }
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.loadingSystem = new LoadingSystem();
});

// Allow skip on click/tap (optional)
document.addEventListener('click', (e) => {
    if (e.target.closest('#skeleton-loader') && window.loadingSystem) {
        // Uncomment to allow skipping
        // window.loadingSystem.skip();
    }
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingSystem;
}
