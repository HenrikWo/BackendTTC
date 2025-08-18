const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Volume path (Railway volume mount point)
const MODELS_DIR = '/app/models';
const AUDIO_DIR = '/tmp/audio'; // Midlertidig audio lagring

// Sørg for at audio directory finnes
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static audio files
app.use('/audio', express.static(AUDIO_DIR));

// In-memory job storage
const jobs = new Map();

// Get Railway public domain
function getBaseUrl() {
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (publicDomain) {
        return `https://${publicDomain}`;
    }
    return 'https://backendttc-production.up.railway.app';
}

// Install ONNX Runtime hvis det ikke finnes
async function ensureOnnxRuntime() {
    try {
        require('onnxruntime-node');
        console.log('✅ ONNX Runtime allerede installert');
        return true;
    } catch (err) {
        console.log('📦 Installerer ONNX Runtime...');
        
        // Prøv å installere onnxruntime-node dynamisk
        const { exec } = require('child_process');
        return new Promise((resolve) => {
            exec('npm install onnxruntime-node', (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ Kunne ikke installere ONNX Runtime:', error.message);
                    resolve(false);
                } else {
                    console.log('✅ ONNX Runtime installert');
                    resolve(true);
                }
            });
        });
    }
}

// Health check
app.get('/health', (req, res) => {
    let modelInfo = { exists: false, files: [] };
    
    try {
        if (fs.existsSync(MODELS_DIR)) {
            modelInfo.exists = true;
            modelInfo.files = fs.readdirSync(MODELS_DIR);
        }
    } catch (err) {
        modelInfo.error = err.message;
    }
    
    // Check audio directory
    let audioInfo = { exists: false, files: [] };
    try {
        if (fs.existsSync(AUDIO_DIR)) {
            audioInfo.exists = true;
            audioInfo.files = fs.readdirSync(AUDIO_DIR);
        }
    } catch (err) {
        audioInfo.error = err.message;
    }
    
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        base_url: getBaseUrl(),
        models_directory: MODELS_DIR,
        audio_directory: AUDIO_DIR,
        models_info: modelInfo,
        audio_info: audioInfo,
        onnx_support: checkOnnxSupport()
    });
});

function checkOnnxSupport() {
    try {
        require('onnxruntime-node');
        return { available: true };
    } catch (err) {
        return { available: false, error: err.message };
    }
}

// List available models
app.get('/api/models', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json({ 
                message: 'Models directory ikke funnet',
                models: [],
                directory: MODELS_DIR 
            });
        }
        
        const files = fs.readdirSync(MODELS_DIR);
        const modelFiles = files.filter(file => 
            file.endsWith('.onnx') || 
            file.endsWith('.json') || 
            file.endsWith('.bin')
        );
        
        const modelInfo = modelFiles.map(filename => {
            const filePath = path.join(MODELS_DIR, filename);
            const stats = fs.statSync(filePath);
            
            return {
                filename,
                size: Math.round(stats.size / (1024 * 1024) * 100) / 100 + ' MB',
                modified: stats.mtime.toISOString()
            };
        });
        
        res.json({
            models: modelInfo,
            total_files: files.length,
            model_files: modelFiles.length,
            directory: MODELS_DIR,
            onnx_support: checkOnnxSupport()
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not read models directory',
            details: error.message,
            directory: MODELS_DIR
        });
    }
});

// TTS endpoint med ONNX modell
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'default' } = req.body;
    
    console.log('🎤 TTS Request mottatt:', text);
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    if (text.length > 500) {
        return res.status(400).json({ 
            error: 'Text is too long. Maximum 500 characters.',
            length: text.length,
            max: 500
        });
    }
    
    // Sjekk om ONNX modeller er tilgjengelige
    let modelStatus = { available: false, models: [], configs: [] };
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            const onnxModels = files.filter(f => f.endsWith('.onnx'));
            const configFiles = files.filter(f => f.endsWith('.json'));
            
            modelStatus = {
                available: onnxModels.length > 0 && configFiles.length > 0,
                models: onnxModels,
                configs: configFiles,
                total_files: files.length
            };
        }
    } catch (err) {
        console.log('Could not check models:', err.message);
    }
    
    if (!modelStatus.available) {
        return res.status(400).json({ 
            error: 'ONNX models not available',
            models_found: modelStatus.models.length,
            configs_found: modelStatus.configs.length,
            directory: MODELS_DIR,
            suggestion: 'Sjekk at både .onnx og .json filer finnes i models directory'
        });
    }
    
    // Generer unik jobb-ID
    const jobId = 'tts_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Opprett jobb
    const job = {
        id: jobId,
        text: text,
        voice: voice,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        modelStatus: modelStatus,
        ttsProvider: 'ONNX Local Models'
    };
    
    jobs.set(jobId, job);
    
    // Start prosessering (asynkront)
    processOnnxTTS(jobId, text, voice).catch(error => {
        console.error(`TTS processing error for job ${jobId}:`, error);
        const job = jobs.get(jobId);
        if (job) {
            job.status = 'failed';
            job.error = error.message;
        }
    });
    
    res.json({
        message: 'TTS job created successfully',
        jobId: jobId,
        status: job.status,
        modelStatus: modelStatus,
        ttsProvider: 'ONNX Local Models',
        estimated_completion: '10-30 sekunder',
        textLength: text.length,
        maxLength: 500
    });
});

// Job status endpoint
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
});

// ONNX TTS processing function
async function processOnnxTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        job.status = 'processing';
        job.progress = 10;
        
        console.log(`🔄 Processing ONNX TTS for job ${jobId}: "${text}"`);
        
        // Sjekk ONNX Runtime
        const onnxSupport = checkOnnxSupport();
        if (!onnxSupport.available) {
            // Prøv fallback til Google TTS
            console.log('⚠️ ONNX ikke tilgjengelig, bruker Google TTS fallback');
            return await fallbackToGoogleTTS(jobId, text, voice);
        }
        
        job.progress = 20;
        job.status = 'loading_model';
        
        // Last ONNX model
        const ort = require('onnxruntime-node');
        
        // Finn første ONNX modell
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFile = files.find(f => f.endsWith('.onnx'));
        const configFile = files.find(f => f.endsWith('.json'));
        
        if (!onnxFile || !configFile) {
            throw new Error('ONNX model eller config fil ikke funnet');
        }
        
        const modelPath = path.join(MODELS_DIR, onnxFile);
        const configPath = path.join(MODELS_DIR, configFile);
        
        console.log(`📁 Loading ONNX model: ${onnxFile}`);
        console.log(`⚙️ Loading config: ${configFile}`);
        
        // Last config
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log('⚙️ Model config loaded:', Object.keys(config));
        
        job.progress = 40;
        
        // Last ONNX session
        const session = await ort.InferenceSession.create(modelPath);
        console.log('🤖 ONNX session created');
        
        job.progress = 60;
        job.status = 'generating_audio';
        
        // Her må vi implementere text preprocessing og phoneme conversion
        // Dette er modell-spesifikt og avhenger av hvordan din ONNX modell er trent
        
        // For nå, la oss prøve en enkel tilnærming
        const textIds = textToIds(text, config);
        console.log('📝 Text converted to IDs:', textIds.slice(0, 10), '...');
        
        job.progress = 80;
        
        // Kjør inferens
        const inputTensor = new ort.Tensor('int64', new BigInt64Array(textIds.map(id => BigInt(id))), [1, textIds.length]);
        const feeds = { input: inputTensor };
        
        console.log('🧠 Running ONNX inference...');
        const results = await session.run(feeds);
        
        job.progress = 90;
        job.status = 'finalizing';
        
        // Hent audio output (må tilpasses din modell)
        const audioOutput = results.output || results.audio || Object.values(results)[0];
        
        if (!audioOutput) {
            throw new Error('Ingen audio output fra ONNX modell');
        }
        
        console.log('🎵 Audio generated, shape:', audioOutput.dims);
        
        // Konverter til WAV
        const audioFilename = `${jobId}.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        await saveAsWav(audioOutput.data, audioPath, config.sample_rate || 22050);
        
        console.log(`💾 Audio saved: ${audioPath}`);
        
        // Generer URL
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        job.modelUsed = onnxFile;
        
        console.log(`✅ ONNX TTS job ${jobId} completed - Audio URL: ${audioUrl}`);
        
        // Cleanup etter 5 minutter
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                    console.log(`🗑️ Cleaned up audio file: ${audioFilename}`);
                }
                jobs.delete(jobId);
            } catch (err) {
                console.error(`❌ Cleanup error:`, err.message);
            }
        }, 5 * 60 * 1000);
        
    } catch (error) {
        console.error(`❌ ONNX TTS error for job ${jobId}:`, error);
        
        // Prøv fallback til Google TTS
        console.log('🔄 Falling back to Google TTS...');
        return await fallbackToGoogleTTS(jobId, text, voice);
    }
}

// Fallback til Google TTS hvis ONNX feiler
async function fallbackToGoogleTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        job.status = 'generating_audio';
        job.progress = 60;
        job.ttsProvider = 'Google TTS (fallback)';
        
        const audioFilename = `${jobId}.mp3`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=no&client=tw-ob&q=${encodeURIComponent(text)}`;
        
        const response = await fetch(ttsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`TTS API error: ${response.status}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        
        console.log(`✅ Fallback TTS completed: ${audioUrl}`);
        
        // Cleanup
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                jobs.delete(jobId);
            } catch (err) {
                console.error(`❌ Cleanup error:`, err.message);
            }
        }, 5 * 60 * 1000);
        
    } catch (error) {
        console.error(`❌ Fallback TTS failed:`, error);
        job.status = 'failed';
        job.error = `Both ONNX and fallback failed: ${error.message}`;
    }
}

// Enkel text-to-IDs funksjon (må tilpasses din modell)
function textToIds(text, config) {
    // Dette er en placeholder - du må implementere riktig text preprocessing
    // basert på din modells config og vocab
    
    const cleanText = text.toLowerCase()
        .replace(/[.,!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Enkel character-to-ID mapping (må erstattes med riktig vocab)
    const charToId = {
        ' ': 0, 'a': 1, 'b': 2, 'c': 3, 'd': 4, 'e': 5, 'f': 6, 'g': 7, 'h': 8, 'i': 9,
        'j': 10, 'k': 11, 'l': 12, 'm': 13, 'n': 14, 'o': 15, 'p': 16, 'q': 17, 'r': 18,
        's': 19, 't': 20, 'u': 21, 'v': 22, 'w': 23, 'x': 24, 'y': 25, 'z': 26,
        'æ': 27, 'ø': 28, 'å': 29
    };
    
    return cleanText.split('').map(char => charToId[char] || 0);
}

// Enkel WAV fil saver
async function saveAsWav(audioData, outputPath, sampleRate = 22050) {
    // Konverter Float32Array til 16-bit PCM
    const audioArray = Array.from(audioData);
    const buffer = Buffer.alloc(44 + audioArray.length * 2);
    
    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + audioArray.length * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(audioArray.length * 2, 40);
    
    // Audio data
    for (let i = 0; i < audioArray.length; i++) {
        const sample = Math.max(-1, Math.min(1, audioArray[i]));
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }
    
    fs.writeFileSync(outputPath, buffer);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Install ONNX Runtime endpoint
app.post('/api/install-onnx', async (req, res) => {
    try {
        const success = await ensureOnnxRuntime();
        if (success) {
            res.json({ 
                message: 'ONNX Runtime installed successfully',
                status: 'ready'
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to install ONNX Runtime',
                suggestion: 'Restart the application or check logs'
            });
        }
    } catch (error) {
        res.status(500).json({ 
            error: 'Installation failed',
            details: error.message
        });
    }
});

// Clean up old jobs every hour
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    
    for (const [jobId, job] of jobs.entries()) {
        if (new Date(job.createdAt).getTime() < oneHourAgo) {
            if (job.audioPath && fs.existsSync(job.audioPath)) {
                try {
                    fs.unlinkSync(job.audioPath);
                    console.log(`🗑️ Cleaned up old audio file: ${job.audioPath}`);
                } catch (err) {
                    console.error(`❌ Could not delete old audio file:`, err.message);
                }
            }
            jobs.delete(jobId);
            console.log(`🧹 Cleaned up old job: ${jobId}`);
        }
    }
}, 60 * 60 * 1000);

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Railway ONNX TTS Backend running on port ${PORT}`);
    console.log(`📁 Models directory: ${MODELS_DIR}`);
    console.log(`🎵 Audio directory: ${AUDIO_DIR}`);
    console.log(`🔗 Base URL: ${getBaseUrl()}`);
    
    // Sjekk ONNX support ved oppstart
    const onnxSupport = checkOnnxSupport();
    if (onnxSupport.available) {
        console.log('✅ ONNX Runtime tilgjengelig');
    } else {
        console.log('⚠️ ONNX Runtime ikke tilgjengelig, prøver å installere...');
        const installed = await ensureOnnxRuntime();
        if (installed) {
            console.log('✅ ONNX Runtime installert');
        } else {
            console.log('❌ ONNX Runtime installasjon feilet - bruker Google TTS fallback');
        }
    }
    
    // Sjekk modeller
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            console.log(`📦 Found ${files.length} files in models directory:`, files);
            
            const onnxModels = files.filter(f => f.endsWith('.onnx'));
            const configs = files.filter(f => f.endsWith('.json'));
            
            if (onnxModels.length > 0 && configs.length > 0) {
                console.log(`🤖 ONNX TTS Ready! Models: ${onnxModels}, Configs: ${configs}`);
            } else {
                console.log(`📋 Incomplete models. Found: ${onnxModels.length} ONNX, ${configs.length} JSON`);
            }
        } else {
            console.log(`📁 Models directory not found: ${MODELS_DIR}`);
        }
    } catch (err) {
        console.log(`❌ Could not access models directory:`, err.message);
    }
});