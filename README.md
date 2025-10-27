# Local AI Stack — Express + React + Ollama + Stable Diffusion

A fully local AI playground that combines:

* **Backend:** Node.js + **Express** (TypeScript/JavaScript) with **dotenv**
* **Frontend:** **React** + **Tailwind CSS** (Vite dev server)
* **LLMs:** **Ollama** (runs models locally)
* **Documents-to-LLM:** Local file reading & chunking (no cloud upload required)
* **Images:** Text-to-image via **Stable Diffusion** on a separate **Python FastAPI** server

All of this runs **offline** on your machine.

---

## ✨ Features

* 100% local inference (no keys required)
* Pluggable LLMs via Ollama (switch models per request)
* "Read my file" — drop PDFs/Docs/TXT and the server injects content into the prompt
* Image generation (Stable Diffusion via Python backend)
* Modular monorepo layout (frontend, express server, python image server)
* Simple REST API with cURL examples

---

## Prerequisites

* **Node.js** ≥ 18 and **npm** (or **pnpm/yarn**)
* **Python** ≥ 3.10 with **pip** + (optional) **virtualenv**
* **Git**
* **Ollama** installed: [https://ollama.com](https://ollama.com)
* **GPU** (optional but recommended) with proper drivers for PyTorch CUDA (if you want fast image gen)

---

## 🐪 Install Ollama & Pull Models

1. Install Ollama, then start the background service/app.
2. Pull at least one chat model (choose what runs on your hardware):

   ```bash
   ollama pull llama3.1      # Meta Llama 3.1 (good general model)
   # or
   ollama pull mistral
   # or
   ollama pull qwen2.5:7b
   ```
3. (Optional) Test:

   ```bash
   ollama run llama3.1 "Say hello"
   ```

---

## 🔐 Environment Variables

Create **.env** file in the Backend for the SQL Database
### `Backend/.env`

---

## Setup & Run (Development)

Clone the repo and install dependencies for each service.

```bash
# 1) Clone
git clone https://github.com/AhmadAlhourani19/Local-AI.git
cd Local-AI

# 2) Frontend
cd react-ui
npm install
# (Optional) Tailwind init already present in repo
# npm run dev (in a separate terminal)

# 3) Backend (Express)
cd ../Backend
npm install
# npm run dev (nodemon recommended)

# 4) Python Image Server
cd ../py-image-server
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
# Start the server (FastAPI via Uvicorn):
uvicorn main:app --host 127.0.0.1 --port 8001 --reload
```

Start everything:

* **Python SD server**: `uvicorn main:app --host 127.0.0.1 --port 8001 --reload`
* **Express API**: in `server/` → `npm run dev`
* **React app**: in `client/` → `npm run dev` (default Vite on `5173`)

Open the app: [http://localhost:5173](http://localhost:5173)

---

This project brings together local AI text and image generation in one unified, privacy-first environment — completely offline and fully customizable.
You own your data, your compute, and your creativity.
If you enjoy the project, consider sharing your feedback!
```
