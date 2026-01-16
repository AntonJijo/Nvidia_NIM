#!/usr/bin/env python3
"""
Flask server for NVIDIA/OpenRouter AI chatbot with secure log export
"""

import os
import tempfile
import json
import re
import html
from datetime import datetime
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
import requests
from conversation_memory import get_memory_manager, cleanup_old_sessions
from dotenv import load_dotenv
import base64
from file_utils import allowed_file, get_file_type, extract_text_from_file, is_unsupported_binary
from system_prompts import WEB_DECISION_SYSTEM_PROMPT, WEB_SCRAPING_RULES_SYSTEM_PROMPT, WEB_MODE_LIMIT_SYSTEM_PROMPT, REASONING_MODE_SYSTEM_PROMPT

load_dotenv()

app = Flask(__name__)

# Security: Max request size (10MB) to prevent DoS
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 10MB max upload

# Production Origins (no localhost)
PRODUCTION_ORIGINS = [
    "https://antonjijo.github.io",
    "https://nvidia-nim.pages.dev",
    "https://nvidia-nim-bot.onrender.com",
    "https://Nvidia.pythonanywhere.com"
]

# Add localhost only if running in development
IS_PRODUCTION = os.getenv('FLASK_ENV') == 'production' or os.getenv('RENDER') is not None
ALLOWED_ORIGINS = PRODUCTION_ORIGINS if IS_PRODUCTION else PRODUCTION_ORIGINS + [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
]

# Configure CORS
CORS(app, 
     origins=ALLOWED_ORIGINS,
     methods=["GET", "POST"],
     allow_headers=["Content-Type", "X-API-KEY"],
     supports_credentials=False
)

# Security: Add security headers to all responses
@app.after_request
def add_security_headers(response):
    """Add security headers to all responses."""
    # Prevent MIME type sniffing
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # Prevent clickjacking
    response.headers['X-Frame-Options'] = 'DENY'
    # XSS protection (legacy browsers)
    response.headers['X-XSS-Protection'] = '1; mode=block'
    # Referrer policy for privacy
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    # Permissions policy to restrict browser features
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
    return response

# API keys from environment
NVIDIA_API_KEY = os.getenv('NVIDIA_API_KEY')
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY')
EXPORT_KEY = os.getenv('EXPORT_KEY')
TAVILY_API_KEY = os.getenv('TAVILY_API_KEY')

# Initialize Tavily client
from tavily import TavilyClient
tavily_client = TavilyClient(TAVILY_API_KEY) if TAVILY_API_KEY else None

# ============================================
# MODEL REGISTRY (CORE ROUTING LOGIC)
# ============================================
MODEL_REGISTRY = {
    # ---------- NVIDIA NIM (Primary Models) ----------
    "meta/llama-4-maverick-17b-128e-instruct": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "deepseek-ai/deepseek-r1": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "deepseek-ai/deepseek-v3.1": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "deepseek-ai/deepseek-v3.2": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "qwen/qwen2.5-coder-32b-instruct": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "openai/gpt-oss-120b": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    "moonshotai/kimi-k2-thinking": {
        "provider": "nim",
        "capabilities": ["text"]
    },
    
    # ---------- OpenRouter (FREE MODELS) ----------
    "qwen/qwen3-235b-a22b:free": {
        "provider": "openrouter",
        "capabilities": ["text"]
    },
    "google/gemma-3-27b-it:free": {
        "provider": "openrouter",
        "capabilities": ["text"]
    },
    
    # ---------- Internal Vision Model (for Stage-1 image analysis) ----------
    "nvidia/nemotron-nano-12b-v2-vl:free": {
        "provider": "openrouter",
        "capabilities": ["vision", "text"]
    },
}

if not NVIDIA_API_KEY:
    print("WARNING: NVIDIA_API_KEY not set!")
if not OPENROUTER_API_KEY:
    print("WARNING: OPENROUTER_API_KEY not set!")
if not EXPORT_KEY:
    print("WARNING: EXPORT_KEY not set!")

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
    
    # HTML escape is the primary defense against XSS.
    # We do NOT use complex regex for cleaning as they are prone to ReDoS.
    return html.escape(text, quote=True).strip()

def validate_message_content(message):
    """Validate message content for security and length"""
    if not message or not isinstance(message, str):
        return False, "Invalid message format"
    
    # Check length limits
    if len(message) > 10000:  # 10KB limit
        return False, "Message too long (max 10,000 characters)"
    
    if len(message.strip()) == 0:
        return False, "Message cannot be empty"
    
    # Check for XSS patterns
    xss_patterns = [
        r'<script[^>]*>',
        r'javascript:',
        r'vbscript:',
        r'data:text/html',
        r'<iframe[^>]*>',
        r'<object[^>]*>',
        r'<embed[^>]*>',
        r'<link[^>]*>',
        r'<meta[^>]*>',
        r'<style[^>]*>'
    ]
    
    for pattern in xss_patterns:
        if re.search(pattern, message, re.IGNORECASE):
            return False, "Message contains potentially dangerous content"
    
    # Prompt injection detection (log but don't block to avoid false positives)
    # These are monitored but allowed since users may legitimately discuss AI
    prompt_injection_patterns = [
        r'ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)',
        r'disregard\s+(all\s+)?(previous|prior|above)',
        r'forget\s+(everything|all|your)\s+(instructions?|rules?|training)',
        r'you\s+are\s+now\s+(a|an|in)\s+\w+\s+mode',
        r'new\s+instruction[s]?:',
        r'system\s*:\s*',
        r'\[system\]',
        r'<\|system\|>',
        r'###\s*(system|instruction)',
    ]
    
    message_lower = message.lower()
    for pattern in prompt_injection_patterns:
        if re.search(pattern, message_lower, re.IGNORECASE):
            # Log potential injection attempt (but don't block - could be false positive)
            # In production, you might want to log this to a security monitoring system
            pass
    
    return True, "Valid"

# Simple rate limiting using in-memory storage
from collections import defaultdict, deque
import time

rate_limit_storage = defaultdict(deque)

def check_rate_limit(ip_address, max_requests=10, window_seconds=60):
    """Simple rate limiting based on IP address"""
    now = time.time()
    requests = rate_limit_storage[ip_address]
    
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
    
    # Use global ALLOWED_ORIGINS (defined based on environment)
    # Check origin header
    if origin and origin not in ALLOWED_ORIGINS:
        return False
    
    # Check referer header as fallback
    if not origin and referer:
        for allowed in ALLOWED_ORIGINS:
            if referer.startswith(allowed):
                return True
        return False
    
    # Allow requests without origin/referer (e.g., direct API calls in dev)
    # In production, this should be more restrictive
    return True

def log_session_details(session_id, user_message, selected_model, conversation_messages, api_response=None, error=None):
    """
    Append session info to chat_logs.jsonl
    NOTE: In production, consider disabling logging or using anonymized data
    """
    # Option to disable logging in production (set DISABLE_CHAT_LOGGING=true)
    if os.getenv('DISABLE_CHAT_LOGGING', 'false').lower() == 'true':
        return
    
    # Truncate user message for privacy (only log first 100 chars)
    user_preview = user_message[:100] + "..." if len(user_message) > 100 else user_message
    
    log_entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "session_id": session_id[:20] + "..." if len(session_id) > 20 else session_id,  # Truncate session ID
        "model": selected_model,
        "user_prompt_preview": user_preview,  # Only preview, not full prompt
        "user_prompt_length": len(user_message),  # Log length instead of full content
        "conversation_turns": len(conversation_messages),  # Just count, not content
    }

    if api_response:
        log_entry["status"] = "success"
        log_entry["response_length"] = len(api_response.get('choices', [{}])[0].get('message', {}).get('content', ''))
    elif error:
        # Don't log full error details in case they contain sensitive info
        log_entry["status"] = "error"
        log_entry["error_type"] = type(error).__name__ if hasattr(error, '__class__') else "Unknown"

    try:
        with open("chat_logs.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception as e:
        print(f"ERROR: Failed to write log: {e}")

import hashlib
from PIL import Image
import io

# Simple in-memory cache for analysis results
# Format: { "md5_hash": "analysis_text" }
ANALYSIS_CACHE = {}

def compress_image(file_storage, max_size=1024):
    """
    Resize image to ensure max dimension is max_size.
    Returns bytes of the compressed image (JPEG).
    """
    try:
        image = Image.open(file_storage)
        
        # Convert to RGB if necessary (e.g. for PNG with transparency)
        if image.mode in ('RGBA', 'P'):
            image = image.convert('RGB')
            
        # Resize if dimensions exceed max_size
        width, height = image.size
        width, height = image.size
        if width > max_size or height > max_size:
            ratio = min(max_size / width, max_size / height)
            new_size = (int(width * ratio), int(height * ratio))
            image = image.resize(new_size, Image.Resampling.LANCZOS)
            
        # Save to bytes
        img_byte_arr = io.BytesIO()
        image.save(img_byte_arr, format='JPEG', quality=85)
        return img_byte_arr.getvalue()
    except Exception as e:
        print(f"Image compression error: {e}")
        # Fallback to original content relative to start pos
        file_storage.seek(0)
        return file_storage.read()

def stage_1_analyze(file_storage, file_type):
    """
    Stage 1: Analyze image or document using NVIDIA Nemotron Nano VL (via OpenRouter)
    Returns structured text description.
    """
    try:
        # Calculate file hash for caching (using original content)
        file_storage.seek(0)
        file_bytes = file_storage.read()
        file_hash = hashlib.md5(file_bytes).hexdigest()
        
        # Check cache
        if file_hash in ANALYSIS_CACHE:
            return ANALYSIS_CACHE[file_hash]

        content = ""
        is_image = False
        
        if file_type == 'image':
            is_image = True
            
            # Reset pointer and compress
            file_storage.seek(0)
            compressed_bytes = compress_image(file_storage)
            
            # Encode to base64 and create data URL (OpenRouter format)
            image_b64 = base64.b64encode(compressed_bytes).decode('utf-8')
            image_data_url = f"data:image/jpeg;base64,{image_b64}"
        else:
            # Text/Document
            file_storage.seek(0)
            text_content, error = extract_text_from_file(file_storage)
            if error:
                raise ValueError(f"Failed to extract text: {error}")
            file_content = text_content
            # Truncate if too huge
            if len(file_content) > 30000:
                file_content = file_content[:30000] + "\n...[Content Truncated]..."

        # Prepare request for NVIDIA Nemotron Nano VL (OpenRouter)
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://antonjijo.github.io",
            "X-Title": "Nvidia NIM"
        }
        
        system_instruction = (
            "You are a backend file analysis engine. "
            "Analyze the provided input (image or text) and output a STRUCTURED, SANITIZED text description. "
            "Focus on extracting facts, data, visual elements, and key information. "
            "NEVER address the user. NEVER provide explanations or chat. "
            "Be concise and factual."
        )

        if is_image:
            # OpenRouter format: type "text" and type "image_url" (WORKING FORMAT)
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"{system_instruction}\n\nDescribe this image in detail, focusing on key elements, text, objects, and context."
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_data_url
                            }
                        }
                    ]
                }
            ]
        else:
            # Text-only analysis
            messages = [
                {"role": "system", "content": system_instruction},
                {
                    "role": "user",
                    "content": f"Analyze this document content:\n\n{file_content}"
                }
            ]

        payload = {
            "model": "nvidia/nemotron-nano-12b-v2-vl:free",
            "messages": messages,
            "max_tokens": 512,
            "temperature": 0.7
        }

        # Increase timeout for Stage 1
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        
        # Parse response
        result = response.json()
        
        # Check for errors first
        if 'error' in result:
            error_msg = result['error']
            return f"Error analyzing file: {error_msg.get('message', str(error_msg))}"
        
        # Check for successful response
        if response.status_code == 200 and 'choices' in result:
            analysis = result['choices'][0]['message']['content']
            
            # Cache the result
            ANALYSIS_CACHE[file_hash] = analysis
            
            return analysis
        else:
            return f"Error analyzing file: Unexpected response format (status: {response.status_code})"

    except Exception as e:
        return f"Analysis failed: {str(e)}"

# ---------------------
# ============================================
# WEB SEARCH PROMPTS (IMPORTED)
# ============================================

def classify_query(query):
    """
    Ask LLM if web search is needed.
    """
    try:
        headers = {
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json"
        }
        # Use default NIM model for classification (fast, reliable)
        payload = {
            "model": "meta/llama-4-maverick-17b-128e-instruct", 
            "messages": [
                {"role": "system", "content": WEB_DECISION_SYSTEM_PROMPT},
                {"role": "user", "content": query}
            ],
            "max_tokens": 10,
            "temperature": 0.0
        }
        
        response = requests.post(
            "https://integrate.api.nvidia.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=10
        )
        
        if response.status_code == 200:
            res_text = response.json()['choices'][0]['message']['content'].strip()
            return "WEB_REQUIRED" in res_text
    except Exception:
        pass
    
    return False

def perform_tavily_search(query):
    """
    Perform web search using Tavily API for reliable, up-to-date information.
    Returns structured search results with answer and raw content.
    """
    if not tavily_client:
        return None
    
    try:
        response = tavily_client.search(
            query=query,
            include_answer="basic",
            search_depth="basic",
            include_raw_content="markdown"
        )
        
        if not response:
            return None
        
        # Build structured result from Tavily response
        result_parts = []
        
        # Include the AI-generated answer if available
        if response.get("answer"):
            result_parts.append(f"**Summary:** {response['answer']}")
        
        # Include relevant search results
        results = response.get("results", [])
        if results:
            result_parts.append("\n**Sources:**")
            for i, item in enumerate(results[:3], 1):  # Limit to top 3 sources
                title = item.get("title", "Untitled")
                url = item.get("url", "")
                content = item.get("content", "")
                raw_content = item.get("raw_content", "")
                
                # Use raw_content if available, otherwise fallback to content
                source_text = raw_content[:1500] if raw_content else content[:1000]
                
                result_parts.append(f"\n{i}. **{title}**")
                if url:
                    result_parts.append(f"   URL: {url}")
                if source_text:
                    result_parts.append(f"   {source_text}")
        
        if result_parts:
            return "\n".join(result_parts)
        
    except Exception as e:
        print(f"Tavily search error: {e}")
    
    return None

def perform_web_search(query):
    """
    Perform web search using Tavily API.
    Returns search results or None if unavailable.
    """
    return perform_tavily_search(query)

# ---------------------
# Chat endpoint
# ---------------------

@app.route('/api/chat', methods=['POST'])
def chat():
    session_id = 'default'
    user_message = ''
    selected_model = 'meta/llama-4-maverick-17b-128e-instruct'
    conversation_messages = []
    
    file_analysis_context = ""
    web_search_context = ""

    try:
        # Origin validation
        if not validate_request_origin():
            return jsonify({'error': 'Request origin not allowed'}), 403

        # Rate limiting check
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
        if not check_rate_limit(client_ip):
            return jsonify({'error': 'Rate limit exceeded. Please try again later.'}), 429

        if not NVIDIA_API_KEY and not OPENROUTER_API_KEY:
            return jsonify({'error': 'API keys not configured'}), 500

        # Handle Multipart vs JSON
        if request.content_type.startswith('multipart/form-data'):
            user_message = request.form.get('message', '')
            session_id = request.form.get('session_id', 'default')
            selected_model = request.form.get('model', selected_model)
            mode = request.form.get('mode', 'default')
            reasoning_mode = request.form.get('reasoning_mode', 'false').lower() == 'true'  # New: explicit reasoning mode toggle
            
            # File Handling (Stage 1)
            if 'file' in request.files:
                file = request.files['file']
                if file and file.filename:
                    if is_unsupported_binary(file.filename):
                        return jsonify({
                            'error': "File type not supported.\nSupported files: Images (.png, .jpg, .webp) and Plain Text (.txt, .md, .json, .csv)."
                        }), 400
                    
                    if allowed_file(file.filename):
                        file_type = get_file_type(file.filename)
                        # Invoke Stage 1
                        file_analysis_context = stage_1_analyze(file, file_type)
                        if file_analysis_context.startswith("Error") or file_analysis_context.startswith("Analysis failed"):
                             # Security: Do not expose raw error details to client
                             return jsonify({'error': "File processing failed. Please try a different file."}), 500
                    else:
                         return jsonify({
                            'error': "File type not supported.\nSupported files: Images (.png, .jpg, .webp) and Plain Text (.txt, .md, .json, .csv)."
                        }), 400
        else:
            data = request.get_json() or {}
            user_message = data.get('message', '')
            session_id = data.get('session_id', 'default')
            selected_model = data.get('model', selected_model)
            mode = data.get('mode', 'default')
            reasoning_mode = data.get('reasoning_mode', False)  # New: explicit reasoning mode toggle


        # Validate session ID
        if not validate_session_id(session_id):
            return jsonify({'error': 'Invalid session ID format'}), 400

        # Validate and sanitize user message (allow empty if file analysis exists)
        if not file_analysis_context:
            is_valid, error_msg = validate_message_content(user_message)
            if not is_valid:
                return jsonify({'error': error_msg}), 400
        
        # Sanitize the message
        user_message = sanitize_input(user_message)

        # Validate model using MODEL_REGISTRY
        model_info = MODEL_REGISTRY.get(selected_model)
        if not model_info:
            return jsonify({
                'error': 'Unsupported model',
                'allowed': sorted(MODEL_REGISTRY.keys())
            }), 400

        # WEB SEARCH LOGIC (Auto-Classify)
        if user_message and len(user_message) > 5 and mode != 'study':
             if classify_query(user_message):
                 search_results = perform_web_search(user_message)
                 
                 if search_results:
                     # Success: Inject Rules + Results
                     # The Prompt already handles instructions, so we just append it.
                     web_search_context = f"{WEB_SCRAPING_RULES_SYSTEM_PROMPT}\n\n<WEB_SEARCH_RESULTS>\n{search_results}\n</WEB_SEARCH_RESULTS>\n"
                 else:
                     # Failure: Inject Limit Prompt
                     # This forces the AI to admit failure gracefully.
                     web_search_context = f"{WEB_MODE_LIMIT_SYSTEM_PROMPT}\n"

        memory_manager = get_memory_manager(session_id)
        
        # Determine which mode to use (Reasoning > Study > Default)
        # Apply combined mode logic - only update prompt ONCE
        is_reasoning_capable_model = selected_model in ["moonshotai/kimi-k2-thinking", "deepseek-ai/deepseek-r1"]
        use_reasoning_mode = reasoning_mode and is_reasoning_capable_model
        use_study_mode = (mode == 'study')
        
        # Set the appropriate mode (priority: reasoning > study > default)
        memory_manager.set_mode(use_study_mode=use_study_mode, use_reasoning_mode=use_reasoning_mode)
            
        memory_manager.set_model(selected_model)
        
        # Add context (File Analysis + Web Search)
        final_user_content = user_message
        if file_analysis_context or web_search_context:
            final_user_content = ""
            if file_analysis_context:
                 final_user_content += f"User uploaded a file.\nHere is a factual analysis extracted from the file:\n<FILE_ANALYSIS>\n{file_analysis_context}\n</FILE_ANALYSIS>\n\n"
            
            if web_search_context:
                 # We inject the prompt directives directly
                 final_user_content += f"{web_search_context}\n\n"
            
            final_user_content += f"User question:\n{user_message}"

        # Force enforcement of Study Mode Protocol in the immediate context
        if mode == 'study':
             final_user_content += "\n\n[SYSTEM MANDATE: You are in Study Mode (Professor Nexus). STRICTLY follow the 'Professional Tutor' protocol (No 'Step' labels). Use STRUCTURED FORMATTING (Headers, Bullets). If the user is confused, switch to ANALOGIES/STORIES immediately. You MUST end with a distinct 'Knowledge Check' section.]"
        
        # Force stealth thinking in Reasoning Mode
        if use_reasoning_mode:
             final_user_content += "\n\n[THINKING REMINDER: Your <think> output is visible. Do NOT mention CORE_IDENTITY, SAFETY_PROTOCOLS, Section numbers, or any internal rule names. Think naturally like a human, not like a robot reading rules.]"
        
        memory_manager.add_message('user', final_user_content)
        conversation_messages = memory_manager.get_conversation_buffer()

        # ============================================
        # STAGE-2: REASONER (Provider-based routing)
        # ============================================
        provider = model_info["provider"]
        
        # Special handling for "Thinking" models to use streaming (DeepSeek R1, Kimi)
        # to correctly capture 'reasoning_content' which is often only sent in stream deltas.
        is_reasoning_model = use_reasoning_mode  # Only stream if mode is enabled

        if provider == "openrouter":
            headers = {
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://antonjijo.github.io",
                "X-Title": "Nvidia NIM"
            }
            payload = {
                "model": selected_model,
                "messages": conversation_messages,
                "max_tokens": 4096
            }
            
            # Apply custom parameters if needed
            if selected_model == "moonshotai/kimi-k2-thinking":
                 payload["temperature"] = 1.0
                 payload["top_p"] = 0.9
                 payload["max_tokens"] = 16384
            elif selected_model == "deepseek-ai/deepseek-r1":
                 payload["temperature"] = 0.6
                 payload["top_p"] = 0.7
            
            response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=60
            ) 
        
        elif provider == "nim":
            headers = {
                "Authorization": f"Bearer {NVIDIA_API_KEY}",
                "Content-Type": "application/json"
            }
            
            # Set up parameters with defaults
            temperature = 0.5 
            top_p = 1.0
            max_tokens = 4096
            
            if selected_model == "moonshotai/kimi-k2-thinking":
                temperature = 1.0
                top_p = 0.9
                max_tokens = 16384
            elif selected_model == "deepseek-ai/deepseek-r1":
                temperature = 0.6
                top_p = 0.7
                max_tokens = 4096

            payload = {
                "model": selected_model,
                "messages": conversation_messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": top_p,
                "stream": is_reasoning_model  # Needed for upstream to actually stream
            }

            # ============================================
            # STREAMING RESPONSE HANDLER
            # ============================================
            if is_reasoning_model:
                def generate_response():
                    try:
                        # Call Upstream API with Streaming
                        upstream_response = requests.post(
                            "https://integrate.api.nvidia.com/v1/chat/completions",
                            headers=headers,
                            json=payload,
                            stream=True,
                            timeout=120
                        )

                        if upstream_response.status_code != 200:
                             yield json.dumps({"error": f"Upstream Error: {upstream_response.status_code}"}) + "\n"
                             return

                        # Track state
                        collected_content = []
                        collected_reasoning = []
                        has_started_thinking = False
                        has_ended_thinking = False
                        start_time = time.time()
                        
                        # Iterate headers? No, just lines.
                        for line in upstream_response.iter_lines():
                            if line:
                                decoded_line = line.decode('utf-8')
                                if decoded_line.startswith('data: '):
                                    data_str = decoded_line[6:]
                                    if data_str.strip() == '[DONE]':
                                        break
                                    try:
                                        chunk = json.loads(data_str)
                                        if 'choices' in chunk and len(chunk['choices']) > 0:
                                            delta = chunk['choices'][0].get('delta', {})
                                            
                                            # Handling Reasoning
                                            reasoning_chunk = delta.get('reasoning_content')
                                            if reasoning_chunk:
                                                if not has_started_thinking:
                                                    # Send OPEN tag with start timestamp for frontend calculation
                                                    yield f"<think start=\"{int(start_time*1000)}\">"
                                                    collected_reasoning.append("<think>")
                                                    has_started_thinking = True
                                                
                                                yield reasoning_chunk
                                                collected_reasoning.append(reasoning_chunk)

                                            # Handling Content
                                            content_chunk = delta.get('content')
                                            if content_chunk:
                                                # If we were thinking and now have content, close the tag
                                                if has_started_thinking and not has_ended_thinking:
                                                    yield "</think>" 
                                                    collected_reasoning.append("</think>")
                                                    has_ended_thinking = True
                                                
                                                yield content_chunk
                                                collected_content.append(content_chunk)
                                                
                                    except json.JSONDecodeError:
                                        continue

                        # Ensure think tag is closed if stream ends without content
                        if has_started_thinking and not has_ended_thinking:
                            yield "</think>"
                            collected_reasoning.append("</think>")

                        # Finalize Memory
                        full_reasoning_str = "".join(collected_reasoning)
                        full_content_str = "".join(collected_content)
                        # Store the raw logical message in memory (cleaning up tags for specific models if needed, but generic is storing what user sees)
                        # Actually, we should store the structured format?
                        # For now, store what was sent.
                        full_bot_message = full_reasoning_str + full_content_str
                        
                        memory_manager.add_message('assistant', full_bot_message)
                        log_session_details(session_id, user_message, selected_model, conversation_messages, api_response={"choices":[{"message":{"content": full_bot_message}}]})
                        
                    except Exception as e:
                        print(f"Stream Generate Error: {e}")
                        yield json.dumps({"error": str(e)})

                return Response(stream_with_context(generate_response()), mimetype='text/plain')

            else:
                # STANDARD NON-STREAMING (Legacy/Other models)
                response = requests.post(
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=60
                )
        
        else:
            return jsonify({"error": "Invalid model provider"}), 500

        # Handle Standard (Non-Streaming) Responses
        if response.status_code == 200:
            api_response = response.json()
            
            # Extract content
            bot_message = api_response['choices'][0]['message'].get('content') or ""
            
            # Check for reasoning content (standard API field)
            # ONLY include reasoning if reasoning_mode was explicitly enabled
            reasoning_content = None
            if use_reasoning_mode and 'reasoning_content' in api_response['choices'][0]['message']:
                 reasoning_content = api_response['choices'][0]['message']['reasoning_content']
            
            # If reasoning exists AND mode enabled, wrap it in <think> tags and prepend to message
            if reasoning_content:
                # Calculate fake duration or just omit
                bot_message = f"<think>\n{reasoning_content}\n</think>\n\n{bot_message}"
                
            if not bot_message:
                bot_message = "Empty response"

            # Don't sanitize bot response - it's from trusted AI API and we use DOMPurify client-side
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
        try:
            log_session_details(session_id, user_message, selected_model, conversation_messages, error=str(e))
        except:
            pass
        # Don't expose internal error details to the client
        return jsonify({'error': 'An unexpected error occurred. Please try again.'}), 500

# ---------------------
# Conversation Management Endpoints
# ---------------------
@app.route('/api/conversation/stats', methods=['GET'])
def conversation_stats():
    # Security: Validate origin
    if not validate_request_origin():
        return jsonify({'error': 'Request origin not allowed'}), 403
    
    session_id = request.args.get('session_id')
    if not session_id:
        return jsonify({'error': 'Session ID required'}), 400
    
    if not validate_session_id(session_id):
        return jsonify({'error': 'Invalid session ID'}), 400

    memory_manager = get_memory_manager(session_id)
    return jsonify(memory_manager.get_conversation_stats())

@app.route('/api/classify', methods=['POST'])
def classify_endpoint():
    """
    Expose classification logic to frontend for UI feedback.
    """
    # Security: Validate origin and apply rate limiting
    if not validate_request_origin():
        return jsonify({'error': 'Request origin not allowed'}), 403
    
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
    if not check_rate_limit(client_ip, max_requests=30, window_seconds=60):  # More lenient for classification
        return jsonify({'error': 'Rate limit exceeded'}), 429
    
    try:
        data = request.get_json()
        query = data.get('message', '')
        if not query:
            return jsonify({'web_required': False})
            
        is_required = classify_query(query)
        return jsonify({'web_required': is_required})
    except Exception:
        return jsonify({'web_required': False})

@app.route('/api/conversation/clear', methods=['POST'])
def clear_conversation():
    # Security: Validate origin and apply rate limiting
    if not validate_request_origin():
        return jsonify({'error': 'Request origin not allowed'}), 403
    
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
    if not check_rate_limit(client_ip, max_requests=5, window_seconds=60):  # Strict for destructive action
        return jsonify({'error': 'Rate limit exceeded'}), 429
    
    data = request.get_json()
    session_id = data.get('session_id')
    
    if not session_id:
        return jsonify({'error': 'Session ID required'}), 400
        
    if not validate_session_id(session_id):
        return jsonify({'error': 'Invalid session ID'}), 400

    memory_manager = get_memory_manager(session_id)
    memory_manager.clear_conversation()
    
    return jsonify({
        'status': 'cleared',
        'stats': memory_manager.get_conversation_stats()
    })

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
    port = int(os.getenv('PORT', 8000))
    print(f"Starting NVIDIA Chatbot Server on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=False)
