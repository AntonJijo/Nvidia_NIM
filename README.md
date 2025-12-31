# NVIDIA NIM Chatbot 🤖

An advanced, privacy-focused AI assistant powered by **NVIDIA NIM** and **OpenRouter**, designed with a premium, responsive interface.

![Chatbot Screenshot](code-icons/Readme_scr.png)

## ✨ Features

- **🎨 Premium Interface**: A sleek, minimal, and fully responsive dark-mode UI with sidebar history, smooth animations, and Markdown support.
- **🧠 Multi-Model Engine**: Switch instantly between top-tier models, including:
  - **Meta Llama 4 Maverick 17B**
  - **DeepSeek R1 & V3.1** (Reasoning Experts)
  - **Qwen 2.5 & 3 Series**
  - **Google Gemma 3 27B**
  - **OpenAI GPT OSS 120B**
- **🌐 Intelligent Web Search**: Automatically detects intent (e.g., "Latest news", "Stock prices") and fetches factual summaries from Wikipedia.
- **📂 Multimodal Analysis**: Upload text files for deep analysis or images for vision-based insights.
- **💾 Local Persistence**: Your chats are saved securely in your browser's local storage—no account required.
- **⚡ High Performance**: Non-blocking classification checks and streaming-style responses.

---

## 🚧 Beta Features & Limitations

The following advanced capabilities are currently in **BETA**:

* **🖼️ Image Analysis**
* **📂 File Analysis**
* **🌐 Web Search (Wiki Mode)**

**Please Note:** These features **will not work perfectly** at all times. They require significant performance and system resources to process, scrape, or analyze external data. You may experience occasional latency, timeouts, or limitations when using these specific tool-based features compared to standard text generation. We are continuously optimizing them!

---

## 💻 Technologies

- **Backend**: Flask (Python) with Gunicorn
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **AI Integrations**: NVIDIA NIM, OpenRouter, Wikipedia API

---

## 🙌 Acknowledgements

Built with ❤️ using [Flask](https://flask.palletsprojects.com/), [NVIDIA NIM](https://build.nvidia.com/), and [OpenRouter](https://openrouter.ai/).
