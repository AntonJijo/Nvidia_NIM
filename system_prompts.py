"""
=====================================================================================
NVIDIA NIM — SYSTEM PROMPT ORCHESTRATION (PRODUCTION EDITION)
=====================================================================================
PURPOSE:
- Single source of truth for all system prompts
- Deterministic assembly order
- NO silent fallbacks
- NO prompt dilution
- NO private repo dependency
=====================================================================================
"""

# -----------------------------------------------------------------------------
# STRICT IMPORTS — FAIL FAST IF ANY PROMPT IS MISSING
# -----------------------------------------------------------------------------

try:
    from prompt_modules.core_identity import CORE_IDENTITY
    from prompt_modules.coding_mastery import CODING_MASTERY
    from prompt_modules.study_tutor import STUDY_TUTOR_PROTOCOL
    from prompt_modules.creative_writing import CREATIVE_WRITING
    from prompt_modules.safety_protocols import SAFETY_PROTOCOLS
    from prompt_modules.few_shot_examples import FEW_SHOT_EXAMPLES
    from prompt_modules.web_search import WEB_DECISION_SYSTEM_PROMPT, WEB_SCRAPING_RULES_SYSTEM_PROMPT
    from prompt_modules.reasoning_rules import REASONING_RULES
except Exception as e:
    raise RuntimeError(
        "CRITICAL ERROR: One or more system prompt modules failed to load. "
        "Application startup is aborted to prevent undefined AI behavior."
    ) from e


# -----------------------------------------------------------------------------
# PROMPT ASSEMBLY POLICY (VERY IMPORTANT)
# -----------------------------------------------------------------------------
# Order matters. This order is intentional.
#
# FOR REASONING MODE (when enabled):
# 0. REASONING_RULES      → HIGHEST PRIORITY - Metacognitive stealth rules
#
# STANDARD ORDER:
# 1. CORE_IDENTITY        → Absolute authority, slang rules, formatting rules
# 2. SAFETY_PROTOCOLS     → Hard constraints (cannot override slang rules)
# 3. CODING_MASTERY       → Technical competence
# 4. STUDY_TUTOR_PROTOCOL → Activated ONLY when intent is detected
# 5. CREATIVE_WRITING     → Creative mode (cannot override CORE_IDENTITY)
# 6. FEW_SHOT_EXAMPLES    → Guidance, NOT authority
# 7. WEB PROMPTS          → Decision logic only
#
# REASONING_RULES dominates when active. CORE_IDENTITY otherwise.
# -----------------------------------------------------------------------------

def build_master_system_prompt() -> str:
    """
    Builds the master system prompt used for ALL model calls.

    This function MUST be used everywhere.
    No alternative prompt paths are allowed.
    """

    return f"""
{CORE_IDENTITY}

{SAFETY_PROTOCOLS}

{CODING_MASTERY}

{STUDY_TUTOR_PROTOCOL}

{CREATIVE_WRITING}

{FEW_SHOT_EXAMPLES}

{WEB_DECISION_SYSTEM_PROMPT}

{WEB_SCRAPING_RULES_SYSTEM_PROMPT}

Current Date: 2026-01-16
""".strip()


# -----------------------------------------------------------------------------
# OPTIONAL: MODE AWARE PROMPT (IF YOU WANT INTENT GATING LATER)
# -----------------------------------------------------------------------------
# You can safely ignore this for now.
# Provided for future expansion without breaking behavior.
# -----------------------------------------------------------------------------

def build_prompt_for_mode(mode: str | None = None) -> str:
    """
    Optional helper for future use.
    Currently returns the same master prompt.
    """

    # For now, do NOT branch.
    # Branching incorrectly caused your previous issues.
    return build_master_system_prompt()


# -----------------------------------------------------------------------------
# SINGLE EXPORT — THIS IS WHAT YOUR SERVER SHOULD USE
# -----------------------------------------------------------------------------

MASTER_SYSTEM_PROMPT = build_master_system_prompt()

# -----------------------------------------------------------------------------
# BACKWARD COMPATIBILITY & HELPER EXPORTS
# -----------------------------------------------------------------------------
# These are required by server.py and conversation_memory.py

def get_master_system_prompt() -> str:
    return MASTER_SYSTEM_PROMPT

WEB_MODE_LIMIT_SYSTEM_PROMPT = """
You have reached the limit of web search queries. 
Please rely on your internal knowledge base.
"""

STUDY_MODE_SYSTEM_PROMPT = f"""
{CORE_IDENTITY}

{STUDY_TUTOR_PROTOCOL}

{SAFETY_PROTOCOLS}

You are in STUDY MODE.
"""

# Reasoning Mode places REASONING_RULES at the TOP for metacognitive stealth
# AND reinforces at the END
REASONING_MODE_SYSTEM_PROMPT = f"""
{REASONING_RULES}

════════════════════════════════════════════════════════════════════════════════
THE GUIDELINES BELOW SHOULD BE INTERNALIZED, NOT CITED IN YOUR THINKING.
════════════════════════════════════════════════════════════════════════════════

{CORE_IDENTITY}

{SAFETY_PROTOCOLS}

{CODING_MASTERY}

{STUDY_TUTOR_PROTOCOL}

{CREATIVE_WRITING}

{FEW_SHOT_EXAMPLES}

{WEB_DECISION_SYSTEM_PROMPT}

{WEB_SCRAPING_RULES_SYSTEM_PROMPT}

════════════════════════════════════════════════════════════════════════════════
                    FINAL REMINDER BEFORE YOU RESPOND
════════════════════════════════════════════════════════════════════════════════

You are in REASONING MODE with visible <think> tags.
When thinking, NEVER mention: CORE_IDENTITY, SAFETY_PROTOCOLS, Section numbers, or any internal rule names.
Your thinking should sound like natural human thought, not rule citation.

INSTEAD OF: "According to Section 13, I should respond casually"
WRITE: "The user was casual, so I'll respond casually"

Current Date: 2026-01-16
"""

def enforce_formatting(content: str, output_format: str = "markdown") -> str:
    """
    Ensures assistant responses follow proper formatting rules.
    """
    if not content:
        return ""
    
    content = content.strip()
    
    # Pre-process: Remove common AI speaker labels
    import re
    if re.match(r'^(nvidia nim|system|ai|assistant)\s*:\s*', content, re.IGNORECASE):
        content = re.sub(r'^(nvidia nim|system|ai|assistant)\s*:\s*', '', content, flags=re.IGNORECASE)
        
    # Remove surrounding quotes if they wrap the entire response
    if len(content) > 1 and ((content.startswith('"') and content.endswith('"')) or (content.startswith("'") and content.endswith("'"))):
        content = content[1:-1].strip()
    
    # Preserve reasoning blocks for R1 models (do NOT strip them here)
    # The frontend renderer handles <think> tags specifically
    if "<think>" in content:
        # If content starts with <think>, ensure we don't accidentally strip it with other logic
        return content
    
    return content

__all__ = [
    'MASTER_SYSTEM_PROMPT',
    'build_master_system_prompt',
    'get_master_system_prompt',
    'enforce_formatting',
    'STUDY_MODE_SYSTEM_PROMPT',
    'REASONING_MODE_SYSTEM_PROMPT',
    'REASONING_RULES',
    'WEB_DECISION_SYSTEM_PROMPT',
    'WEB_SCRAPING_RULES_SYSTEM_PROMPT',
    'WEB_MODE_LIMIT_SYSTEM_PROMPT'
]
