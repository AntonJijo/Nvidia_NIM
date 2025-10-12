#!/usr/bin/env python3
"""
Flask server for NVIDIA/OpenRouter AI chatbot with secure log export
"""

import os
import tempfile
import json
import re
import html
import hmac
import hashlib
import time
import base64
from datetime import datetime
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import requests
from conversation_memory import get_memory_manager, cleanup_old_sessions

app = Flask(__name__)

# Configure CORS with more restrictive settings
CORS(app, 
     origins=[
         "https://antonjijo.github.io",
         "http://localhost:8000",
         "http://127.0.0.1:8000",
         "http://localhost:3000",
         "https://Nvidia.pythonanywhere.com"
     ],
     methods=["GET", "POST"],
     allow_headers=["Content-Type", "X-API-KEY"],
     supports_credentials=False
)

# API keys from environment
NVIDIA_API_KEY = os.getenv('NVIDIA_API_KEY')
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY')
EXPORT_KEY = os.getenv('EXPORT_KEY')
FRONTEND_SHARED_SECRET = os.getenv('FRONTEND_SHARED_SECRET')

# Allowed AI models
ALLOWED_MODELS = {
    'meta/llama-4-maverick-17b-128e-instruct',
    'deepseek-ai/deepseek-r1',
    'qwen/qwen2.5-coder-32b-instruct',
    'qwen/qwen3-coder-480b-a35b-instruct',
    'deepseek-ai/deepseek-v3.1',
    'openai/gpt-oss-120b',
    'qwen/qwen3-235b-a22b:free',
    'google/gemma-3-27b-it:free',
    'x-ai/grok-4-fast:free',
}

# Security configuration
MAX_MESSAGE_LENGTH = 10000  # Maximum message length in characters
MAX_SESSION_ID_LENGTH = 100  # Maximum session ID length
TOKEN_EXPIRY_SECONDS = 86400  # 24 hours
TOKEN_REFRESH_BUFFER = 7200   # 2 hours before expiry for refresh

if not NVIDIA_API_KEY:
    print("WARNING: NVIDIA_API_KEY not set!")
if not OPENROUTER_API_KEY:
    print("WARNING: OPENROUTER_API_KEY not set!")
if not EXPORT_KEY:
    print("WARNING: EXPORT_KEY not set!")
if not FRONTEND_SHARED_SECRET:
    print("WARNING: FRONTEND_SHARED_SECRET not set!")

# ---------------------
# Security and validation functions
# ---------------------

def verify_api_key(req):
    key = req.headers.get('X-API-KEY') or req.args.get('key')
    return key == EXPORT_KEY

def validate_session_id(session_id):
    """Validate session ID format and content"""
    if not session_id or not isinstance(session_id, str):
        return False
    # Session ID should be alphanumeric with underscores and hyphens only
    if not re.match(r'^[a-zA-Z0-9_-]+$', session_id):
        return False
    # Length should be reasonable (not too short or too long)
    if len(session_id) < 5 or len(session_id) > 100:
        return False
    return True

def sanitize_input(text):
    """Sanitize user input to prevent XSS and injection attacks"""
    if not text or not isinstance(text, str):
        return ""
    
    # Remove null bytes and control characters
    text = re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', text)
    
    # HTML escape to prevent XSS
    text = html.escape(text, quote=True)
    
    # Remove potential script tags and dangerous patterns
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r'javascript:', '', text, flags=re.IGNORECASE)
    text = re.sub(r'vbscript:', '', text, flags=re.IGNORECASE)
    text = re.sub(r'on\w+\s*=', '', text, flags=re.IGNORECASE)
    
    return text.strip()

def validate_message_content(message):
    """Validate message content for security and length"""
    if not message or not isinstance(message, str):
        return False, "Invalid message format"
    
    # Check length limits
    if len(message) > MAX_MESSAGE_LENGTH:
        return False, f"Message too long (max {MAX_MESSAGE_LENGTH} characters)"
    
    if len(message.strip()) == 0:
        return False, "Message cannot be empty"
    
    # Check for suspicious patterns
    suspicious_patterns = [
        r'<script[^>]*>',
        r'javascript:',
        r'vbscript:',
        r'data:text/html',
        r'<iframe[^>]*>',
        r'<object[^>]*>',
        r'<embed[^>]*>',
        r'<link[^>]*>',
        r'<meta[^>]*>',
        r'<style[^>]*>',
        r'eval\s*\(',
        r'exec\s*\(',
        r'import\s+os',
        r'import\s+sys',
        r'__import__',
        r'globals\s*\(',
        r'locals\s*\(',
        r'chr\s*\(',
        r'ord\s*\('
    ]
    
    for pattern in suspicious_patterns:
        if re.search(pattern, message, re.IGNORECASE):
            return False, "Message contains potentially dangerous content"
    
    return True, "Valid"

# Enhanced rate limiting using in-memory storage
from collections import defaultdict, deque
import time

# Separate rate limit storage for different endpoints
rate_limit_storage = defaultdict(deque)
token_rate_limit_storage = defaultdict(deque)

# Rate limiting configuration
RATE_LIMITS = {
    'default': {'max_requests': 10, 'window_seconds': 60},
    'token': {'max_requests': 5, 'window_seconds': 60},
    'chat': {'max_requests': 30, 'window_seconds': 60}
}

def check_rate_limit(ip_address, limit_type='default'):
    """Enhanced rate limiting based on IP address and request type"""
    # Get rate limit configuration
    config = RATE_LIMITS.get(limit_type, RATE_LIMITS['default'])
    max_requests = config['max_requests']
    window_seconds = config['window_seconds']
    
    # Select appropriate storage based on limit type
    if limit_type == 'token':
        requests = token_rate_limit_storage[ip_address]
    else:
        requests = rate_limit_storage[ip_address]
    
    now = time.time()
    
    # Remove old requests outside the window
    while requests and requests[0] <= now - window_seconds:
        requests.popleft()
    
    # Check if limit exceeded
    if len(requests) >= max_requests:
        return False
    
    # Add current request
    requests.append(now)
    return True

def validate_request_origin():
    """Validate that the request comes from an allowed origin"""
    origin = request.headers.get('Origin')
    referer = request.headers.get('Referer')
    
    allowed_origins = [
        "https://antonjijo.github.io",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:3000",
        "https://Nvidia.pythonanywhere.com"
    ]
    
    # Check origin header
    if origin and origin not in allowed_origins:
        return False
    
    # Check referer header as fallback
    if not origin and referer:
        for allowed in allowed_origins:
            if referer.startswith(allowed):
                return True
        return False
    
    # Allow requests without origin/referer (e.g., direct API calls)
    return True

# ---------------------
# Token-based authentication functions
# ---------------------

def generate_access_token():
    """Generate a secure, short-lived access token using HMAC-SHA256"""
    if not FRONTEND_SHARED_SECRET:
        raise ValueError("FRONTEND_SHARED_SECRET not configured")
    
    # Get current timestamp
    timestamp = int(time.time())
    
    # Create payload with timestamp and expiration (24 hours from now for frontend)
    payload = {
        'timestamp': timestamp,
        'expires': timestamp + TOKEN_EXPIRY_SECONDS,  # Configurable expiration
        'nonce': os.urandom(16).hex(),  # Random nonce to prevent reuse
        'issuer': 'nvidia-chatbot'  # Add issuer for additional validation
    }
    
    # Create message to sign
    message = f"{payload['timestamp']}:{payload['expires']}:{payload['nonce']}:{payload['issuer']}"
    
    # Generate HMAC-SHA256 signature
    signature = hmac.new(
        FRONTEND_SHARED_SECRET.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    # Create token with signature
    token_data = f"{message}:{signature}"
    
    # Base64 encode the token for safe transmission
    token = base64.b64encode(token_data.encode('utf-8')).decode('utf-8')
    
    return token, payload['expires']

def verify_access_token(token):
    """Verify and validate the access token"""
    if not FRONTEND_SHARED_SECRET:
        return False, "Token verification not configured"
    
    try:
        # Decode base64 token
        token_data = base64.b64decode(token.encode('utf-8')).decode('utf-8')
        
        # Split token components
        parts = token_data.split(':')
        if len(parts) != 5:  # Now we have 5 parts: timestamp, expires, nonce, issuer, signature
            return False, "Invalid token format"
        
        timestamp, expires, nonce, issuer, signature = parts
        
        # Verify issuer
        if issuer != 'nvidia-chatbot':
            return False, "Invalid token issuer"
        
        # Verify signature
        message = f"{timestamp}:{expires}:{nonce}:{issuer}"
        expected_signature = hmac.new(
            FRONTEND_SHARED_SECRET.encode('utf-8'),
            message.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        # Use constant-time comparison to prevent timing attacks
        if not hmac.compare_digest(signature, expected_signature):
            return False, "Invalid token signature"
        
        # Check expiration
        current_time = int(time.time())
        if current_time > int(expires):
            return False, "Token expired"
        
        # Check if token is too old (additional security) - using configurable time
        if current_time - int(timestamp) > TOKEN_EXPIRY_SECONDS:
            return False, "Token too old"
        
        return True, "Token valid"
        
    except Exception as e:
        return False, f"Token verification failed: {str(e)}"

def validate_frontend_origin():
    """Validate that the request comes specifically from the frontend"""
    origin = request.headers.get('Origin')
    referer = request.headers.get('Referer')
    
    # Only allow the specific frontend domain
    allowed_frontend = "https://antonjijo.github.io"
    
    # Check origin header first
    if origin and origin == allowed_frontend:
        return True
    
    # Check referer header as fallback
    if referer and referer.startswith(allowed_frontend):
        return True
    
    return False

def log_session_details(session_id, user_message, selected_model, conversation_messages, api_response=None, error=None):
    """Append session info to chat_logs.jsonl"""
    log_entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "session_id": session_id,
        "model": selected_model,
        "user_prompt": user_message,
        "conversation_context": [
            {
                "role": msg["role"],
                "content_preview": msg["content"][:100] + "..." if len(msg["content"]) > 100 else msg["content"],
                "content_length": len(msg["content"]),
                "is_summary": msg.get("metadata", {}).get("is_summary", False) if "metadata" in msg else False
            }
            for msg in conversation_messages
        ]
    }

    if api_response:
        ai_content = api_response.get('choices', [{}])[0].get('message', {}).get('content', '')
        log_entry["ai_response"] = {"content": ai_content[:200] + "...", "status": "success"}
        log_entry["ai_response_text"] = ai_content
    elif error:
        log_entry["ai_response"] = {"error": str(error), "status": "error"}
        log_entry["ai_response_text"] = f"Error: {str(error)}"

    # Save to file
    try:
        with open("chat_logs.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception as e:
        print(f"ERROR: Failed to write log: {e}")

# ---------------------
# Token endpoint
# ---------------------

@app.route('/get_token', methods=['GET'])
def get_token():
    """Generate a secure access token for frontend authentication"""
    try:
        # Validate that request comes from the frontend
        if not validate_frontend_origin():
            return jsonify({'error': 'Request origin not allowed'}), 403
        
        # Rate limiting for token requests (more restrictive)
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
        if not check_rate_limit(client_ip, limit_type='token'):
            return jsonify({'error': 'Token request rate limit exceeded'}), 429
        
        # Generate secure token
        token, expires = generate_access_token()
        
        return jsonify({
            'token': token,
            'expires': expires,
            'expires_in': 86400  # 24 hours for frontend
        })
        
    except ValueError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': 'Token generation failed'}), 500

# ---------------------
# Chat endpoint
# ---------------------

@app.route('/api/chat', methods=['POST'])
def chat():
    session_id = 'default'
    user_message = ''
    selected_model = 'meta/llama-4-maverick-17b-128e-instruct'
    conversation_messages = []

    try:
        # Token-based authentication (required for all chat requests)
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Missing or invalid authorization header'}), 401
        
        token = auth_header[7:]  # Remove 'Bearer ' prefix
        
        # Verify the access token
        is_valid, error_msg = verify_access_token(token)
        if not is_valid:
            return jsonify({'error': f'Token verification failed: {error_msg}'}), 401
        
        # Origin validation (additional security layer)
        if not validate_request_origin():
            return jsonify({'error': 'Request origin not allowed'}), 403

        # Rate limiting check
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
        if not check_rate_limit(client_ip, limit_type='chat'):
            return jsonify({'error': 'Rate limit exceeded. Please try again later.'}), 429

        if not NVIDIA_API_KEY and not OPENROUTER_API_KEY:
            return jsonify({'error': 'API keys not configured'}), 500

        data = request.get_json() or {}
        user_message = data.get('message', '')
        session_id = data.get('session_id', 'default')
        selected_model = data.get('model', selected_model)

        # Validate session ID
        if not validate_session_id(session_id):
            return jsonify({'error': 'Invalid session ID format'}), 400

        # Validate and sanitize user message
        is_valid, error_msg = validate_message_content(user_message)
        if not is_valid:
            return jsonify({'error': error_msg}), 400
        
        # Sanitize the message
        user_message = sanitize_input(user_message)

        if selected_model not in ALLOWED_MODELS:
            return jsonify({'error': 'Unsupported model', 'allowed': sorted(list(ALLOWED_MODELS))}), 400

        memory_manager = get_memory_manager(session_id)
        memory_manager.set_model(selected_model)
        memory_manager.add_message('user', user_message)
        conversation_messages = memory_manager.get_conversation_buffer()

        # Select API
        if selected_model in ['qwen/qwen3-235b-a22b:free', 'google/gemma-3-27b-it:free', 'x-ai/grok-4-fast:free']:
            headers = {"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json"}
            payload = {"model": selected_model, "messages": conversation_messages, "max_tokens":1024}
            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)
        else:
            headers = {"Authorization": f"Bearer {NVIDIA_API_KEY}", "Content-Type": "application/json"}
            payload = {"model": selected_model, "messages": conversation_messages, "max_tokens":1024}
            response = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload)

        if response.status_code == 200:
            api_response = response.json()
            bot_message = api_response['choices'][0]['message']['content'] or "Empty response"
            # Sanitize bot response as well
            bot_message = sanitize_input(bot_message)
            memory_manager.add_message('assistant', bot_message)
            log_session_details(session_id, user_message, selected_model, conversation_messages, api_response=api_response)
            cleanup_old_sessions(max_sessions=500)
            return jsonify({'response': bot_message, 'model': selected_model, 'conversation_stats': memory_manager.get_conversation_stats()})
        else:
            # Don't expose internal API details in error messages
            if response.status_code == 401:
                error_msg = "Authentication failed with AI service"
            elif response.status_code == 429:
                error_msg = "AI service rate limit exceeded. Please try again later."
            elif response.status_code >= 500:
                error_msg = "AI service temporarily unavailable. Please try again later."
            else:
                error_msg = f"AI service error (code: {response.status_code})"
            
            log_session_details(session_id, user_message, selected_model, conversation_messages, error=error_msg)
            return jsonify({'error': error_msg}), 500

    except Exception as e:
        log_session_details(session_id, user_message, selected_model, conversation_messages, error=str(e))
        # Don't expose internal error details to frontend
        return jsonify({'error': 'An internal error occurred. Please try again later.'}), 500

# ---------------------
# Health endpoint
# ---------------------

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy'})

# ---------------------
# Export logs endpoint
# ---------------------

@app.route('/export_logs', methods=['GET'])
def export_logs():
    if not verify_api_key(request):
        return jsonify({'error': 'Unauthorized'}), 401
    if not os.path.exists("chat_logs.jsonl"):
        return jsonify({'error': 'No logs found'}), 404

    try:
        formatted_logs = []
        with open("chat_logs.jsonl", "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                log_entry = json.loads(line)
                session_id = log_entry.get("session_id", "unknown")
                user_prompt = log_entry.get("user_prompt", "")
                ai_response = log_entry.get("ai_response_text", "")
                formatted_logs.append(f"Session: {session_id}")
                if user_prompt: formatted_logs.append(f"User: {user_prompt}")
                if ai_response:
                    if isinstance(ai_response, dict):
                        ai_response = ai_response.get("error", str(ai_response))
                    formatted_logs.append(f"AI: {ai_response}")
                formatted_logs.append("")

        with tempfile.NamedTemporaryFile("w+", delete=False, suffix=".txt") as temp_file:
            temp_file.write("\n".join(formatted_logs))
            temp_name = temp_file.name

        response = send_file(
            temp_name,
            as_attachment=True,
            download_name=f"chat_report_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.txt",
            mimetype='text/plain'
        )

        os.remove(temp_name)
        return response

    except Exception as e:
        print(f"ERROR: Failed to export logs: {e}")
        return jsonify({'error': 'Failed to export logs'}), 500

# ---------------------
# Cleanup logs endpoint
# ---------------------

@app.route('/cleanup_logs', methods=['POST'])
def cleanup_logs():
    if not verify_api_key(request):
        return jsonify({'error': 'Unauthorized'}), 401
    try:
        open("chat_logs.jsonl", "w").close()
        return jsonify({"status": "cleared"})
    except Exception as e:
        print(f"ERROR: Failed to cleanup logs: {e}")
        return jsonify({'error': 'Failed to cleanup logs'}), 500

# ---------------------
# Run server
# ---------------------

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    print(f"Starting NVIDIA Chatbot Server on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=False)
