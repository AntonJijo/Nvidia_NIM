/**
 * Secure Token-Based Authentication for NVIDIA Chatbot
 * Frontend JavaScript for https://antonjijo.github.io/NVIDIA_NIM
 */

class SecureChatClient {
    constructor() {
        // Auto-detect backend URL based on deployment
        this.backendUrl = this.detectBackendUrl();
        this.accessToken = null;
        this.tokenExpires = null;
        this.tokenRefreshTimer = null;
    }

    /**
     * Auto-detect backend URL based on current environment
     * @returns {string} Backend base URL
     */
    detectBackendUrl() {
        // Check if we're running on PythonAnywhere
        if (window.location.hostname.includes("pythonanywhere")) {
            return "https://Nvidia.pythonanywhere.com";
        }
        // Default to Render deployment
        return "https://nvidia-nim-bot.onrender.com";
    }

    /**
     * Fetch a new access token from the backend
     * @returns {Promise<string>} Access token
     */
    async fetchAccessToken() {
        try {
            console.log(`🔐 Fetching access token from: ${this.backendUrl}/get_token`);
            
            const response = await fetch(`${this.backendUrl}/get_token`, {
                method: 'GET',
                headers: {
                    'Origin': window.location.origin,
                    'Referer': window.location.href
                }
            });

            if (!response.ok) {
                // Don't expose detailed error information
                throw new Error('Failed to obtain access token. Please try again later.');
            }

            const data = await response.json();
            
            if (data.error) {
                // Don't expose detailed error information
                throw new Error('Access token request failed. Please try again later.');
            }

            this.accessToken = data.token;
            this.tokenExpires = data.expires;
            
            console.log(`✅ Access token obtained`);
            
            // Set up automatic token refresh
            this.scheduleTokenRefresh(data.expires_in);
            
            return data.token;
            
        } catch (error) {
            console.error('❌ Failed to fetch access token');
            throw new Error('Unable to establish secure connection. Please check your network and try again.');
        }
    }

    /**
     * Schedule automatic token refresh before expiration
     * @param {number} expiresIn - Token expiration time in seconds
     */
    scheduleTokenRefresh(expiresIn) {
        // Clear existing timer
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
        }

        // Refresh token 1 hour before expiration (for 24-hour tokens)
        const refreshTime = (expiresIn - 3600) * 1000; // 1 hour before expiry
        
        this.tokenRefreshTimer = setTimeout(async () => {
            console.log('🔄 Refreshing access token...');
            try {
                await this.fetchAccessToken();
            } catch (error) {
                console.error('❌ Token refresh failed:', error);
                // Clear invalid token
                this.accessToken = null;
                this.tokenExpires = null;
            }
        }, refreshTime);
    }

    /**
     * Ensure we have a valid access token with aggressive refresh strategy
     * @returns {Promise<string>} Valid access token
     */
    async ensureValidToken() {
        const now = Math.floor(Date.now() / 1000);
        
        // Check if we have a valid token with buffer time (refresh 2 hours before expiry)
        if (this.accessToken && this.tokenExpires && now < (this.tokenExpires - 7200)) {
            return this.accessToken;
        }

        // If token is expiring soon or missing, fetch new token immediately
        console.log('🔄 Token needs refresh, fetching new token...');
        return await this.fetchAccessToken();
    }

    /**
     * Send a chat message to the backend with secure authentication
     * @param {string} message - User message
     * @param {string} sessionId - Session ID
     * @param {string} model - Selected AI model
     * @returns {Promise<Object>} Chat response
     */
    async sendChatMessage(message, sessionId = 'default', model = 'meta/llama-4-maverick-17b-128e-instruct') {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                // Ensure we have a valid token
                const token = await this.ensureValidToken();
                
                console.log(`💬 Sending chat message to: ${this.backendUrl}/api/chat (attempt ${retryCount + 1})`);
                
                const response = await fetch(`${this.backendUrl}/api/chat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                        'Origin': window.location.origin,
                        'Referer': window.location.href
                    },
                    body: JSON.stringify({
                        message: message,
                        session_id: sessionId,
                        model: model
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    
                    // If token expired, try to get a new one
                    if (response.status === 401 && errorData.error && errorData.error.includes('Token')) {
                        console.log('🔄 Token expired, refreshing...');
                        this.accessToken = null;
                        this.tokenExpires = null;
                        retryCount++;
                        continue;
                    }
                    
                    // Don't expose detailed error information
                    throw new Error('Chat request failed. Please try again later.');
                }

                const data = await response.json();
                
                if (data.error) {
                    throw new Error(`Chat error: ${data.error}`);
                }

                console.log('✅ Chat response received successfully');
                return data;
                
            } catch (error) {
                console.error(`❌ Chat request failed (attempt ${retryCount + 1}):`, error);
                
                // If it's a token-related error, try to refresh
                if (error.message.includes('Token') || error.message.includes('401')) {
                    this.accessToken = null;
                    this.tokenExpires = null;
                    retryCount++;
                    
                    if (retryCount < maxRetries) {
                        console.log('🔄 Retrying with fresh token...');
                        continue;
                    }
                }
                
                throw error;
            }
        }
        
        throw new Error('Max retries exceeded for chat request');
    }

    /**
     * Test the secure connection
     * @returns {Promise<Object>} Test result
     */
    async testConnection() {
        try {
            console.log('🧪 Testing secure connection...');
            
            // Test token endpoint
            const token = await this.fetchAccessToken();
            console.log('✅ Token endpoint working');
            
            // Test chat endpoint with a simple message
            const response = await this.sendChatMessage('Hello, this is a test message.');
            console.log('✅ Chat endpoint working');
            
            return {
                success: true,
                backendUrl: this.backendUrl,
                tokenLength: token.length,
                response: response
            };
            
        } catch (error) {
            console.error('❌ Connection test failed:', error);
            return {
                success: false,
                error: error.message,
                backendUrl: this.backendUrl
            };
        }
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        this.accessToken = null;
        this.tokenExpires = null;
    }
}

// Global instance for easy access
window.secureChatClient = new SecureChatClient();

// Example usage function
async function testSecureChat() {
    try {
        console.log('🚀 Starting secure chat test...');
        
        // Test the connection
        const testResult = await window.secureChatClient.testConnection();
        
        if (testResult.success) {
            console.log('🎉 Secure chat system is working!');
            console.log('Backend URL:', testResult.backendUrl);
            console.log('Response:', testResult.response);
        } else {
            console.error('💥 Secure chat system failed:', testResult.error);
        }
        
        return testResult;
        
    } catch (error) {
        console.error('💥 Test failed:', error);
        return { success: false, error: error.message };
    }
}

// Auto-run test when script loads (for demonstration)
document.addEventListener('DOMContentLoaded', () => {
    console.log('🔐 Secure Chat Client loaded');
    console.log('Backend URL:', window.secureChatClient.backendUrl);
    
    // Uncomment the line below to auto-test on page load
    // testSecureChat();
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SecureChatClient, testSecureChat };
}
