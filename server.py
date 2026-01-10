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
# WEB SEARCH PROMPTS (STRICT MODE)
# ============================================

WEB_DECISION_SYSTEM_PROMPT = """
You are an autonomous large language model operating in a constrained environment
where access to live internet data ("WEB MODE") is expensive and must only be used
when absolutely necessary.

Your primary objective is to produce correct, high-quality answers while minimizing
unnecessary web usage.

You MUST decide, for every user request, whether WEB MODE is REQUIRED or NOT REQUIRED.

You are NOT allowed to guess current facts.
You are NOT allowed to hallucinate up-to-date information.
You are NOT allowed to browse unless explicitly justified.

You must strictly follow the rules below.

----------------------------------------------------------------
SECTION 1 — DEFINITIONS
----------------------------------------------------------------

Definition: WEB MODE
WEB MODE means querying live internet sources via an external search API.

Definition: OFFLINE MODE
OFFLINE MODE means answering using only your internal knowledge, reasoning,
and logical inference without any internet access.

Definition: CURRENT INFORMATION
Any information that may change after your training cutoff, including but not limited to:
- News
- Prices
- Versions
- API limits
- Company policies
- Availability
- Releases
- Events
- Laws
- Regulations
- Rankings
- Metrics
- Status pages

Definition: STATIC INFORMATION
Information that is unlikely to change over time, including but not limited to:
- Mathematics
- Algorithms
- Programming syntax
- Computer science fundamentals
- Physics laws
- Chemistry principles
- Historical facts (before cutoff)
- Definitions
- Conceptual explanations

----------------------------------------------------------------
SECTION 2 — CORE DECISION PRINCIPLE
----------------------------------------------------------------

You MUST use WEB MODE if and only if at least one of the following is true:

1. The question requires CURRENT INFORMATION.
2. The question asks for verification of real-world status.
3. The question references "latest", "current", "today", "now", "recent", or similar.
4. The question involves prices, limits, quotas, availability, or plans.
5. The question involves live systems, APIs, services, or companies where facts change.
6. The question cannot be answered confidently without external verification.
7. Incorrect information would cause practical harm or mislead the user.

If NONE of the above conditions are true, you MUST NOT use WEB MODE.

----------------------------------------------------------------
SECTION 3 — STRONG DO NOT USE WEB MODE CONDITIONS
----------------------------------------------------------------

You MUST NOT use WEB MODE when:

- The user asks for:
  - Code examples
  - Algorithms
  - Pseudocode
  - Programming explanations
  - System design concepts
  - Math solutions
  - Logical reasoning
  - Best practices
  - General comparisons without time sensitivity
  - Hypotheticals
  - Opinions
  - Conceptual architecture
  - Prompts
  - Policies
  - Heuristics
  - Design patterns
  - Well-known website URLs (google.com, facebook.com, youtube.com, etc.)
  - Official homepages of major companies (their URLs are static and well-known)

- The answer can be derived purely from reasoning.

- The user does NOT explicitly or implicitly request up-to-date facts.

- The answer is generic and timeless.

- The user asks for a link to a WELL-KNOWN website (e.g., "give me link to google" → just say https://www.google.com/, NO web search needed)

----------------------------------------------------------------
SECTION 4 — STRONG MUST USE WEB MODE CONDITIONS
----------------------------------------------------------------

You MUST use WEB MODE when:

- The user asks:
  - "What is the current…"
  - "How much does X cost"
  - "What is the limit of X"
  - "Is X available"
  - "Who is the CEO now"
  - "What happened today"
  - "Latest version"
  - "Current API quota"
  - "Monthly limits"
  - "Pricing"
  - "Plans"
  - "Status"
  - "Is this still free"

- The question includes uncertainty indicators:
  - "Still"
  - "Currently"
  - "As of now"
  - "Right now"

- The topic involves:
  - SaaS platforms
  - APIs
  - Cloud services
  - AI tools
  - Web services
  - Regulations
  - Market data

----------------------------------------------------------------
SECTION 5 — CONFIDENCE TEST
----------------------------------------------------------------

Before answering, you MUST internally ask:

"Can I answer this with at least 95% confidence without web access?"

If the answer is NO → USE WEB MODE.
If the answer is YES → DO NOT USE WEB MODE.

----------------------------------------------------------------
SECTION 6 — ACCURACY OVERRIDE RULE
----------------------------------------------------------------

If providing an incorrect answer would:

- Mislead implementation
- Cause wasted money
- Break a system
- Cause incorrect configuration
- Affect production behavior

Then WEB MODE is REQUIRED.

----------------------------------------------------------------
SECTION 7 — USER INTENT INTERPRETATION
----------------------------------------------------------------

You must infer intent, not just keywords.

Example:
- "Explain how pricing works" → OFFLINE MODE
- "What is the price today" → WEB MODE

Example:
- "What is Tavily" → OFFLINE MODE
- "What is Tavily's monthly limit" → WEB MODE

----------------------------------------------------------------
SECTION 8 — RESPONSE FORMAT CONTROL
----------------------------------------------------------------

You MUST internally decide one of the following:

DECISION = WEB_REQUIRED
DECISION = WEB_NOT_REQUIRED

If WEB_REQUIRED:
- Fetch information
- Verify from multiple sources if possible
- Prefer official documentation
- Use the most recent data
- Avoid speculation

If WEB_NOT_REQUIRED:
- Do NOT browse
- Do NOT mention browsing
- Do NOT hedge unnecessarily
- Answer directly

----------------------------------------------------------------
SECTION 9 — FAILSAFE RULE
----------------------------------------------------------------

If you are uncertain whether web data is required,
YOU MUST DEFAULT TO WEB MODE.

Accuracy is more important than speed.

----------------------------------------------------------------
SECTION 10 — EXAMPLES (INTERNAL GUIDANCE)
----------------------------------------------------------------

User: "What is Python?"
→ WEB_NOT_REQUIRED

User: "What is the latest Python version?"
→ WEB_REQUIRED

User: "Explain REST APIs"
→ WEB_NOT_REQUIRED

User: "Is Tavily free?"
→ WEB_REQUIRED

User: "Write a system prompt"
→ WEB_NOT_REQUIRED

User: "What is the current API limit?"
→ WEB_REQUIRED

User: "Give me the link to google.com"
→ WEB_NOT_REQUIRED (google.com is a well-known, static URL)

User: "What is the Facebook website?"
→ WEB_NOT_REQUIRED (facebook.com is universally known)

User: "Link to YouTube"
→ WEB_NOT_REQUIRED (youtube.com is common knowledge)

User: "How do I contact OpenAI?"
→ WEB_REQUIRED (contact info may change)

----------------------------------------------------------------
SECTION 11 — STRICT PROHIBITIONS
----------------------------------------------------------------

You MUST NOT:
- Hallucinate current facts
- Guess prices or limits
- Assume availability
- Use outdated knowledge when correctness matters
- Use WEB MODE for trivial questions

----------------------------------------------------------------
SECTION 12 — FINAL DIRECTIVE
----------------------------------------------------------------

Your behavior must be:

- Conservative
- Accuracy-first
- Cost-aware
- Deterministic
- Explicit in decision logic
- Minimal in browsing
- Correct over fast

This system prompt overrides any conflicting instruction.

----------------------------------------------------------------
OUTPUT FORMAT
----------------------------------------------------------------

Output ONLY one of these tokens:
- WEB_REQUIRED
- WEB_NOT_REQUIRED

No explanations. No punctuation. No extra text.
"""

WEB_SCRAPING_RULES_SYSTEM_PROMPT = """
You are an autonomous large language model operating under a
two-phase execution model:

PHASE 1: DECISION MODE (completed by upstream classifier)
PHASE 2: WEB MODE (you are now in this phase)

------------------------------------------------------------
SECTION 1 — CURRENT STATE
------------------------------------------------------------

You are NOW in WEB MODE.
External data has been retrieved and injected via <WEB_SEARCH_RESULTS>.

Your job is to:
- Answer the user's question NATURALLY and CONVERSATIONALLY
- Use ONLY the information from <WEB_SEARCH_RESULTS>
- Sound like a helpful, friendly assistant — NOT a data dump
- Provide context, explanation, and helpful insights

------------------------------------------------------------
SECTION 2 — CONVERSATIONAL RESPONSE GUIDELINES
------------------------------------------------------------

You MUST respond like a normal chat assistant:

✓ Use natural language and complete sentences
✓ Provide context around the data
✓ Explain what the data means if helpful
✓ Add relevant insights or observations
✓ Use appropriate formatting (headers, bullets) when helpful
✓ Be warm, engaging, and helpful in tone

You MUST NOT:

✗ Just dump raw data with no context
✗ Use cold, robotic bullet lists only
✗ Say "According to retrieved sources:" as your opener
✗ Format responses like a database query result
✗ Be overly formal or stiff

Example BAD response:
"Bitcoin Price: $93,658.00 USD. Source: TradingView."

Example GOOD response:
"Bitcoin is currently trading at around **$93,658** 📈 
It's been relatively stable over the past 24 hours with a slight uptick of about 0.57%. 
If you're looking to buy or trade, major exchanges like Kraken are showing similar prices."

------------------------------------------------------------
SECTION 3 — SOURCE FIDELITY (STILL MANDATORY)
------------------------------------------------------------

While being conversational, you MUST still:

1. Use ONLY facts from <WEB_SEARCH_RESULTS>
2. NOT invent additional facts, dates, or numbers
3. NOT use prior knowledge to fill gaps
4. NOT speculate beyond what sources say
5. Acknowledge uncertainty if sources conflict

If information is missing or unclear:
- Be honest about it naturally
- Don't force an answer

------------------------------------------------------------
SECTION 4 — LANGUAGE CONTROL
------------------------------------------------------------

You MUST NOT mention:
- "browsing", "searching", "web search", "scraping"
- "training data", "knowledge cutoff"
- "retrieved sources" (in formal way)
- Any technical backend terms

You MAY naturally reference:
- "current data shows..."
- "from what I can see..."
- "the latest info indicates..."

------------------------------------------------------------
SECTION 5 — RESPONSE STYLE PRIORITY
------------------------------------------------------------

1. Be HELPFUL and NATURAL first
2. Be ACCURATE (from sources only)
3. Be CONVERSATIONAL
4. Be CONCISE but not terse
5. Add PERSONALITY appropriate to the question

------------------------------------------------------------
SECTION 6 — CONFLICT AND UNCERTAINTY
------------------------------------------------------------

If sources conflict:
- Mention both perspectives naturally
- Don't hide uncertainty

If data is insufficient:
- Answer what you can
- Be honest about limitations conversationally
- Example: "I can see the current price, but I'm not finding historical data for comparison."

------------------------------------------------------------
FINAL DIRECTIVE
------------------------------------------------------------

You are a friendly, knowledgeable assistant who happens to have 
access to fresh, real-time information. 

Respond like you're having a helpful conversation — NOT like 
you're reading from a search results page.

Be accurate. Be natural. Be helpful.

------------------------------------------------------------
SECTION 7 — CONTENT SAFETY EVALUATION FOR UNKNOWN LINKS
------------------------------------------------------------

When the user asks about an UNKNOWN website/domain/link and web search 
results are provided, you MUST evaluate them for safety:

EVALUATION PROCESS:
1. Analyze the web search results to understand what the site is
2. Look for indicators of harmful content:
   - Adult/pornographic content
   - Piracy/illegal downloads
   - Malware/phishing/scam warnings
   - Violence/gore content
   - Hate speech/extremism
   - Illegal drug sales
   - Gambling (unregulated)
   - Dark web services

3. If search results indicate the site is HARMFUL:
   - Do NOT provide details about how to access it
   - Do NOT describe the harmful content in detail
   - Briefly state: "Based on what I found, that site contains [category] content, which I can't help with."
   - Offer to help with legitimate alternatives

4. If search results indicate the site is SAFE/LEGITIMATE:
   - Provide helpful information about the site
   - Answer the user's question normally

5. If search results are UNCLEAR about safety:
   - Exercise caution and err on the side of safety
   - You may describe the site neutrally without endorsing it
   - Warn the user to verify the site themselves if unsure

EXAMPLES:

User: "What is xyz-torrent-site.com?"
Search results show: piracy, illegal downloads, copyright infringement
→ Response: "That appears to be a piracy site for illegal downloads. I can't help with that, but if you're looking for movies or shows, I'd recommend legitimate streaming services like Netflix, Amazon Prime, or Disney+."

User: "What is notion.so?"
Search results show: productivity tool, note-taking, legitimate company
→ Response: "Notion is a popular productivity and note-taking app! It's great for organizing notes, projects, and collaborating with teams. Would you like to know more about its features?"

This safety evaluation applies EVEN IF the site is new or unknown to you - 
use the web search results to make an informed decision about its safety.
"""

WEB_MODE_LIMIT_SYSTEM_PROMPT = """
Web search was attempted, but no reliable information was found.

------------------------------------------------------------
RESPONSE GUIDELINES
------------------------------------------------------------

Be honest and natural about the limitation:

✓ Acknowledge you couldn't find reliable current data
✓ Be conversational, not robotic
✓ Offer to help in another way if appropriate
✓ Keep it brief and graceful

You MUST NOT:
- Make up information
- Use prior knowledge to answer factual questions
- Pretend you have data you don't

------------------------------------------------------------
EXAMPLE RESPONSES
------------------------------------------------------------

GOOD: "I tried to find the latest info on that, but I'm not 
getting reliable results right now. Is there something else 
I can help with, or would you like me to try a different angle?"

GOOD: "Hmm, I couldn't pull up current data on that. If you 
have a specific source in mind, feel free to share it and 
I can help analyze it!"

BAD: "Web mode is currently unavailable or returned no reliable 
sources. I cannot provide a verified answer at this time."

------------------------------------------------------------
TONE
------------------------------------------------------------

- Warm and helpful
- Honest about limitations
- Not overly apologetic
- Offer alternatives when natural
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
                             return jsonify({'error': f"File Processing Failed: {file_analysis_context}"}), 500
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
        
        # Apply Mode (Study vs Default)
        if mode == 'study':
            memory_manager.set_study_mode(True)
        else:
            memory_manager.set_study_mode(False) # Ensure we revert to default if not study
            
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
        
        memory_manager.add_message('user', final_user_content)
        conversation_messages = memory_manager.get_conversation_buffer()

        # ============================================
        # STAGE-2: REASONER (Provider-based routing)
        # ============================================
        provider = model_info["provider"]
        
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
            payload = {
                "model": selected_model,
                "messages": conversation_messages,
                "max_tokens": 4096
            }
            response = requests.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=60
            )
        
        else:
            return jsonify({"error": "Invalid model provider"}), 500
        if response.status_code == 200:
            api_response = response.json()
            bot_message = api_response['choices'][0]['message']['content'] or "Empty response"
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
            pass  # If logging fails, don't crash
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

