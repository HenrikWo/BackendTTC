// Add this to your package.json dependencies:
// "onnxruntime-node": "^1.16.0"

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Volume path (Railway volume mount point)
const MODELS_DIR = '/app/models';
const AUDIO_DIR = '/tmp/audio';

// Sørg for at audio directory finnes
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/audio', express.static(AUDIO_DIR));

const jobs = new Map();

function getBaseUrl() {
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (publicDomain) {
        return `https://${publicDomain}`;
    }
    return 'https://backendttc-production.up.railway.app';
}

function checkOnnxSupport() {
    try {
        require('onnxruntime-node');
        return { available: true, version: require('onnxruntime-node/package.json').version };
    } catch (err) {
        return { available: false, error: err.message };
    }
}

// Health check med omfattende debugging
app.get('/health', (req, res) => {
    let modelInfo = { exists: false, files: [] };
    
    try {
        if (fs.existsSync(MODELS_DIR)) {
            modelInfo.exists = true;
            modelInfo.files = fs.readdirSync(MODELS_DIR);
            
            // Detaljert info om hver fil
            modelInfo.detailed = modelInfo.files.map(filename => {
                const filePath = path.join(MODELS_DIR, filename);
                const stats = fs.statSync(filePath);
                return {
                    filename,
                    size: Math.round(stats.size / (1024 * 1024) * 100) / 100 + ' MB',
                    sizeMB: Math.round(stats.size / (1024 * 1024) * 100) / 100,
                    modified: stats.mtime.toISOString(),
                    extension: path.extname(filename),
                    readable: fs.access ? 'checking...' : 'unknown'
                };
            });
        }
    } catch (err) {
        modelInfo.error = err.message;
    }
    
    const onnxSupport = checkOnnxSupport();
    
    // Sjekk om vi kan faktisk lese ONNX filen
    let onnxLoadTest = { canLoad: false };
    if (onnxSupport.available && modelInfo.exists) {
        try {
            const onnxFiles = modelInfo.files.filter(f => f.endsWith('.onnx'));
            if (onnxFiles.length > 0) {
                const ort = require('onnxruntime-node');
                const modelPath = path.join(MODELS_DIR, onnxFiles[0]);
                onnxLoadTest = {
                    canLoad: true,
                    modelPath: modelPath,
                    fileExists: fs.existsSync(modelPath),
                    fileSize: fs.existsSync(modelPath) ? fs.statSync(modelPath).size : 0
                };
            }
        } catch (err) {
            onnxLoadTest = { canLoad: false, error: err.message };
        }
    }
    
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        base_url: getBaseUrl(),
        models_directory: MODELS_DIR,
        audio_directory: AUDIO_DIR,
        models_info: modelInfo,
        onnx_support: onnxSupport,
        onnx_load_test: onnxLoadTest,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch
    });
});

// Debug endpoint for model analysis
app.get('/api/debug/models', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json({ error: 'Models directory not found' });
        }
        
        const files = fs.readdirSync(MODELS_DIR);
        const analysis = {};
        
        files.forEach(filename => {
            const filePath = path.join(MODELS_DIR, filename);
            const stats = fs.statSync(filePath);
            
            analysis[filename] = {
                size: stats.size,
                sizeMB: Math.round(stats.size / (1024 * 1024) * 100) / 100,
                isFile: stats.isFile(),
                modified: stats.mtime.toISOString()
            };
            
            // For JSON filer, prøv å lese innholdet
            if (filename.endsWith('.json')) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const parsed = JSON.parse(content);
                    analysis[filename].jsonContent = {
                        keys: Object.keys(parsed),
                        hasVocab: 'vocab' in parsed || 'vocabulary' in parsed,
                        hasSampleRate: 'sample_rate' in parsed || 'sampling_rate' in parsed,
                        preview: JSON.stringify(parsed).substring(0, 500) + '...'
                    };
                } catch (err) {
                    analysis[filename].jsonError = err.message;
                }
            }
        });
        
        res.json({
            directory: MODELS_DIR,
            files_count: files.length,
            analysis: analysis,
            onnx_support: checkOnnxSupport()
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// TTS endpoint med forbedret debugging
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'default', debug = false } = req.body;
    
    console.log('🎤 TTS Request:', { text, voice, debug });
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    // Sjekk ONNX tilgjengelighet
    const onnxSupport = checkOnnxSupport();
    console.log('🔍 ONNX Support:', onnxSupport);
    
    // Sjekk modeller
    let modelStatus = { available: false, models: [], configs: [], details: {} };
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            const onnxModels = files.filter(f => f.endsWith('.onnx'));
            const configFiles = files.filter(f => f.endsWith('.json'));
            
            modelStatus = {
                available: onnxModels.length > 0 && configFiles.length > 0,
                models: onnxModels,
                configs: configFiles,
                total_files: files.length,
                details: {
                    onnxCount: onnxModels.length,
                    configCount: configFiles.length,
                    allFiles: files
                }
            };
        }
    } catch (err) {
        console.log('❌ Model check error:', err.message);
        modelStatus.error = err.message;
    }
    
    console.log('📂 Model Status:', modelStatus);
    
    const jobId = 'tts_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const job = {
        id: jobId,
        text: text,
        voice: voice,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        modelStatus: modelStatus,
        onnxSupport: onnxSupport,
        debug: debug,
        ttsProvider: 'Determining...'
    };
    
    jobs.set(jobId, job);
    
    // Bestem TTS provider basert på tilgjengelighet
    let useOnnx = onnxSupport.available && modelStatus.available;
    
    console.log(`🎯 TTS Decision: useOnnx=${useOnnx}, onnxAvailable=${onnxSupport.available}, modelsAvailable=${modelStatus.available}`);
    
    if (useOnnx) {
        console.log('🤖 Starting ONNX TTS processing...');
        processOnnxTTS(jobId, text, voice).catch(error => {
            console.error(`❌ ONNX TTS failed, falling back:`, error);
            fallbackToGoogleTTS(jobId, text, voice);
        });
    } else {
        console.log('🌐 Starting Google TTS fallback...');
        job.ttsProvider = 'Google TTS (primary)';
        fallbackToGoogleTTS(jobId, text, voice);
    }
    
    res.json({
        message: 'TTS job created',
        jobId: jobId,
        status: job.status,
        provider_decision: {
            will_use_onnx: useOnnx,
            onnx_available: onnxSupport.available,
            models_available: modelStatus.available,
            fallback_reason: !useOnnx ? (
                !onnxSupport.available ? 'ONNX Runtime not available' :
                !modelStatus.available ? 'ONNX models not found' : 'Unknown'
            ) : null
        },
        modelStatus: modelStatus,
        onnxSupport: onnxSupport,
        estimated_completion: '10-30 sekunder'
    });
});

// ONNX TTS processing med omfattende logging
async function processOnnxTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🤖 [${jobId}] Starting ONNX TTS processing`);
        
        job.status = 'processing';
        job.progress = 10;
        job.ttsProvider = 'ONNX Local Models (attempting)';
        
        // Last ONNX Runtime
        const ort = require('onnxruntime-node');
        console.log(`📦 [${jobId}] ONNX Runtime loaded, version:`, ort.version || 'unknown');
        
        job.progress = 20;
        job.status = 'loading_model';
        
        // Finn modell filer
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFile = files.find(f => f.endsWith('.onnx'));
        const configFile = files.find(f => f.endsWith('.json'));
        
        console.log(`📁 [${jobId}] Found files:`, { onnxFile, configFile, allFiles: files });
        
        if (!onnxFile) {
            throw new Error('No .onnx file found in models directory');
        }
        
        const modelPath = path.join(MODELS_DIR, onnxFile);
        console.log(`📂 [${jobId}] Model path: ${modelPath}`);
        console.log(`📏 [${jobId}] Model size: ${fs.statSync(modelPath).size} bytes`);
        
        // Last config hvis tilgjengelig
        let config = {};
        if (configFile) {
            const configPath = path.join(MODELS_DIR, configFile);
            const configContent = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(configContent);
            console.log(`⚙️ [${jobId}] Config loaded:`, Object.keys(config));
        }
        
        job.progress = 40;
        
        // Last ONNX session
        console.log(`🧠 [${jobId}] Creating ONNX inference session...`);
        const session = await ort.InferenceSession.create(modelPath);
        console.log(`✅ [${jobId}] ONNX session created successfully`);
        
        // Log model input/output info
        console.log(`📊 [${jobId}] Model inputs:`, session.inputNames);
        console.log(`📊 [${jobId}] Model outputs:`, session.outputNames);
        
        job.progress = 60;
        job.status = 'generating_audio';
        
        // Enkel text preprocessing (må tilpasses din modell)
        const textIds = simpleTextToIds(text);
        console.log(`📝 [${jobId}] Text preprocessing:`, { 
            originalText: text, 
            textLength: text.length,
            idsLength: textIds.length,
            firstIds: textIds.slice(0, 10)
        });
        
        job.progress = 80;
        
        // Prøv inferens med forskjellige input formats
        let results;
        const inputName = session.inputNames[0]; // Bruk første input navn
        
        try {
            // Prøv først med int64
            console.log(`🧠 [${jobId}] Attempting inference with input: ${inputName}`);
            const inputTensor = new ort.Tensor('int64', new BigInt64Array(textIds.map(id => BigInt(id))), [1, textIds.length]);
            const feeds = { [inputName]: inputTensor };
            
            console.log(`🔄 [${jobId}] Running ONNX inference...`);
            results = await session.run(feeds);
            console.log(`✅ [${jobId}] ONNX inference completed`);
            
        } catch (error) {
            console.log(`⚠️ [${jobId}] Int64 inference failed, trying float32:`, error.message);
            
            // Prøv med float32
            const inputTensor = new ort.Tensor('float32', new Float32Array(textIds), [1, textIds.length]);
            const feeds = { [inputName]: inputTensor };
            results = await session.run(feeds);
            console.log(`✅ [${jobId}] Float32 inference succeeded`);
        }
        
        job.progress = 90;
        job.status = 'finalizing';
        
        // Hent audio output
        console.log(`📊 [${jobId}] Output keys:`, Object.keys(results));
        const outputName = session.outputNames[0];
        const audioOutput = results[outputName] || Object.values(results)[0];
        
        if (!audioOutput) {
            throw new Error(`No audio output found. Available outputs: ${Object.keys(results)}`);
        }
        
        console.log(`🎵 [${jobId}] Audio output shape:`, audioOutput.dims);
        console.log(`🎵 [${jobId}] Audio data type:`, audioOutput.type);
        console.log(`🎵 [${jobId}] Audio data length:`, audioOutput.data.length);
        
        // Generer WAV fil
        const audioFilename = `${jobId}_onnx.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        await saveAsWav(audioOutput.data, audioPath, config.sample_rate || 22050);
        console.log(`💾 [${jobId}] WAV file saved: ${audioPath}`);
        
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        job.modelUsed = onnxFile;
        job.ttsProvider = 'ONNX Local Models (success)';
        
        console.log(`🎉 [${jobId}] ONNX TTS completed successfully: ${audioUrl}`);
        
        // Cleanup etter 5 minutter
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                    console.log(`🗑️ [${jobId}] Cleaned up: ${audioFilename}`);
                }
                jobs.delete(jobId);
            } catch (err) {
                console.error(`❌ [${jobId}] Cleanup error:`, err.message);
            }
        }, 5 * 60 * 1000);
        
    } catch (error) {
        console.error(`❌ [${jobId}] ONNX TTS failed:`, error);
        throw error; // Re-throw for fallback handling
    }
}

// Fallback til Google TTS
async function fallbackToGoogleTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🌐 [${jobId}] Starting Google TTS fallback`);
        
        job.status = 'generating_audio';
        job.progress = 60;
        job.ttsProvider = 'Google TTS (fallback)';
        
        const audioFilename = `${jobId}_google.mp3`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=no&client=tw-ob&q=${encodeURIComponent(text)}`;
        console.log(`🔗 [${jobId}] Google TTS URL: ${ttsUrl}`);
        
        const response = await fetch(ttsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Google TTS API error: ${response.status} ${response.statusText}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        
        console.log(`💾 [${jobId}] Google TTS audio saved: ${audioPath} (${audioBuffer.byteLength} bytes)`);
        
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        
        console.log(`✅ [${jobId}] Google TTS completed: ${audioUrl}`);
        
        // Cleanup
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                jobs.delete(jobId);
            } catch (err) {
                console.error(`❌ [${jobId}] Cleanup error:`, err.message);
            }
        }, 5 * 60 * 1000);
        
    } catch (error) {
        console.error(`❌ [${jobId}] Google TTS failed:`, error);
        job.status = 'failed';
        job.error = `TTS failed: ${error.message}`;
    }
}

// Enkel text-to-IDs
function simpleTextToIds(text) {
    const cleanText = text.toLowerCase()
        .replace(/[.,!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const charToId = {
        ' ': 0, 'a': 1, 'b': 2, 'c': 3, 'd': 4, 'e': 5, 'f': 6, 'g': 7, 'h': 8, 'i': 9,
        'j': 10, 'k': 11, 'l': 12, 'm': 13, 'n': 14, 'o': 15, 'p': 16, 'q': 17, 'r': 18,
        's': 19, 't': 20, 'u': 21, 'v': 22, 'w': 23, 'x': 24, 'y': 25, 'z': 26,
        'æ': 27, 'ø': 28, 'å': 29
    };
    
    return cleanText.split('').map(char => charToId[char] || 0);
}

// WAV fil lagring
async function saveAsWav(audioData, outputPath, sampleRate = 22050) {
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
    
    // Audio data (normalize og konverter til 16-bit)
    for (let i = 0; i < audioArray.length; i++) {
        const sample = Math.max(-1, Math.min(1, audioArray[i]));
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }
    
    fs.writeFileSync(outputPath, buffer);
}

// Job status endpoint
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Railway ONNX TTS Backend (Debug) running on port ${PORT}`);
    console.log(`🔗 Health: ${getBaseUrl()}/health`);
    console.log(`🔍 Debug: ${getBaseUrl()}/api/debug/models`);
    
    // Startup checks
    const onnxSupport = checkOnnxSupport();
    console.log('🔍 ONNX Support:', onnxSupport);
    
    if (fs.existsSync(MODELS_DIR)) {
        const files = fs.readdirSync(MODELS_DIR);
        console.log(`📦 Models directory: ${files.length} files`, files);
    } else {
        console.log(`❌ Models directory not found: ${MODELS_DIR}`);
    }
});