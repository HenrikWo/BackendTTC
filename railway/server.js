const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Volume path (Railway volume mount point)
const MODELS_DIR = '/app/models';
const AUDIO_DIR = '/tmp/audio';

// Global ONNX status
let onnxInstalled = false;
let onnxRuntime = null;

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

// Dynamic ONNX Runtime installation
async function installOnnxRuntime() {
    if (onnxInstalled && onnxRuntime) {
        return { success: true, message: 'Already installed' };
    }

    try {
        console.log('📦 Installing ONNX Runtime...');
        
        try {
            onnxRuntime = require('onnxruntime-node');
            onnxInstalled = true;
            console.log('✅ ONNX Runtime already available');
            return { success: true, message: 'Already available' };
        } catch (err) {
            console.log('⚠️ ONNX Runtime not found, installing...');
        }

        const { stdout, stderr } = await execAsync('npm install onnxruntime-node@1.14.0 --no-save');
        
        console.log('📦 NPM install output:', stdout);
        if (stderr) console.log('⚠️ NPM install warnings:', stderr);

        delete require.cache[require.resolve('onnxruntime-node')];
        onnxRuntime = require('onnxruntime-node');
        onnxInstalled = true;

        console.log('✅ ONNX Runtime installed successfully');
        return { success: true, message: 'Installed successfully' };

    } catch (error) {
        console.error('❌ ONNX Runtime installation failed:', error.message);
        return { success: false, error: error.message };
    }
}

function checkOnnxSupport() {
    if (onnxInstalled && onnxRuntime) {
        return { available: true, installed: true };
    }
    
    try {
        onnxRuntime = require('onnxruntime-node');
        onnxInstalled = true;
        return { available: true, installed: true };
    } catch (err) {
        return { available: false, error: err.message, installed: false };
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
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        base_url: getBaseUrl(),
        models_directory: MODELS_DIR,
        audio_directory: AUDIO_DIR,
        models_info: modelInfo,
        audio_info: audioInfo,
        onnx_support: checkOnnxSupport()
    });
});

// TTS endpoint
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'default' } = req.body;
    
    console.log('🎤 TTS Request:', text);
    
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
    
    // Sjekk ONNX tilgjengelighet
    const onnxSupport = checkOnnxSupport();
    console.log('🔍 ONNX Support:', onnxSupport);
    
    // Prøv å installere ONNX hvis ikke tilgjengelig
    if (!onnxSupport.available) {
        console.log('📦 Auto-installing ONNX Runtime...');
        const installResult = await installOnnxRuntime();
        console.log('📦 Install result:', installResult);
    }
    
    // Sjekk modeller
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
        console.log('❌ Model check error:', err.message);
    }
    
    const jobId = 'tts_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const job = {
        id: jobId,
        text: text,
        voice: voice,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        modelStatus: modelStatus,
        onnxSupport: checkOnnxSupport()
    };
    
    jobs.set(jobId, job);
    
    // Bestem provider
    const finalOnnxCheck = checkOnnxSupport();
    const useOnnx = finalOnnxCheck.available && modelStatus.available;
    
    console.log(`🎯 TTS Decision: useOnnx=${useOnnx}`);
    
    if (useOnnx) {
        console.log('🤖 Starting ONNX TTS...');
        job.ttsProvider = 'ONNX Local Models';
        processOnnxTTS(jobId, text, voice).catch(error => {
            console.error(`❌ ONNX failed:`, error);
            fallbackToGoogleTTS(jobId, text, voice);
        });
    } else {
        console.log('🌐 Using Google TTS fallback');
        job.ttsProvider = 'Google TTS (fallback)';
        fallbackToGoogleTTS(jobId, text, voice);
    }
    
    res.json({
        message: 'TTS job created',
        jobId: jobId,
        status: job.status,
        provider_decision: {
            will_use_onnx: useOnnx,
            onnx_available: finalOnnxCheck.available,
            models_available: modelStatus.available
        },
        estimated_completion: '10-30 sekunder'
    });
});

// ONNX TTS processing with FIXED inputs for Piper model
async function processOnnxTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🤖 [${jobId}] Starting ONNX TTS`);
        
        job.status = 'processing';
        job.progress = 10;
        
        if (!onnxRuntime) {
            throw new Error('ONNX Runtime not available');
        }
        
        job.progress = 20;
        job.status = 'loading_model';
        
        // Load model files
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFile = files.find(f => f.endsWith('.onnx'));
        const configFile = files.find(f => f.endsWith('.json'));
        
        console.log(`📁 [${jobId}] Model files:`, { onnxFile, configFile });
        
        if (!onnxFile) {
            throw new Error('No .onnx file found');
        }
        
        const modelPath = path.join(MODELS_DIR, onnxFile);
        console.log(`📂 [${jobId}] Loading: ${modelPath}`);
        
        // Load config
        let config = {};
        if (configFile) {
            const configPath = path.join(MODELS_DIR, configFile);
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log(`⚙️ [${jobId}] Config keys:`, Object.keys(config));
        }
        
        job.progress = 40;
        
        // Create ONNX session
        console.log(`🧠 [${jobId}] Creating ONNX session...`);
        const session = await onnxRuntime.InferenceSession.create(modelPath);
        console.log(`✅ [${jobId}] Session created`);
        
        console.log(`📊 [${jobId}] Inputs:`, session.inputNames);
        console.log(`📊 [${jobId}] Outputs:`, session.outputNames);
        
        job.progress = 60;
        job.status = 'generating_audio';
        
        // Convert text to phoneme IDs using improved method
        const textIds = convertTextToPiperIds(text, config);
        console.log(`📝 [${jobId}] Text -> IDs:`, textIds.slice(0, 10), '...');
        console.log(`📏 [${jobId}] Text length: ${text.length}, IDs length: ${textIds.length}`);
        
        job.progress = 80;
        
        // Create all required inputs for Piper TTS model
        console.log(`🧠 [${jobId}] Running inference with Piper inputs...`);
        
        const inputTensor = new onnxRuntime.Tensor('int64', 
            new BigInt64Array(textIds.map(id => BigInt(id))), 
            [1, textIds.length]);
        
        const inputLengthsTensor = new onnxRuntime.Tensor('int64', 
            new BigInt64Array([BigInt(textIds.length)]), 
            [1]);
        
        const scalesTensor = new onnxRuntime.Tensor('float32', 
            new Float32Array([0.667, 1.0, 0.8]), 
            [3]);
        
        const feeds = { 
            'input': inputTensor,
            'input_lengths': inputLengthsTensor, 
            'scales': scalesTensor
        };
        
        console.log(`📊 [${jobId}] Input shapes:`, {
            input: inputTensor.dims,
            input_lengths: inputLengthsTensor.dims,
            scales: scalesTensor.dims
        });
        
        const results = await session.run(feeds);
        console.log(`✅ [${jobId}] ONNX inference completed`);
        
        job.progress = 90;
        job.status = 'finalizing';
        
        // Get audio output
        const audioOutput = results['output'] || Object.values(results)[0];
        
        if (!audioOutput) {
            throw new Error(`No audio output found. Available outputs: ${Object.keys(results)}`);
        }
        
        console.log(`🎵 [${jobId}] Audio shape:`, audioOutput.dims);
        console.log(`🎵 [${jobId}] Audio data type:`, audioOutput.type);
        console.log(`🎵 [${jobId}] Audio data length:`, audioOutput.data.length);
        
        // ENHANCED AUDIO DEBUGGING
        const audioArray = Array.from(audioOutput.data);
        const nonZeroSamples = audioArray.filter(x => Math.abs(x) > 0.001).length;
        const minVal = Math.min(...audioArray);
        const maxVal = Math.max(...audioArray);
        const avgVal = audioArray.reduce((a, b) => a + b, 0) / audioArray.length;
        
        console.log(`🔊 [${jobId}] Audio stats:`, {
            nonZeroSamples: nonZeroSamples,
            totalSamples: audioArray.length,
            range: `${minVal.toFixed(4)} to ${maxVal.toFixed(4)}`,
            average: avgVal.toFixed(4),
            percentNonZero: Math.round(nonZeroSamples / audioArray.length * 100) + '%'
        });
        
        // Handle multi-dimensional audio output
        let flatAudioData = audioArray;
        if (audioOutput.dims.length > 1) {
            console.log(`📐 [${jobId}] Flattening multi-dimensional audio from shape:`, audioOutput.dims);
            const samplesCount = audioOutput.dims[audioOutput.dims.length - 1];
            flatAudioData = audioArray.slice(-samplesCount);
            console.log(`📐 [${jobId}] Flattened to ${flatAudioData.length} samples`);
        }
        
        // Save as WAV
        const audioFilename = `${jobId}_onnx.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        await saveAsWav(flatAudioData, audioPath, config.audio?.sample_rate || 22050);
        
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
        
        // Cleanup
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                    console.log(`🗑️ [${jobId}] Cleaned up`);
                }
                jobs.delete(jobId);
            } catch (err) {
                console.error(`❌ [${jobId}] Cleanup error:`, err.message);
            }
        }, 5 * 60 * 1000);
        
    } catch (error) {
        console.error(`❌ [${jobId}] ONNX TTS failed:`, error);
        throw error;
    }
}

// Google TTS fallback
async function fallbackToGoogleTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🌐 [${jobId}] Google TTS fallback`);
        
        job.status = 'generating_audio';
        job.progress = 60;
        job.ttsProvider = 'Google TTS (fallback)';
        
        const audioFilename = `${jobId}_google.mp3`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=no&client=tw-ob&q=${encodeURIComponent(text)}`;
        
        const response = await fetch(ttsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Google TTS error: ${response.status}`);
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

// Improved text to Piper phoneme IDs conversion
function convertTextToPiperIds(text, config) {
    console.log(`📝 Converting text: "${text}"`);
    
    if (config.phoneme_id_map) {
        console.log('📋 Using phoneme mapping from config, available phonemes:', Object.keys(config.phoneme_id_map).length);
        return convertUsingPhonemeMap(text, config);
    }
    
    console.log('⚠️ No phoneme map found, using simple character mapping');
    return convertUsingSimpleMapping(text);
}

function convertUsingPhonemeMap(text, config) {
    const cleanText = text.toLowerCase()
        .replace(/[.,!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const phonemeMap = config.phoneme_id_map;
    
    // DEBUG: Log more phoneme mappings - look for letters
    console.log('🔍 Available phonemes (first 50):');
    const phonemeKeys = Object.keys(phonemeMap).slice(0, 50);
    for (let key of phonemeKeys) {
        console.log(`  "${key}" -> ${phonemeMap[key]}`);
    }
    
    // Look for Norwegian-specific phonemes
    const letterPhonemes = Object.keys(phonemeMap).filter(k => 
        k.length === 1 && /[a-zæøå]/.test(k)
    );
    console.log('🔤 Letter phonemes found:', letterPhonemes.slice(0, 20));
    
    // Look for common English phonemes  
    const commonPhonemes = Object.keys(phonemeMap).filter(k => 
        ['t', 'e', 's', 'a', 'i', 'n', 'o', 'r'].includes(k.toLowerCase())
    );
    console.log('📝 Common letter phonemes:', commonPhonemes);
    
    const ids = [];
    
    for (let char of cleanText) {
        if (char === ' ') {
            if (phonemeMap['_'] !== undefined) {
                ids.push(phonemeMap['_']);
            } else if (phonemeMap[' '] !== undefined) {
                ids.push(phonemeMap[' ']);
            } else if (phonemeMap['SIL'] !== undefined) {
                ids.push(phonemeMap['SIL']);
            } else if (phonemeMap['sil'] !== undefined) {
                ids.push(phonemeMap['sil']);
            } else {
                ids.push(0);
            }
        } else {
            let foundId = null;
            
            if (phonemeMap[char] !== undefined) {
                foundId = phonemeMap[char];
            } else if (phonemeMap[char.toUpperCase()] !== undefined) {
                foundId = phonemeMap[char.toUpperCase()];
            }
            
            if (foundId !== null) {
                ids.push(foundId);
                console.log(`✅ "${char}" -> ${foundId}`);
            } else {
                console.log(`❌ Unknown character: "${char}"`);
                ids.push(phonemeMap['_'] || phonemeMap['SIL'] || phonemeMap['sil'] || 0);
            }
        }
    }
    
    console.log(`📝 Phoneme conversion: "${cleanText}" -> [${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''}] (${ids.length} phonemes)`);
    
    return ids;
}

function convertUsingSimpleMapping(text) {
    const cleanText = text.toLowerCase()
        .replace(/[.,!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const charToPhonemeId = {
        ' ': 0,
        'a': 1, 'b': 2, 'c': 3, 'd': 4, 'e': 5, 'f': 6, 'g': 7, 'h': 8,
        'i': 9, 'j': 10, 'k': 11, 'l': 12, 'm': 13, 'n': 14, 'o': 15, 'p': 16,
        'q': 17, 'r': 18, 's': 19, 't': 20, 'u': 21, 'v': 22, 'w': 23, 'x': 24,
        'y': 25, 'z': 26,
        'æ': 27, 'ø': 28, 'å': 29
    };
    
    const ids = cleanText.split('').map(char => charToPhonemeId[char] || 0);
    
    console.log(`📝 Simple conversion: "${cleanText}" -> [${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''}] (${ids.length} IDs)`);
    
    return ids;
}

// WAV file saver
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
    
    for (let i = 0; i < audioArray.length; i++) {
        const sample = Math.max(-1, Math.min(1, audioArray[i]));
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }
    
    fs.writeFileSync(outputPath, buffer);
    console.log(`💾 WAV file saved: ${outputPath} (${Math.round(audioArray.length / sampleRate * 100) / 100}s, ${sampleRate}Hz)`);
}

// Job status
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
});

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Railway ONNX TTS Backend running on port ${PORT}`);
    console.log(`🔗 Health: ${getBaseUrl()}/health`);
    
    // Try auto-install on startup
    console.log('🔍 Checking ONNX Runtime...');
    const installResult = await installOnnxRuntime();
    console.log('📦 Startup ONNX install:', installResult);
    
    // Check models
    if (fs.existsSync(MODELS_DIR)) {
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFiles = files.filter(f => f.endsWith('.onnx'));
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        console.log(`📦 ONNX Models:`, onnxFiles);
        console.log(`⚙️ Config Files:`, jsonFiles);
        
        if (onnxFiles.length > 0 && jsonFiles.length > 0) {
            console.log(`🎯 Ready for ONNX TTS with Norwegian model!`);
        }
    }
});