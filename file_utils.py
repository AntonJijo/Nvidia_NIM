import logging
import json

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Strict Safe File Types
ALLOWED_EXTENSIONS = {
    'txt', 'md', 'json', 'csv', 
    'png', 'jpg', 'jpeg', 'webp'
}

TEXT_EXTENSIONS = {'txt', 'md', 'json', 'csv'}
IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_file_type(filename):
    ext = filename.rsplit('.', 1)[1].lower()
    if ext in TEXT_EXTENSIONS:
        return 'text'
    elif ext in IMAGE_EXTENSIONS:
        return 'image'
    return 'unknown'

def extract_text_from_file(file_storage):
    """
    Extracts text from safe text files (txt, md, json, csv).
    Reads content as plain UTF-8 text.
    """
    filename = file_storage.filename
    ext = filename.rsplit('.', 1)[1].lower()
    content = ""

    try:
        # Reset file pointer to beginning
        file_storage.seek(0)
        
        if ext in TEXT_EXTENSIONS:
            # Read as plain text
            content = file_storage.read().decode('utf-8', errors='ignore')
        else:
            return None, "Unsupported text extraction format"

        return content, None

    except Exception as e:
        logger.error(f"Error processing file {filename}: {e}")
        return None, str(e)

def is_unsupported_binary(filename):
    """
    Returns True if the file type is NOT in the supported list.
    Strict whitelist approach: Anything not allowed is unsupported.
    """
    return not allowed_file(filename)
