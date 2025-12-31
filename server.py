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
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import requests
from conversation_memory import get_memory_manager, cleanup_old_sessions
from dotenv import load_dotenv
import base64
from file_utils import allowed_file, get_file_type, extract_text_from_file, is_unsupported_binary
load_dotenv()

app = Flask(__name__)

# Configure CORS with more restrictive settings
# Configure CORS for Production
CORS(app, 
     origins=[
         "https://antonjijo.github.io",
         "https://nvidia-nim.pages.dev",
         "https://nvidia-nim-bot.onrender.com",
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

# ============================================
# MODEL REGISTRY (CORE ROUTING LOGIC)
# ============================================
MODEL_REGISTRY = {
    # ---------- NVIDIA NIM (DEEPSEEK + NVIDIA MODELS) ----------
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": {
        "provider": "nim",
        "capabilities": ["vision", "text"]
    },
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
    
    # ---------- OpenRouter (FREE MODELS ONLY) ----------
    "qwen/qwen3-235b-a22b:free": {
        "provider": "openrouter",
        "capabilities": ["text"]
    },
    "google/gemma-3-27b-it:free": {
        "provider": "openrouter",
        "capabilities": ["text"]
    },
    "qwen/qwen-2.5-vl-7b-instruct:free": {
        "provider": "openrouter",
        "capabilities": ["vision", "text"]
    },
    # Stage-1 Vision Model (for internal use only)
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
    if len(message) > 10000:  # 10KB limit
        return False, "Message too long (max 10,000 characters)"
    
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
        r'<style[^>]*>'
    ]
    
    for pattern in suspicious_patterns:
        if re.search(pattern, message, re.IGNORECASE):
            return False, "Message contains potentially dangerous content"
    
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
    
    allowed_origins = [
        "https://antonjijo.github.io",
        "https://nvidia-nim.pages.dev",
        "https://nvidia-nim-bot.onrender.com",
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
    # Production: Always write to log


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
            print(f"Stage 1: Cache hit for {file_hash}")
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

        print("Stage 1: Calling NVIDIA Nemotron Nano VL (OpenRouter)...")
        # Increase timeout for Stage 1
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        
        print(f"Stage 1: Response status: {response.status_code}")
        
        # Parse response
        result = response.json()
        
        # Check for errors first
        if 'error' in result:
            error_msg = result['error']
            print(f"Stage 1 API Error: {json.dumps(error_msg, indent=2)}")
            return f"Error analyzing file: {error_msg.get('message', str(error_msg))}"
        
        # Check for successful response
        if response.status_code == 200 and 'choices' in result:
            analysis = result['choices'][0]['message']['content']
            
            # Cache the result
            ANALYSIS_CACHE[file_hash] = analysis
            
            return analysis
        else:
            print(f"Stage 1 Unexpected Response: {json.dumps(result, indent=2)}")
            return f"Error analyzing file: Unexpected response format (status: {response.status_code})"

    except Exception as e:
        print(f"Stage 1 Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return f"Analysis failed: {str(e)}"

# ---------------------
# ============================================
# WEB SEARCH PROMPTS (STRICT MODE)
# ============================================

WEB_DECISION_SYSTEM_PROMPT = """
You are a strict intent classifier.

Your task is to decide whether answering the user query REQUIRES
external, up-to-date, or real-time web information.

You DO NOT browse the web.
You DO NOT answer the question.
You ONLY decide.

Return EXACTLY one of these tokens:
- WEB_REQUIRED
- WEB_NOT_REQUIRED

----------------
Return WEB_REQUIRED ONLY IF the query depends on:
- Real-time or current data (today, now, latest, current)
- Prices, stock values, market capitalization
- News, announcements, releases, updates
- Events occurring after 2024
- Time-sensitive comparisons

----------------
Return WEB_NOT_REQUIRED if the query can be answered using:
- General knowledge
- Historical facts
- Conceptual explanations
- Definitions
- Tutorials
- Company or product overviews
- Non-time-sensitive comparisons

----------------
If you are uncertain, default to:
WEB_NOT_REQUIRED

----------------
Output rules:
- Output ONLY the token
- No explanations
- No punctuation
- No extra text
"""

WEB_SCRAPING_RULES_SYSTEM_PROMPT = """
You are operating in WEB MODE.

External information has been retrieved by the system and provided
inside <WEB_SEARCH_RESULTS> tags.

----------------
STRICT RULES (MANDATORY):

1. You MUST use ONLY the information contained inside
   <WEB_SEARCH_RESULTS> to answer.

2. You MUST NOT use prior knowledge, memory, or assumptions.

3. You MUST NOT invent facts, dates, numbers, events, or rankings.

4. If the answer is NOT clearly present in the retrieved data,
   you MUST say:
   "Not found in retrieved sources."

5. You MUST NOT speculate or extrapolate beyond the sources.

6. You MUST NOT mention training data, knowledge cutoff,
   or claim to browse the internet.

----------------
Allowed actions:
- Summarize retrieved facts
- Combine retrieved facts
- Rephrase retrieved facts

----------------
Forbidden actions:
- Guessing
- Filling gaps
- Predicting future events
- Stating confidence without evidence

----------------
Your credibility depends entirely on source fidelity.
"""

WEB_MODE_LIMIT_SYSTEM_PROMPT = """
Web mode was requested, but no reliable external information
is available due to system limits or missing sources.

----------------
Rules:

1. You MUST NOT invent or approximate information.
2. You MUST NOT answer from memory.
3. You MUST clearly state that web data is unavailable.
4. You MAY provide general background only if explicitly asked.
5. Otherwise, respond with a limitation notice.

----------------
Required phrasing (use exactly):

"Web mode is currently unavailable or returned no reliable sources.
I cannot provide a verified answer at this time."

----------------
Do NOT apologize excessively.
Do NOT speculate.
Do NOT provide links unless explicitly given.
"""

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
            print(f"DEBUG: Classifier Output: {res_text}")
            return "WEB_REQUIRED" in res_text
    except Exception as e:
        print(f"Classifier Error: {e}")
    
    return False

def perform_wikipedia_search(query):
    """
    Search Wikipedia API for reliable, structured knowledge.
    Uses generic 'requests' to avoid extra dependencies.
    """
    try:
        print(f"DEBUG: Checking Wikipedia for: {query}")
        # 1. Search for title
        search_url = "https://en.wikipedia.org/w/api.php"
        search_params = {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": query,
            "srlimit": 1
        }
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        
        resp = requests.get(search_url, params=search_params, headers=headers, timeout=5)
        data = resp.json()
        
        if not data.get("query", {}).get("search"):
            return None
            
        title = data["query"]["search"][0]["title"]
        
        # 2. Get Summary
        summary_params = {
            "action": "query",
            "format": "json",
            "prop": "extracts",
            "exintro": True,
            "explaintext": True,
            "titles": title
        }
        
        resp = requests.get(search_url, params=summary_params, headers=headers, timeout=5)
        data = resp.json()
        
        pages = data["query"]["pages"]
        page_id = next(iter(pages))
        extract = pages[page_id].get("extract")
        
        if extract:
            # Filter extremely short or disambiguation pages
            if "refer to:" in extract and len(extract) < 200:
                return None
            return f"Wikipedia Source ({title}):\n{extract[:2500]}"
            
    except Exception as e:
        print(f"Wikipedia Search Error: {e}")
    
    return None

def perform_web_search(query):
    """
    Perform Knowledge Search via Wikipedia API.
    (DuckDuckGo removed to minimize CPU usage/latency).
    """
    # Simply return the Wikipedia result. 
    # If None, we return None (no external context).
    return perform_wikipedia_search(query)

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
            
            # File Handling (Stage 1)
            if 'file' in request.files:
                file = request.files['file']
                if file and file.filename:
                    print(f"File attached: {file.filename} - Activating Stage 1 Multimodal Analysis")
                    if is_unsupported_binary(file.filename):
                        return jsonify({
                            'error': "File type not supported.\nSupported files: Images (.png, .jpg, .webp) and Plain Text (.txt, .md, .json, .csv)."
                        }), 400
                    
                    if allowed_file(file.filename):
                        file_type = get_file_type(file.filename)
                        # Invoke Stage 1
                        file_analysis_context = stage_1_analyze(file, file_type)
                        if file_analysis_context.startswith("Error") or file_analysis_context.startswith("Analysis failed"):
                             print(f"Stage 1 Failed: {file_analysis_context}")
                             return jsonify({'error': f"File Processing Failed: {file_analysis_context}"}), 500
                    else:
                         return jsonify({
                            'error': "File type not supported.\nSupported files: Images (.png, .jpg, .webp) and Plain Text (.txt, .md, .json, .csv)."
                        }), 400
                else:
                    print("Multipart request with no file - Bypassing Stage 1")
            else:
                print("Multipart request without 'file' key - Bypassing Stage 1")
        else:
            print("JSON request (Text Only) - Bypassing Stage 1")
            data = request.get_json() or {}
            user_message = data.get('message', '')
            session_id = data.get('session_id', 'default')
            selected_model = data.get('model', selected_model)


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
        # WEB SEARCH LOGIC (Auto-Classify)
        if user_message and len(user_message) > 5:
             print(f"DEBUG: Checking if web search is needed for: {user_message[:50]}...")
             if classify_query(user_message):
                 print("DEBUG: Web Search REQUIRED.")
                 search_results = perform_web_search(user_message)
                 
                 if search_results:
                     # Success: Inject Rules + Results
                     # The Prompt already handles instructions, so we just append it.
                     web_search_context = f"{WEB_SCRAPING_RULES_SYSTEM_PROMPT}\n\n<WEB_SEARCH_RESULTS>\n{search_results}\n</WEB_SEARCH_RESULTS>\n"
                 else:
                     # Failure: Inject Limit Prompt
                     # This forces the AI to admit failure gracefully.
                     web_search_context = f"{WEB_MODE_LIMIT_SYSTEM_PROMPT}\n"
             else:
                 print("DEBUG: Web Search NOT Required.")

        memory_manager = get_memory_manager(session_id)
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
        
        memory_manager.add_message('user', final_user_content)
        conversation_messages = memory_manager.get_conversation_buffer()

        # ============================================
        # STAGE-2: REASONER (Provider-based routing)
        # ============================================
        provider = model_info["provider"]
        
        print(f"DEBUG: Routing to provider: {provider} for model: {selected_model}")
        
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
            print(f"DEBUG: Calling OpenRouter API...")
            response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=60
            )
            print(f"DEBUG: OpenRouter response status: {response.status_code}")
        
        elif provider == "nim":
            headers = {
                "Authorization": f"Bearer {NVIDIA_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": selected_model,
                "messages": conversation_messages,
                "max_tokens": 4096
            }
            print(f"DEBUG: Calling NVIDIA NIM API...")
            response = requests.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=60
            )
            print(f"DEBUG: NVIDIA NIM response status: {response.status_code}")
        
        else:
            print(f"DEBUG: Invalid provider: {provider}")
            return jsonify({"error": "Invalid model provider"}), 500

        print(f"DEBUG: About to check response status...")
        if response.status_code == 200:
            api_response = response.json()
            bot_message = api_response['choices'][0]['message']['content'] or "Empty response"
            # Don't sanitize bot response - it's from trusted AI API and we use DOMPurify client-side
            memory_manager.add_message('assistant', bot_message)
            log_session_details(session_id, user_message, selected_model, conversation_messages, api_response=api_response)
            cleanup_old_sessions(max_sessions=500)
            return jsonify({'response': bot_message, 'model': selected_model, 'conversation_stats': memory_manager.get_conversation_stats()})
        else:
            # Log the actual error response for debugging
            try:
                error_response = response.json()
                print(f"DEBUG: API Error Response: {json.dumps(error_response, indent=2)}")
            except:
                print(f"DEBUG: API Error Response (raw): {response.text[:500]}")
            
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
        print(f"CHAT ENDPOINT ERROR: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        try:
            log_session_details(session_id, user_message, selected_model, conversation_messages, error=str(e))
        except:
            pass  # If logging fails, don't crash
        return jsonify({'error': str(e)}), 500

# DEV_MODE_START: Added missing endpoints for conversation management
@app.route('/api/conversation/stats', methods=['GET'])
def conversation_stats():
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
    try:
        data = request.get_json()
        query = data.get('message', '')
        if not query:
            return jsonify({'web_required': False})
            
        is_required = classify_query(query)
        return jsonify({'web_required': is_required})
    except Exception as e:
        print(f"Classification Endpoint Error: {e}")
        return jsonify({'web_required': False}) # Default to false on error

@app.route('/api/conversation/clear', methods=['POST'])
def clear_conversation():
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
# DEV_MODE_END

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

