const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config(); // Load environment variables from a .env file

const app = express();
const PORT = process.env.PORT || 3000;

// Enable middleware
app.use(cors());
app.use(express.json());

// Initialize a simple JSON database file for tracking VIP Keys
const DB_FILE = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ vipKeys: [] }, null, 2));
}

// Helper functions to read/write JSON database safely
function readDatabase() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { vipKeys: [] };
    }
}

function writeDatabase(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Razorpay Credentials from Environment Variables
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_id';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret';

// Helper to make secure HTTPS requests to Razorpay API without heavy SDK dependencies
function makeRazorpayRequest(path, method, payload) {
    return new Promise((resolve, reject) => {
        const dataString = JSON.stringify(payload);
        const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        
        const options = {
            hostname: 'api.razorpay.com',
            port: 443,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': dataString.length,
                'Authorization': `Basic ${auth}`
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(dataString);
        req.end();
    });
}


// 1. Secure Gemini AI Generation Proxy (Keeps API Key hidden from Client inspect element)
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
    }
    if (!apiKey) {
        return res.status(500).json({ error: "Gemini API key is not configured on the server!" });
    }

    try {
        const systemPrompt = "You are a professional social media script writer. Write a highly engaging, punchy script for vertical short videos. Output ONLY raw text script. Keep it up to 40 words.";
        const userQuery = `Write a viral script on: ${prompt}`;
        
        const payload = JSON.stringify({
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            port: 443,
            path: `/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            }
        };

        const apiReq = https.request(options, (apiRes) => {
            let responseData = '';
            apiRes.on('data', (chunk) => responseData += chunk);
            apiRes.on('end', () => {
                try {
                    const result = JSON.parse(responseData);
                    const aiText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (aiText) {
                        res.json({ text: aiText.trim() });
                    } else {
                        res.status(500).json({ error: "Gemini returned empty structure" });
                    }
                } catch (e) {
                    res.status(500).json({ error: "Failed to parse Gemini response" });
                }
            });
        });

        apiReq.on('error', (e) => {
            res.status(500).json({ error: "Failed to connect to Google API" });
        });

        apiReq.write(payload);
        apiReq.end();

    } catch (err) {
        res.status(500).json({ error: "Internal server error during script generation" });
    }
});

// 2. Razorpay Create Order Endpoint
app.post('/api/create-order', async (req, res) => {
    try {
        const payload = {
            amount: 9900, // ₹99 in paisa
            currency: "INR",
            receipt: `receipt_studio_${Date.now()}`
        };

        const order = await makeRazorpayRequest('/v1/orders', 'POST', payload);
        res.json({ orderId: order.id, keyId: RAZORPAY_KEY_ID });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create payment order" });
    }
});

// 3. Razorpay Verify Payment and Generate VIP Key
app.post('/api/verify-payment', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const text = razorpay_order_id + "|" + razorpay_payment_id;
    const generated_signature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(text)
        .digest('hex');

    if (generated_signature === razorpay_signature) {
        // Generate a cryptographically secure random VIP key for this transaction
        const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        const vipKey = `VIP-${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;

        const db = readDatabase();
        db.vipKeys.push({
            key: vipKey,
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            createdAt: new Date().toISOString()
        });
        writeDatabase(db);

        res.json({ success: true, vipKey: vipKey });
    } else {
        res.status(400).json({ error: "Invalid payment signature verification failed!" });
    }
});

// 4. Verification Endpoint for Client VIP activations
app.post('/api/verify-vip', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Key is required" });

    // Hardcoded master bypass key for admin testing
    if (key.toUpperCase() === 'VIRAL_STUDIO_99') {
        return res.json({ valid: true });
    }

    const db = readDatabase();
    const keyMatch = db.vipKeys.find(item => item.key.toUpperCase() === key.toUpperCase());

    if (keyMatch) {
        res.json({ valid: true });
    } else {
        res.status(404).json({ valid: false, error: "License key not found in server records." });
    }
});

// Serves the full interactive responsive frontend directly
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Text to Short Video Generator (VIP Pro)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Montserrat:wght@700;900&family=Bebas+Neue&family=Caveat:wght@700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <!-- Razorpay Web Checkout Integration -->
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    
    <style>
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #030408;
            background-image: radial-gradient(circle at 50% 0%, #1e1136 0%, #030408 70%);
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #090d16; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 4px; }
        .preset-btn { transition: all 0.2s ease; }
        .preset-btn:hover { transform: scale(1.15); }
        .vip-glow { box-shadow: 0 0 15px rgba(168, 85, 247, 0.4); animation: pulse-glow 2s infinite alternate; }
        @keyframes pulse-glow {
            0% { box-shadow: 0 0 12px rgba(168, 85, 247, 0.3); }
            100% { box-shadow: 0 0 25px rgba(244, 63, 94, 0.6); }
        }
    </style>
</head>
<body class="text-slate-100 min-h-screen flex flex-col justify-between">

    <!-- Top Navigation Header -->
    <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40 px-6 py-4">
        <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-xl bg-gradient-to-tr from-amber-500 via-fuchsia-600 to-violet-600 flex items-center justify-center shadow-lg vip-glow">
                    <i class="fa-solid fa-wand-magic-sparkles text-white text-xl"></i>
                </div>
                <div>
                    <h1 class="text-2xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-amber-400 via-fuchsia-400 to-violet-400">
                        AI Short Video Studio Pro
                    </h1>
                    <p class="text-xs text-slate-400 font-medium">Create viral captioned shorts instantly with intelligent auto-emojis</p>
                </div>
            </div>
            
            <div class="flex items-center gap-3">
                <div id="vip-status-badge" class="text-xs px-4 py-2 rounded-full bg-slate-900 border border-slate-800 text-slate-300 flex items-center gap-2 font-bold">
                    <i class="fa-solid fa-circle-user text-slate-500"></i> Free Account (2 exports/day)
                </div>
                <button id="btn-upgrade-vip" onclick="openVIPModal()" class="bg-gradient-to-r from-amber-500 to-fuchsia-600 hover:from-amber-400 hover:to-fuchsia-500 text-slate-950 font-extrabold px-4 py-2 rounded-full text-xs transition shadow-lg flex items-center gap-1.5 active:scale-95">
                    <i class="fa-solid fa-crown text-slate-950 animate-bounce"></i> Unlock VIP Pro
                </button>
            </div>
        </div>
    </header>

    <!-- Main Studio Space -->
    <main class="flex-grow max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        <!-- Left Side: Massive Customization & Input Panel -->
        <div class="lg:col-span-7 flex flex-col gap-6 overflow-y-auto max-h-[82vh] pr-2">
            
            <!-- Step 1: Script Area -->
            <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl">
                <div class="flex justify-between items-center mb-3">
                    <h3 class="font-bold text-slate-200 flex items-center gap-2">
                        <span class="w-6 h-6 rounded-lg bg-violet-500/20 text-violet-400 flex items-center justify-center text-xs">1</span>
                        Script & AI Workspace
                    </h3>
                    <button onclick="loadSampleText()" class="text-xs text-violet-400 hover:text-violet-300 font-semibold transition">
                        ⚡ Load Sample Script
                    </button>
                </div>

                <div class="mb-4 p-3 bg-slate-950 rounded-xl border border-violet-900/30">
                    <div class="flex justify-between items-center mb-2">
                        <label class="block text-xs font-bold text-violet-400 uppercase tracking-wide">✨ Gemini Script Engine</label>
                        <span id="ai-usage-badge" class="text-[10px] bg-violet-500/10 text-violet-400 border border-violet-500/20 px-2 py-0.5 rounded-full font-bold">Free Tier</span>
                    </div>
                    <div class="flex gap-2">
                        <input type="text" id="ai-prompt" placeholder="Write any topic (e.g., 'Success Mantra', 'Quantum Physics')" class="flex-grow bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-violet-500">
                        <button id="btn-ai-generate" onclick="generateScriptWithAI()" class="bg-violet-600 hover:bg-violet-500 text-white font-bold px-3 py-2 rounded-lg text-xs transition flex items-center gap-1.5 shrink-0">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Generate
                        </button>
                    </div>
                    <div id="ai-loading" class="hidden text-[11px] text-violet-400 mt-2 flex items-center gap-2 animate-pulse">
                        <span class="w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></span>
                        AI writing specialized social script...
                    </div>
                </div>

                <textarea id="script-input" rows="4" 
                    class="w-full bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition resize-none text-sm leading-relaxed"
                    placeholder="Enter script text here... Try words like: money, fire, rocket, love, fact, star to trigger the auto-emojis!"></textarea>
                <div class="flex justify-between items-center mt-2 text-xs text-slate-500">
                    <span id="char-count">0 characters</span>
                    <span id="word-count">0 words detected</span>
                </div>
            </div>

            <!-- Step 2: Customization Settings Panel -->
            <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-6">
                <h3 class="font-bold text-slate-200 flex items-center gap-2">
                    <span class="w-6 h-6 rounded-lg bg-fuchsia-500/20 text-fuchsia-400 flex items-center justify-center text-xs">2</span>
                    Dynamic Engine Configurations
                </h3>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    
                    <!-- Aspect Ratio -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">📐 Aspect Ratio Menu</label>
                        <select id="aspect-ratio" onchange="changeAspectRatio()" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                            <option value="9:16">📱 9:16 (Shorts/Reels)</option>
                            <option value="16:9">💻 16:9 (Landscape YouTube)</option>
                            <option value="1:1">🟩 1:1 (Square post)</option>
                            <option value="4:5">📸 4:5 (Instagram Portrait)</option>
                            <option value="2:3">🎨 2:3 (Classic Portrait)</option>
                        </select>
                    </div>

                    <!-- Animation Templates -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">💥 Animation Templates (Alex Hormozi VIP)</label>
                        <select id="animation-style" onchange="checkPremiumTemplate()" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                            <option value="typewriter-classic" selected>📟 Typewriter & End Full Script (Free)</option>
                            <option value="single-pop">💥 Single Big Word Pop (Free)</option>
                            <option value="sentence-highlight">📝 Sentence Highlight Active Word (Free)</option>
                            <option value="neon-glow" class="text-amber-400">🔥 Neon Glow Karaoke (👑 VIP)</option>
                            <option value="hormozi-impact" class="text-amber-400">🚀 Hormozi High-Impact Bold (👑 VIP)</option>
                        </select>
                    </div>

                    <!-- Font Family -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">✍️ Font Family</label>
                        <select id="font-family" onchange="updateCanvas()" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                            <option value="Montserrat">Montserrat (Modern Bold)</option>
                            <option value="Bebas Neue">Bebas Neue (Heavy Impact)</option>
                            <option value="'Plus Jakarta Sans'">Plus Jakarta Sans (Sleek Clean)</option>
                            <option value="Caveat">Caveat (Handwritten Bold)</option>
                        </select>
                    </div>

                    <!-- Speed Controls -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex justify-between">
                            <span>Words Per Minute (WPM)</span>
                            <span id="wpm-display" class="text-violet-400 font-bold">140 WPM</span>
                        </label>
                        <input type="range" id="wpm-slider" min="60" max="300" step="10" value="140" oninput="changeWPM(this.value)" class="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-violet-500 my-3">
                    </div>

                    <!-- Font Size Controls -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex justify-between">
                            <span>Text Font Size</span>
                            <span id="size-display" class="text-violet-400 font-bold">40px</span>
                        </label>
                        <input type="range" id="font-size-slider" min="20" max="100" step="4" value="40" oninput="changeFontSize(this.value)" class="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-violet-500 my-3">
                    </div>

                    <!-- Auto Emojis Control -->
                    <div>
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex justify-between">
                            <span>Auto Emojis Style</span>
                            <span class="text-amber-400 font-bold">👑 Hormozi Look Active</span>
                        </label>
                        <select id="auto-emoji-mode" onchange="updateCanvas()" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                            <option value="floating">🛸 Bouncing Top Floating (Recommended)</option>
                            <option value="inline">📝 Beside Caption Word</option>
                            <option value="disabled">❌ Disable Auto-Emojis</option>
                        </select>
                    </div>

                </div>

                <!-- Background Preset Selector -->
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">🌈 Background Preset Theme</label>
                    <select id="bg-type" onchange="changeBgType()" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                        <option value="gradient" selected>🌈 Cyberpunk Purple Gradient</option>
                        <option value="dark-slate">🌑 Minimalist Dark Slate</option>
                        <option value="red-fire">🔥 Red Flame Glow</option>
                        <option value="neon-matrix">👾 Neon Matrix Purple Frame</option>
                    </select>
                </div>

                <!-- Demo Voice Selector -->
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">🗣️ Brahmin Voiceover Profiles</label>
                    <div class="flex gap-2">
                        <select id="tts-voice" class="flex-grow bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-300 focus:outline-none focus:border-violet-500">
                            <option value="rocky" selected>🎙️ Rocky (Bold English Male)</option>
                            <option value="aria">🌸 Aria (Sweet English Female)</option>
                            <option value="shera">🦁 Shera (Heavy Hindi Male)</option>
                            <option value="priya">✨ Priya (Clear Hindi Female)</option>
                            <option value="robo">🤖 Robo-9000 (Cybernetic Robot)</option>
                            <option value="none">🔕 Silent / Custom Upload Mode</option>
                        </select>
                        <button onclick="testVoiceoverSound()" class="bg-violet-600/30 hover:bg-violet-600 border border-violet-500/50 text-violet-200 font-bold px-4 py-2 rounded-xl text-xs transition flex items-center gap-2 shrink-0">
                            <i class="fa-solid fa-volume-high"></i> Test Voice
                        </button>
                    </div>
                </div>

                <!-- Color Palettes -->
                <div class="border-t border-slate-800/80 pt-4">
                    <div class="flex justify-between items-center mb-2">
                        <label class="text-xs font-semibold text-slate-400 uppercase tracking-wider">🎨 Default Text Color Palette</label>
                        <input type="color" id="text-color" value="#ffffff" onchange="updateCanvas()" class="w-6 h-6 rounded bg-transparent cursor-pointer">
                    </div>
                    <div class="grid grid-cols-10 gap-2" id="text-color-grid"></div>
                </div>

                <div class="border-t border-slate-800/80 pt-4">
                    <div class="flex justify-between items-center mb-2">
                        <label class="text-xs font-semibold text-slate-400 uppercase tracking-wider">⭐ Active Word Highlight Accents</label>
                        <input type="color" id="highlight-color" value="#facc15" onchange="updateCanvas()" class="w-6 h-6 rounded bg-transparent cursor-pointer">
                    </div>
                    <div class="grid grid-cols-10 gap-2" id="highlight-color-grid"></div>
                </div>

                <!-- Background Songs & Music Integration -->
                <div class="border-t border-slate-800/80 pt-4 flex flex-col gap-4">
                    <div class="flex items-center justify-between">
                        <label class="block text-xs font-bold text-fuchsia-400 uppercase tracking-wider">
                            <i class="fa-solid fa-music"></i> Add Background Music / Song
                        </label>
                        <div class="flex items-center gap-2">
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="music-enable" class="sr-only peer" onchange="toggleBackgroundMusicState()">
                                <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-violet-600 peer-checked:to-fuchsia-600"></div>
                                <span class="ml-2 text-[10px] text-slate-400 font-semibold peer-checked:text-fuchsia-400">Enable BG Music</span>
                            </label>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/60">
                        <div>
                            <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Select Music Source</label>
                            <select id="music-source-type" onchange="toggleMusicSourceInput()" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-300 focus:outline-none focus:border-violet-500">
                                <option value="local">📂 Local Storage (Upload MP3/WAV)</option>
                                <option value="online">🌐 Online URL (Stream Direct Link)</option>
                            </select>
                        </div>

                        <div>
                            <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1 flex justify-between">
                                <span>Background Music Volume</span>
                                <span id="bg-volume-display" class="text-fuchsia-400 font-bold">30%</span>
                            </label>
                            <input type="range" id="bg-music-volume" min="0" max="100" step="5" value="30" oninput="changeBgMusicVolume(this.value)" class="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-fuchsia-500 my-2">
                        </div>

                        <div id="local-music-container" class="md:col-span-2">
                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Upload Music File</label>
                            <input type="file" id="local-music-upload" accept="audio/*" onchange="handleBackgroundMusicUpload(event)" class="w-full text-xs bg-slate-900 border border-slate-800 rounded-lg p-2 text-slate-400 focus:outline-none">
                        </div>

                        <div id="online-music-container" class="md:col-span-2 hidden">
                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Stream URL (Direct MP3 Link)</label>
                            <div class="flex gap-2">
                                <input type="url" id="online-music-url" placeholder="Paste direct audio URL (e.g. https://example.com/song.mp3)" class="flex-grow bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-violet-500">
                                <button onclick="loadOnlineMusicFromUrl()" class="bg-violet-600 hover:bg-violet-500 text-white font-semibold px-3 py-2 rounded-lg text-xs transition shrink-0">
                                    Load URL
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Custom Voiceover Upload -->
                <div class="border-t border-slate-800/80 pt-4">
                    <label class="block text-xs font-bold text-violet-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <i class="fa-solid fa-microphone"></i> Upload Custom Voiceover (Optional)
                    </label>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/60">
                        <div>
                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Voiceover File</label>
                            <input type="file" id="custom-audio-upload" accept="audio/*" onchange="handleAudioUpload(event)" class="w-full text-xs bg-slate-900 border border-slate-800 rounded-lg p-2 text-slate-400 focus:outline-none">
                        </div>
                        <div>
                            <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1 flex justify-between">
                                <span>Voiceover Volume</span>
                                <span id="voice-volume-display" class="text-violet-400 font-bold">100%</span>
                            </label>
                            <input type="range" id="voice-volume-slider" min="0" max="100" step="5" value="100" oninput="changeVoiceoverVolume(this.value)" class="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-violet-500 my-2">
                        </div>
                    </div>
                    <audio id="uploaded-audio" class="hidden"></audio>
                    <audio id="bg-music-audio" loop class="hidden"></audio>
                </div>

            </div>
        </div>

        <!-- Right Side: Live Video Preview -->
        <div class="lg:col-span-5 flex flex-col items-center justify-start gap-6">
            <div class="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col items-center relative overflow-hidden">
                <div class="w-full flex justify-between items-center mb-4">
                    <h3 class="font-bold text-slate-200 flex items-center gap-2">
                        <i class="fa-solid fa-circle-play text-fuchsia-500"></i> Live Studio Monitor
                    </h3>
                    <span id="aspect-badge" class="text-[10px] px-2.5 py-1 bg-slate-800 rounded-full border border-slate-700 text-slate-300 uppercase tracking-wider font-bold">9:16 Portrait</span>
                </div>

                <div class="relative w-full flex items-center justify-center bg-slate-950 rounded-xl overflow-hidden border border-slate-800/80 shadow-2xl" style="height: 480px;">
                    <canvas id="video-canvas" width="540" height="960" class="max-h-full max-w-full shadow-2xl transition-all duration-300 rounded-lg"></canvas>
                    <div class="absolute bottom-0 left-0 w-full h-1 bg-slate-900/60 z-10">
                        <div id="video-progress" class="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 w-0 transition-all duration-100"></div>
                    </div>
                    <div class="absolute inset-0 bg-slate-950/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-4">
                        <button onclick="togglePlayback()" id="overlay-play-btn" class="w-14 h-14 rounded-full bg-white/10 backdrop-blur-md hover:bg-white/20 text-white flex items-center justify-center shadow-lg transform transition active:scale-95">
                            <i class="fa-solid fa-play text-xl"></i>
                        </button>
                    </div>
                </div>

                <div class="w-full grid grid-cols-3 gap-2 mt-4">
                    <button id="btn-play" onclick="togglePlayback()" class="bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-bold py-3 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-violet-500/10">
                        <i id="play-icon" class="fa-solid fa-play"></i> <span id="play-text">Play Preview</span>
                    </button>
                    <button onclick="stopPlayback()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold py-3 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition active:scale-95">
                        <i class="fa-solid fa-stop text-red-400"></i> Stop
                    </button>
                    <button id="btn-export" onclick="exportVideo()" class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold py-3 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-amber-500/10">
                        <i class="fa-solid fa-download"></i> Export Video
                    </button>
                </div>

                <div id="recording-toast" class="hidden absolute top-4 inset-x-4 bg-red-600/90 border border-red-500 text-white p-3 rounded-xl flex items-center justify-between text-xs font-bold animate-bounce z-20">
                    <span class="flex items-center gap-2">
                        <span class="w-2.5 h-2.5 rounded-full bg-white animate-ping"></span>
                        Recording & Exporting Canvas Video... Please Wait.
                    </span>
                    <span id="recording-timer" class="bg-red-800 px-2 py-0.5 rounded">0s</span>
                </div>
            </div>
        </div>

    </main>

    <!-- VIP Premium Modal (Razorpay Enabled Flow) -->
    <div id="vip-modal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <button onclick="closeVIPModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white transition">
                <i class="fa-solid fa-xmark text-lg"></i>
            </button>
            
            <div class="text-center flex flex-col items-center gap-4">
                <div class="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-400 text-3xl vip-glow mb-2">
                    <i class="fa-solid fa-crown"></i>
                </div>
                <h3 class="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-fuchsia-500">Go VIP Pro Lifetime!</h3>
                <p class="text-xs text-slate-400 max-w-xs">Upgrade instantly for ₹99 to unlock maximum organic growth potential.</p>
                
                <ul class="text-xs text-slate-300 space-y-2 text-left w-full bg-slate-950 p-4 rounded-xl border border-slate-800/60">
                    <li><i class="fa-solid fa-circle-check text-emerald-400 mr-2"></i> **Remove Watermark** (Clean visual exports)</li>
                    <li><i class="fa-solid fa-circle-check text-emerald-400 mr-2"></i> **Unlimited Script Exports** (No daily limits)</li>
                    <li><i class="fa-solid fa-circle-check text-emerald-400 mr-2"></i> **Hormozi & Neon glow styles** fully unlocked</li>
                </ul>

                <!-- Razorpay Checkout CTA Button -->
                <button onclick="startSecureRazorpayCheckout()" class="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-fuchsia-600 text-slate-950 font-black text-sm shadow-xl hover:from-amber-400 hover:to-fuchsia-500 transition active:scale-95 flex items-center justify-center gap-2">
                    <i class="fa-solid fa-credit-card"></i> Pay Securely ₹99 via UPI / Card
                </button>

                <div class="w-full mt-2 pt-4 border-t border-slate-800/60 flex flex-col gap-2">
                    <label class="text-[10px] font-bold text-slate-500 text-left uppercase">Have a VIP Key / Payment Code?</label>
                    <div class="flex gap-2">
                        <input type="text" id="vip-key-input" placeholder="e.g. VIP-ABCD-1234" class="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 flex-grow uppercase">
                        <button onclick="applyVIPKey()" class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 rounded-lg text-xs transition active:scale-95">
                            Verify Code
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('video-canvas');
        const ctx = canvas.getContext('2d');
        const scriptInput = document.getElementById('script-input');
        const charCount = document.getElementById('char-count');
        const wordCount = document.getElementById('word-count');
        
        let wordsArray = [];
        let currentWordIndex = -1;
        let currentCharIndex = -1;
        let isPlaying = false;
        let wpm = 140;
        let fontSize = 40;
        let wordScale = 1.0; 
        let activeBgStyle = 'gradient';
        let isRecording = false;
        let mediaRecorder = null;
        let recordedChunks = [];
        let waveTime = 0;
        
        let startTime = 0;
        let playbackTime = 0;
        let animFrameId = null;

        let audioContext = null;
        let voiceGainNode = null;
        let musicGainNode = null;
        let recordDestination = null; 
        let customVoiceSource = null;
        let backgroundMusicSource = null;
        let customAudioFile = null;
        let customMusicFile = null;

        const emojiDictionary = {
            "money": "💰", "cash": "💸", "success": "🏆", "growth": "📈", "viral": "🚀",
            "fire": "🔥", "danger": "⚠️", "idea": "💡", "rocket": "🚀", "time": "⏱️",
            "love": "❤️", "star": "⭐", "shock": "😱", "amazing": "🤩", "win": "👑",
            "future": "🛸", "scifi": "👽", "music": "🎵", "audio": "🔊", "video": "🎬",
            "secret": "🤫", "target": "🎯", "brain": "🧠", "power": "⚡", "happy": "😊",
            "sad": "😢", "fact": "📝", "space": "🌌", "earth": "🌍", "mars": "🪐",
            "pro": "👑", "upgrade": "💎", "gold": "🪙", "plan": "📊"
        };

        const textColors = ["#ffffff", "#f3f4f6", "#e5e7eb", "#d1d5db", "#fde047", "#facc15", "#f59e0b", "#fb7185", "#f43f5e", "#ec4899", "#d946ef", "#a21caf", "#06b6d4", "#22d3ee", "#34d399", "#10b981", "#a7f3d0", "#bae6fd", "#c084fc", "#fbcfe8"];
        const highlightColors = ["#facc15", "#22c55e", "#06b6d4", "#ec4899", "#ff4500", "#a855f7", "#38bdf8", "#fb7185", "#4ade80", "#14b8a6", "#eab308", "#ff007f", "#39ff14", "#ff007f", "#8b5cf6", "#f472b6", "#22d3ee", "#059669", "#c084fc", "#fb923c"];
        const sampleText = "AI Video Studio Pro is officially live! Transform single sentences into high impact captions containing money, fire, and success elements. Enter our payment VIP code to unlock the ultimate Alex Hormozi style templates instantly!";

        function showToast(message, type = 'error') {
            const toastContainer = document.getElementById('toast-notification') || createToastContainer();
            toastContainer.innerText = message;
            toastContainer.className = \`fixed top-6 right-6 px-5 py-3 rounded-xl font-bold text-sm shadow-2xl z-50 transition-all duration-300 transform translate-y-0 opacity-100 \${
                type === 'error' ? 'bg-red-600 border border-red-500 text-white' : 'bg-amber-500 border border-amber-500 text-slate-950'
            }\`;
            setTimeout(() => {
                toastContainer.className = 'fixed top-6 right-6 px-5 py-3 rounded-xl font-bold text-sm shadow-2xl z-50 transition-all duration-300 transform -translate-y-10 opacity-0 pointer-events-none';
            }, 3000);
        }

        function createToastContainer() {
            const div = document.createElement('div');
            div.id = 'toast-notification';
            div.className = 'fixed top-6 right-6 px-5 py-3 rounded-xl font-bold text-sm shadow-2xl z-50 transition-all duration-300 transform -translate-y-10 opacity-0 pointer-events-none';
            document.body.appendChild(div);
            return div;
        }

        function checkVIPStatus() {
            return localStorage.getItem('vip_pro_user') === 'true';
        }

        // --- Razorpay Payment API Call Integration ---
        async function startSecureRazorpayCheckout() {
            try {
                // Request server to create order ID
                const response = await fetch('/api/create-order', { method: 'POST' });
                const data = await response.json();

                if (!data.orderId) {
                    showToast("Failed to initiate secure connection with Razorpay", "error");
                    return;
                }

                const options = {
                    key: data.keyId,
                    amount: 9900,
                    currency: "INR",
                    name: "AI Short Video Studio Pro",
                    description: "Lifetime VIP Premium Access Bundle",
                    order_id: data.orderId,
                    handler: async function (response) {
                        // Payment success, verify signature on backend securely
                        const verificationRes = await fetch('/api/verify-payment', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(response)
                        });
                        const verificationData = await verificationRes.json();

                        if (verificationData.success) {
                            localStorage.setItem('vip_pro_user', 'true');
                            showToast(\`VIP Unlocked successfully! Code: \${verificationData.vipKey}\`, "success");
                            closeVIPModal();
                            updateVIPUI();
                            updateCanvas();
                        } else {
                            showToast("Verification failed. Please contact support.", "error");
                        }
                    },
                    prefill: { name: "Creator User", email: "user@example.com" },
                    theme: { color: "#8b5cf6" }
                };

                const rzp = new Razorpay(options);
                rzp.open();
            } catch (err) {
                console.error(err);
                showToast("Server payment error occurred.", "error");
            }
        }

        async function applyVIPKey() {
            const key = document.getElementById('vip-key-input').value.trim();
            if (!key) return showToast("Enter VIP activation key!", "error");

            try {
                const res = await fetch('/api/verify-vip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: key })
                });
                const data = await res.json();

                if (data.valid) {
                    localStorage.setItem('vip_pro_user', 'true');
                    showToast("Lifetime VIP Pro Unlocked!", "success");
                    closeVIPModal();
                    updateVIPUI();
                    updateCanvas();
                } else {
                    showToast(data.error || "Invalid VIP License Code!", "error");
                }
            } catch (err) {
                showToast("Verification network error.", "error");
            }
        }

        function updateVIPUI() {
            const badge = document.getElementById('vip-status-badge');
            const upgradeBtn = document.getElementById('btn-upgrade-vip');
            if (checkVIPStatus()) {
                badge.innerHTML = \`<i class="fa-solid fa-crown text-amber-400"></i> Active VIP Pro (Unlimited)\`;
                badge.className = "text-xs px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center gap-2 font-bold";
                upgradeBtn.classList.add('hidden');
                document.getElementById('ai-usage-badge').innerHTML = "VIP Premium Tier";
                document.getElementById('ai-usage-badge').className = "text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full font-bold";
            }
        }

        function checkPremiumTemplate() {
            const val = document.getElementById('animation-style').value;
            if ((val === 'neon-glow' || val === 'hormozi-impact') && !checkVIPStatus()) {
                showToast("This template is VIP Pro Only!", "error");
                document.getElementById('animation-style').value = 'typewriter-classic';
                openVIPModal();
            }
            updateCanvas();
        }

        function openVIPModal() { document.getElementById('vip-modal').classList.remove('hidden'); }
        function closeVIPModal() { document.getElementById('vip-modal').classList.add('hidden'); }

        window.addEventListener('load', () => {
            scriptInput.value = sampleText;
            updateWordAndCharCount();
            buildColorGrids();
            changeAspectRatio();
            updateVIPUI();
            
            scriptInput.addEventListener('input', () => {
                updateWordAndCharCount();
                updateCanvas();
            });
        });

        function buildColorGrids() {
            const baseGrid = document.getElementById('text-color-grid');
            const highlightGrid = document.getElementById('highlight-color-grid');

            textColors.forEach(color => {
                const btn = document.createElement('button');
                btn.className = "w-6 h-6 rounded-full border border-slate-700/80 preset-btn cursor-pointer";
                btn.style.backgroundColor = color;
                btn.onclick = () => {
                    document.getElementById('text-color').value = color;
                    updateCanvas();
                };
                baseGrid.appendChild(btn);
            });

            highlightColors.forEach(color => {
                const btn = document.createElement('button');
                btn.className = "w-6 h-6 rounded-full border border-slate-700/80 preset-btn cursor-pointer";
                btn.style.backgroundColor = color;
                btn.onclick = () => {
                    document.getElementById('highlight-color').value = color;
                    updateCanvas();
                };
                highlightGrid.appendChild(btn);
            });
        }

        function loadSampleText() {
            scriptInput.value = sampleText;
            updateWordAndCharCount();
            updateCanvas();
        }

        function updateWordAndCharCount() {
            const text = scriptInput.value.trim();
            charCount.innerText = \`\${text.length} characters\`;
            
            if (text === '') {
                wordsArray = [];
                wordCount.innerText = '0 words detected';
                return;
            }
            wordsArray = text.split(/\\s+/).filter(word => word.length > 0);
            wordCount.innerText = \`\${wordsArray.length} words detected\`;
        }

        function changeAspectRatio() {
            const ratio = document.getElementById('aspect-ratio').value;
            const badge = document.getElementById('aspect-badge');
            
            if (ratio === '9:16') {
                canvas.width = 540; canvas.height = 960; badge.innerText = '9:16 Portrait';
            } else if (ratio === '16:9') {
                canvas.width = 960; canvas.height = 540; badge.innerText = '16:9 Landscape';
            } else if (ratio === '1:1') {
                canvas.width = 600; canvas.height = 600; badge.innerText = '1:1 Square';
            } else if (ratio === '4:5') {
                canvas.width = 540; canvas.height = 675; badge.innerText = '4:5 Social';
            } else if (ratio === '2:3') {
                canvas.width = 540; canvas.height = 810; badge.innerText = '2:3 Classic';
            }
            updateCanvas();
        }

        function changeWPM(val) {
            wpm = parseInt(val);
            document.getElementById('wpm-display').innerText = \`\${wpm} WPM\`;
            if (isPlaying) {
                const elapsedMs = playbackTime * 1000;
                startTime = Date.now() - elapsedMs;
            }
        }

        function changeFontSize(val) {
            fontSize = parseInt(val);
            document.getElementById('size-display').innerText = \`\${fontSize}px\`;
            updateCanvas();
        }

        function changeBgType() {
            activeBgStyle = document.getElementById('bg-type').value;
            updateCanvas();
        }

        function drawWatermark() {
            if (checkVIPStatus()) return; 
            ctx.save();
            ctx.font = "bold 14px 'Plus Jakarta Sans'";
            ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
            ctx.shadowColor = "rgba(0,0,0,0.5)";
            ctx.shadowBlur = 4;
            ctx.textAlign = 'center';
            ctx.fillText("Made with AIShorts.com ⚡", canvas.width / 2, canvas.height - 30);
            ctx.restore();
        }

        function drawPrecalculatedWrappedText(text, x, y, maxWidth, lineHeight, activeCharIdx = -1, mode = 'typewriter') {
            const words = text.split(/\\s+/).filter(w => w.length > 0);
            let lines = [];
            let currentLine = [];
            
            words.forEach((word) => {
                const testLine = currentLine.concat([word]).join(' ');
                const testWidth = ctx.measureText(testLine).width;
                if (testWidth > maxWidth && currentLine.length > 0) {
                    lines.push(currentLine.join(' '));
                    currentLine = [word];
                } else {
                    currentLine.push(word);
                }
            });
            if (currentLine.length > 0) {
                lines.push(currentLine.join(' '));
            }

            const totalHeight = lines.length * lineHeight;
            let startY = y - (totalHeight / 2) + (lineHeight / 2);
            
            let charCounter = 0;
            let lastPrintedX = x;
            let lastPrintedY = startY;

            const baseColor = document.getElementById('text-color').value;
            const highlightColor = document.getElementById('highlight-color').value;

            lines.forEach((lineText, lineIdx) => {
                const yPos = startY + (lineIdx * lineHeight);
                const lineWidth = ctx.measureText(lineText).width;
                let startX = x - (lineWidth / 2);
                
                let currentX = startX;
                for (let i = 0; i < lineText.length; i++) {
                    const char = lineText[i];
                    const charWidth = ctx.measureText(char).width;
                    
                    if (mode === 'full-highlight') {
                        ctx.save();
                        ctx.fillStyle = highlightColor;
                        ctx.shadowColor = highlightColor;
                        ctx.shadowBlur = 8;
                        ctx.fillText(char, currentX + charWidth/2, yPos);
                        ctx.restore();
                    } else if (mode === 'full-base') {
                        ctx.fillStyle = baseColor;
                        ctx.shadowBlur = 0;
                        ctx.fillText(char, currentX + charWidth/2, yPos);
                    } else { 
                        if (charCounter < activeCharIdx) {
                            ctx.fillStyle = baseColor;
                            ctx.shadowBlur = 0;
                            ctx.fillText(char, currentX + charWidth/2, yPos);
                            lastPrintedX = currentX + charWidth;
                            lastPrintedY = yPos;
                        }
                    }
                    currentX += charWidth;
                    charCounter++;
                }
                charCounter++; 
            });

            if (mode === 'typewriter' && activeCharIdx >= 0 && activeCharIdx < text.length) {
                if (Math.floor(Date.now() / 300) % 2 === 0) {
                    ctx.save();
                    ctx.fillStyle = highlightColor;
                    ctx.shadowColor = highlightColor;
                    ctx.shadowBlur = 10;
                    ctx.fillText("|", lastPrintedX, lastPrintedY);
                    ctx.restore();
                }
            }
        }

        function drawSmartEmoji(activeWord, x, y) {
            const mode = document.getElementById('auto-emoji-mode').value;
            if (mode === 'disabled') return;

            const cleanWord = activeWord.toLowerCase().replace(/[.,\\/#!$%\\^&\\*;:{}=\\-_\`~()]/g,"");
            const emoji = emojiDictionary[cleanWord];
            if (!emoji) return;

            ctx.save();
            ctx.font = \`\${fontSize * 1.5}px Arial\`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (mode === 'floating') {
                const bounceOffset = Math.sin(waveTime * 5) * 10 - 65;
                ctx.shadowColor = "rgba(0,0,0,0.5)";
                ctx.shadowBlur = 15;
                ctx.fillText(emoji, x, y + bounceOffset);
            } else if (mode === 'inline') {
                ctx.fillText(emoji, x + ctx.measureText(activeWord).width / 1.5 + 20, y);
            }
            ctx.restore();
        }

        function updateCanvas() {
            if (wordsArray.length === 0) {
                drawBackground();
                drawCenteredPlaceholder();
                return;
            }

            drawBackground();

            const template = document.getElementById('animation-style').value;
            const font = document.getElementById('font-family').value;
            const baseColor = document.getElementById('text-color').value;
            const highlightColor = document.getElementById('highlight-color').value;

            ctx.font = \`bold \${fontSize}px \${font}\`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (!isPlaying && currentWordIndex === -1) {
                drawPrecalculatedWrappedText(scriptInput.value, canvas.width / 2, canvas.height / 2, canvas.width - 60, fontSize * 1.5, -1, 'full-base');
                drawWatermark();
                return;
            }

            const activeIndex = currentWordIndex < 0 ? 0 : currentWordIndex;
            const activeWord = wordsArray[activeIndex] || "";
            const isFinished = currentWordIndex >= wordsArray.length;

            if (isFinished) {
                ctx.save();
                ctx.font = \`bold \${Math.max(fontSize - 8, 22)}px \${font}\`;
                drawPrecalculatedWrappedText(scriptInput.value, canvas.width / 2, canvas.height / 2, canvas.width - 60, fontSize * 1.5, -1, 'full-highlight');
                ctx.restore();
                drawWatermark();
                return;
            }

            ctx.save();

            if (template === 'typewriter-classic') {
                drawPrecalculatedWrappedText(scriptInput.value, canvas.width / 2, canvas.height / 2, canvas.width - 60, fontSize * 1.5, currentCharIndex, 'typewriter');
                drawSmartEmoji(wordsArray[activeIndex] || "", canvas.width / 2, canvas.height / 2);
            } 
            else if (template === 'single-pop') {
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.scale(wordScale, wordScale);
                ctx.fillStyle = highlightColor;
                ctx.shadowColor = highlightColor;
                ctx.shadowBlur = 15;
                ctx.fillText(activeWord.toUpperCase(), 0, 0);
                drawSmartEmoji(activeWord, 0, 0);
            } 
            else if (template === 'sentence-highlight') {
                const numWordsToDisplay = 5;
                const half = Math.floor(numWordsToDisplay / 2);
                let start = Math.max(0, activeIndex - half);
                let end = Math.min(wordsArray.length, start + numWordsToDisplay);
                const segment = wordsArray.slice(start, end);
                const segActiveIdx = activeIndex - start;
                const centerY = canvas.height / 2;
                const lineHeight = fontSize * 1.4;

                segment.forEach((word, index) => {
                    const yPos = centerY + (index - segActiveIdx) * lineHeight;
                    if (index === segActiveIdx) {
                        ctx.fillStyle = highlightColor;
                        ctx.shadowColor = highlightColor; ctx.shadowBlur = 12;
                        ctx.fillText(word, canvas.width / 2, yPos);
                        drawSmartEmoji(word, canvas.width / 2, yPos);
                    } else {
                        ctx.fillStyle = hexToRgba(baseColor, 0.4);
                        ctx.fillText(word, canvas.width / 2, yPos);
                    }
                });
            } 
            else if (template === 'neon-glow') {
                ctx.font = \`italic 900 \${fontSize * 1.2}px 'Bebas Neue'\`;
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = '#d946ef'; ctx.shadowBlur = 20;
                ctx.fillText(activeWord.toUpperCase(), canvas.width / 2, canvas.height / 2);
                drawSmartEmoji(activeWord, canvas.width / 2, canvas.height / 2);
            } 
            else if (template === 'hormozi-impact') {
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.scale(wordScale * 1.1, wordScale * 1.1);
                ctx.rotate(-0.04);
                ctx.font = \`italic 900 \${fontSize * 1.25}px 'Montserrat'\`;
                ctx.strokeStyle = '#000000'; ctx.lineWidth = 12;
                ctx.strokeText(activeWord.toUpperCase(), 0, 0);
                const colors = ['#facc15', '#22c55e', '#ffffff', '#06b6d4'];
                ctx.fillStyle = colors[activeIndex % colors.length];
                ctx.fillText(activeWord.toUpperCase(), 0, 0);
                drawSmartEmoji(activeWord, 0, 0);
            } 

            ctx.restore();
            drawWatermark();
        }

        function drawCenteredPlaceholder() {
            ctx.font = "italic bold 20px 'Plus Jakarta Sans'";
            ctx.fillStyle = "#64748b";
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.fillText("Design spectacular captions here!", canvas.width / 2, canvas.height / 2);
        }

        function hexToRgba(hex, alpha) {
            let r = parseInt(hex.slice(1, 3), 16),
                g = parseInt(hex.slice(3, 5), 16),
                b = parseInt(hex.slice(5, 7), 16);
            return \`rgba(\${r}, \${g}, \${b}, \${alpha})\`;
        }

        function drawBackground() {
            const w = canvas.width;
            const h = canvas.height;
            waveTime += 0.02;

            if (activeBgStyle === 'gradient') {
                const grad = ctx.createLinearGradient(0, 0, w, h);
                grad.addColorStop(0, '#1e1b4b'); grad.addColorStop(0.5, '#311042'); grad.addColorStop(1, '#020617');
                ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
            } else if (activeBgStyle === 'dark-slate') {
                ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, w, h);
            } else if (activeBgStyle === 'red-fire') {
                const grad = ctx.createLinearGradient(0, 0, 0, h);
                grad.addColorStop(0, '#450a0a'); grad.addColorStop(1, '#020617');
                ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
            } else if (activeBgStyle === 'neon-matrix') {
                ctx.fillStyle = '#05050c'; ctx.fillRect(0, 0, w, h);
                ctx.strokeStyle = '#a21caf'; ctx.lineWidth = 12; ctx.strokeRect(10, 10, w-20, h-20);
            }
        }

        function animationLoop() {
            if (!isPlaying) return;

            const elapsedMs = Date.now() - startTime;
            playbackTime = elapsedMs / 1000;

            const wordsPerSecond = wpm / 60;
            const charactersPerSecond = wordsPerSecond * 5.2;

            currentCharIndex = Math.floor(playbackTime * charactersPerSecond);
            currentWordIndex = Math.floor(playbackTime * wordsPerSecond);

            const totalDuration = wordsArray.length / wordsPerSecond;
            const progressPercentage = Math.min((playbackTime / totalDuration) * 100, 100);
            document.getElementById('video-progress').style.width = \`\${progressPercentage}%\`;

            if (currentWordIndex !== Math.floor((playbackTime - 0.05) * wordsPerSecond)) {
                wordScale = 1.35;
            }
            if (wordScale > 1.0) {
                wordScale -= 0.06;
            }

            if (playbackTime >= totalDuration) {
                currentWordIndex = wordsArray.length;
                currentCharIndex = scriptInput.value.length;
                updateCanvas();
                
                setTimeout(() => {
                    if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
                        mediaRecorder.stop();
                    }
                    stopPlayback();
                }, 1500); 
                return;
            }

            updateCanvas();
            animFrameId = requestAnimationFrame(animationLoop);
        }

        function togglePlayback() {
            if (wordsArray.length === 0) {
                showToast("Please enter some script text first!", 'error');
                return;
            }
            if (isPlaying) {
                pausePlayback();
            } else {
                startPlayback();
            }
        }

        function initAudioEngine() {
            if (audioContext) return;

            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                recordDestination = audioContext.createMediaStreamDestination();

                voiceGainNode = audioContext.createGain();
                const initialVoiceVolume = parseInt(document.getElementById('voice-volume-slider').value) / 100;
                voiceGainNode.gain.setValueAtTime(initialVoiceVolume, audioContext.currentTime);
                voiceGainNode.connect(audioContext.destination);
                voiceGainNode.connect(recordDestination);

                const voicePlayer = document.getElementById('uploaded-audio');
                try {
                    customVoiceSource = audioContext.createMediaElementSource(voicePlayer);
                    customVoiceSource.connect(voiceGainNode);
                } catch (e) {
                    console.warn(e);
                }

                musicGainNode = audioContext.createGain();
                const initialMusicVolume = parseInt(document.getElementById('bg-music-volume').value) / 100;
                musicGainNode.gain.setValueAtTime(initialMusicVolume, audioContext.currentTime);
                musicGainNode.connect(audioContext.destination);
                musicGainNode.connect(recordDestination);

                const musicPlayer = document.getElementById('bg-music-audio');
                try {
                    backgroundMusicSource = audioContext.createMediaElementSource(musicPlayer);
                    backgroundMusicSource.connect(musicGainNode);
                } catch (e) {
                    console.warn(e);
                }

            } catch (err) {
                console.error(err);
            }
        }

        function toggleMusicSourceInput() {
            const type = document.getElementById('music-source-type').value;
            const localBox = document.getElementById('local-music-container');
            const onlineBox = document.getElementById('online-music-container');
            if (type === 'local') {
                localBox.classList.remove('hidden');
                onlineBox.classList.add('hidden');
            } else {
                localBox.classList.add('hidden');
                onlineBox.classList.remove('hidden');
            }
        }

        function handleBackgroundMusicUpload(event) {
            const file = event.target.files[0];
            if (file) {
                customMusicFile = URL.createObjectURL(file);
                document.getElementById('bg-music-audio').src = customMusicFile;
                document.getElementById('music-enable').checked = true;
                showToast("Background music uploaded!", "success");
            }
        }

        function loadOnlineMusicFromUrl() {
            const url = document.getElementById('online-music-url').value.trim();
            if (!url) return showToast("Enter a valid URL!", "error");
            const musicPlayer = document.getElementById('bg-music-audio');
            musicPlayer.crossOrigin = "anonymous";
            musicPlayer.src = url;
            musicPlayer.load();
            document.getElementById('music-enable').checked = true;
            showToast("Online music source loaded!", "success");
        }

        function handleAudioUpload(event) {
            const file = event.target.files[0];
            if (file) {
                customAudioFile = URL.createObjectURL(file);
                document.getElementById('uploaded-audio').src = customAudioFile;
                document.getElementById('tts-voice').value = 'none'; 
                showToast("Voiceover uploaded!", "success");
            }
        }

        function changeBgMusicVolume(val) {
            document.getElementById('bg-volume-display').innerText = \`\${val}%\`;
            if (audioContext && musicGainNode) musicGainNode.gain.setValueAtTime(val / 100, audioContext.currentTime);
        }

        function changeVoiceoverVolume(val) {
            document.getElementById('voice-volume-display').innerText = \`\${val}%\`;
            if (audioContext && voiceGainNode) voiceGainNode.gain.setValueAtTime(val / 100, audioContext.currentTime);
        }

        function toggleBackgroundMusicState() {
            const isChecked = document.getElementById('music-enable').checked;
            const musicPlayer = document.getElementById('bg-music-audio');
            if (isChecked && isPlaying) {
                initAudioEngine();
                if (audioContext && audioContext.state === 'suspended') audioContext.resume();
                musicPlayer.currentTime = playbackTime % (musicPlayer.duration || 1);
                musicPlayer.play().catch(e => console.warn(e));
            } else {
                musicPlayer.pause();
            }
        }

        function startPlayback() {
            updateWordAndCharCount();
            if (wordsArray.length === 0) return;

            isPlaying = true;
            document.getElementById('play-icon').className = 'fa-solid fa-pause';
            document.getElementById('play-text').innerText = 'Pause Preview';
            document.getElementById('overlay-play-btn').innerHTML = '<i class="fa-solid fa-pause text-xl"></i>';
            
            if (currentWordIndex >= wordsArray.length || currentWordIndex === -1) {
                playbackTime = 0;
                currentWordIndex = 0;
                currentCharIndex = 0;
            }

            startTime = Date.now() - (playbackTime * 1000);
            initAudioEngine();
            if (audioContext && audioContext.state === 'suspended') audioContext.resume();

            animFrameId = requestAnimationFrame(animationLoop);

            const musicPlayer = document.getElementById('bg-music-audio');
            const isMusicEnabled = document.getElementById('music-enable').checked;
            if (isMusicEnabled && musicPlayer.src) {
                musicPlayer.currentTime = playbackTime % (musicPlayer.duration || 1);
                musicPlayer.play().catch(e => console.warn(e));
            }

            const audioPlayer = document.getElementById('uploaded-audio');
            if (customAudioFile) {
                audioPlayer.currentTime = playbackTime;
                audioPlayer.play().catch(e => console.log(e));
            } else {
                playSpeechTTS();
            }
        }

        function pausePlayback() {
            isPlaying = false;
            document.getElementById('play-icon').className = 'fa-solid fa-play';
            document.getElementById('play-text').innerText = 'Play Preview';
            document.getElementById('overlay-play-btn').innerHTML = '<i class="fa-solid fa-play text-xl"></i>';
            if (animFrameId) cancelAnimationFrame(animFrameId);
            window.speechSynthesis.cancel();
            document.getElementById('uploaded-audio').pause();
            document.getElementById('bg-music-audio').pause();
        }

        function stopPlayback() {
            pausePlayback();
            currentWordIndex = -1;
            currentCharIndex = -1;
            playbackTime = 0;
            document.getElementById('video-progress').style.width = '0%';
            updateCanvas();
        }

        function configureVoiceProfile(profile, utterance) {
            const systemVoices = window.speechSynthesis.getVoices();
            if (profile === 'rocky') {
                utterance.lang = 'en-US'; utterance.pitch = 0.9; utterance.rate = wpm / 140;
                const v = systemVoices.find(v => v.lang.startsWith('en') && (v.name.toLowerCase().includes('male') || v.name.toLowerCase().includes('david') || v.name.toLowerCase().includes('google')));
                if (v) utterance.voice = v;
            } else if (profile === 'aria') {
                utterance.lang = 'en-US'; utterance.pitch = 1.25; utterance.rate = wpm / 135;
                const v = systemVoices.find(v => v.lang.startsWith('en') && (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('google')));
                if (v) utterance.voice = v;
            } else if (profile === 'shera') {
                utterance.lang = 'hi-IN'; utterance.pitch = 0.85; utterance.rate = wpm / 150;
                const v = systemVoices.find(v => v.lang.startsWith('hi') && v.name.toLowerCase().includes('google'));
                if (v) utterance.voice = v;
            } else if (profile === 'priya') {
                utterance.lang = 'hi-IN'; utterance.pitch = 1.15; utterance.rate = wpm / 145;
                const v = systemVoices.find(v => v.lang.startsWith('hi') && v.name.toLowerCase().includes('female'));
                if (v) utterance.voice = v;
            } else if (profile === 'robo') {
                utterance.lang = 'en-US'; utterance.pitch = 0.45; utterance.rate = wpm / 160;
                const v = systemVoices.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('google'));
                if (v) utterance.voice = v;
            }
        }

        function playSpeechTTS() {
            const selectedVoice = document.getElementById('tts-voice').value;
            if (selectedVoice === 'none') return;
            window.speechSynthesis.cancel();
            const activeIndex = currentWordIndex < 0 ? 0 : currentWordIndex;
            const textToSpeak = wordsArray.slice(activeIndex).join(" ");
            const utterance = new SpeechSynthesisUtterance(textToSpeak);
            configureVoiceProfile(selectedVoice, utterance);
            window.speechSynthesis.speak(utterance);
        }

        function testVoiceoverSound() {
            const selectedVoice = document.getElementById('tts-voice').value;
            if (selectedVoice === 'none') return showToast("Choose a voice profile!", 'error');
            window.speechSynthesis.cancel();
            const testPhrases = {
                rocky: "Hey, I am Rocky. Let's make an incredible dynamic video right now!",
                aria: "Hello there! I am Aria, and I am super excited to help you design beautiful captions.",
                shera: "नमस्ते दोस्तों, मैं हूँ शेरा! आपकी शानदार वीडियो अब मिनटों में तैयार हो जाएगी।",
                priya: "नमस्ते, मेरा नाम प्रिया है। चलिए मिलकर एक बहुत ही सुंदर और नया वीडियो बनाते हैं।",
                robo: "System active. Robo-9000 online and ready."
            };
            const utterance = new SpeechSynthesisUtterance(testPhrases[selectedVoice] || "Testing voice active.");
            configureVoiceProfile(selectedVoice, utterance);
            window.speechSynthesis.speak(utterance);
            showToast(\`Vocal testing: \${selectedVoice.toUpperCase()}\`, 'success');
        }

        // --- Frontend Calls Secure Backend Proxy ---
        async function generateScriptWithAI() {
            const promptInput = document.getElementById('ai-prompt').value.trim();
            if (!promptInput) return showToast("Enter a topic first!", 'error');

            const btn = document.getElementById('btn-ai-generate');
            const loader = document.getElementById('ai-loading');
            btn.disabled = true; loader.classList.remove('hidden');

            try {
                const response = await fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: promptInput })
                });
                const result = await response.json();

                if (result?.text) {
                    scriptInput.value = result.text;
                    updateWordAndCharCount();
                    updateCanvas();
                    showToast("Script generated securely!", 'success');
                } else {
                    showToast(result.error || "Unable to generate script.", 'error');
                }
            } catch (err) {
                showToast("Error connecting to server.", 'error');
            } finally {
                btn.disabled = false; loader.classList.add('hidden');
            }
        }

        function exportVideo() {
            if (wordsArray.length === 0) return showToast("Write a script to export!", 'error');

            // Limits checking via localStorage
            const today = new Date().toDateString();
            let dailyExports = parseInt(localStorage.getItem('daily_exports_count')) || 0;
            let lastExportDate = localStorage.getItem('last_export_date') || "";

            if (lastExportDate !== today) dailyExports = 0; 
            if (dailyExports >= 2 && !checkVIPStatus()) {
                showToast("Daily limit reached! Please upgrade to VIP.", "error");
                openVIPModal();
                return;
            }

            stopPlayback();
            isRecording = true;
            recordedChunks = [];
            
            const toast = document.getElementById('recording-toast');
            const timerLabel = document.getElementById('recording-timer');
            toast.classList.remove('hidden');

            let secondsCounter = 0;
            const recordTimerInterval = setInterval(() => {
                secondsCounter++;
                timerLabel.innerText = \`\${secondsCounter}s\`;
            }, 1000);

            initAudioEngine();
            const canvasStream = canvas.captureStream(30);
            const combinedStream = new MediaStream();
            combinedStream.addTrack(canvasStream.getVideoTracks()[0]);

            if (recordDestination?.stream) {
                const audioTracks = recordDestination.stream.getAudioTracks();
                if (audioTracks.length > 0) combinedStream.addTrack(audioTracks[0]);
            }
            
            mediaRecorder = new MediaRecorder(combinedStream, {
                mimeType: 'video/webm;codecs=vp9',
                videoBitsPerSecond: 3000000 
            });

            mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) recordedChunks.push(event.data);
            };

            mediaRecorder.onstop = () => {
                clearInterval(recordTimerInterval);
                toast.classList.add('hidden');
                
                const blob = new Blob(recordedChunks, { type: 'video/webm' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`AI_Studio_Pro_Short_\${Date.now()}.webm\`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                isRecording = false;

                if (!checkVIPStatus()) {
                    dailyExports++;
                    localStorage.setItem('daily_exports_count', dailyExports);
                    localStorage.setItem('last_export_date', today);
                    showToast(\`Free export \${dailyExports}/2 used today.\`, 'success');
                } else {
                    showToast("Video downloaded with VIP Pro!", 'success');
                }
            };

            mediaRecorder.start();

            const fps = 30;
            const wordsPerSecond = wpm / 60;
            const charactersPerSecond = wordsPerSecond * 5.2;
            const totalDuration = wordsArray.length / wordsPerSecond;
            const totalFrames = Math.ceil(totalDuration * fps);
            let frameCount = 0;

            const musicPlayer = document.getElementById('bg-music-audio');
            const isMusicEnabled = document.getElementById('music-enable').checked;
            if (isMusicEnabled && musicPlayer.src) {
                musicPlayer.currentTime = 0;
                musicPlayer.play().catch(e => console.warn(e));
            }

            function renderNextFrame() {
                if (!isRecording) return;
                if (frameCount <= totalFrames) {
                    playbackTime = frameCount / fps;
                    currentCharIndex = Math.floor(playbackTime * charactersPerSecond);
                    currentWordIndex = Math.floor(playbackTime * wordsPerSecond);
                    updateCanvas();

                    const progressPercentage = Math.min((playbackTime / totalDuration) * 100, 100);
                    document.getElementById('video-progress').style.width = \`\${progressPercentage}%\`;
                    frameCount++;
                    setTimeout(renderNextFrame, 1000 / fps);
                } else {
                    currentWordIndex = wordsArray.length;
                    currentCharIndex = scriptInput.value.length;
                    updateCanvas();
                    setTimeout(() => { mediaRecorder.stop(); }, 800);
                }
            }
            renderNextFrame();
        }
    </script>
</body>
</html>
    `);
});

// Start Server Listen
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Production Server is running on Port: ${PORT}`);
    console.log(`💳 Razorpay Integration Setup Active`);
    console.log(`🤖 Secure Gemini API Proxy Connected`);
    console.log(`=========================================`);
});