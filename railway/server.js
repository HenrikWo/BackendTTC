const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Paths
const MODELS_DIR = '/app/models';
const AUDIO_DIR = '/tmp/audio';
const PIPER_DIR = '/tmp/piper';

// Global status
let piperInstalled = false;
let piperPath = null;

// Setup directories
[AUDIO_DIR, PIPER_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

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

// Install Piper CLI
async function installPiper() {
    if (piperInstalled && piperPath && fs.existsSync(piperPath)) {
        return { success: true, message: 'Already installed' };
    }

    try {
        console.log('📦 Installing Piper CLI...');
        
        // Download Piper for Linux
        const piperUrl = 'https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_linux_x86_64.tar.gz';
        const downloadPath = '/tmp/piper.tar.gz';
        
        console.log('⬇️ Downloading Piper...');
        await execAsync(`wget -O ${downloadPath} ${piperUrl}`);
        
        console.log('📦 Extracting Piper...');
        await execAsync(`tar -xzf ${downloadPath} -C ${PIPER_DIR}`);
        
        // Find piper executable
        const { stdout } = await execAsync(`find ${PIPER_DIR} -name "piper" -type f`);
        piperPath = stdout.trim();
        
        if (!piperPath || !fs.existsSync(piperPath)) {
            throw new Error('Piper executable not found after extraction');
        }
        
        // Make executable
        await execAsync(`chmod +x ${piperPath}`);
        
        console.log('✅ Piper installed at:', piperPath);
        piperInstalled = true;
        
        return { success: true, message: 'Installed successfully', path: piperPath };

    } catch (error) {
        console.error('❌ Piper installation failed:', error.message);
        return { success: false, error: error.message };
    }
}

function checkPiperStatus() {
    return {
        installed: piperInstalled,
        path: piperPath,
        available: piperInstalled && piperPath && fs.existsSync(piperPath)
    };
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
        piper_directory: PIPER_DIR,
        models_info: modelInfo,
        audio_info: audioInfo,
        piper_status: checkPiperStatus()
    });
});

// Install Piper endpoint
app.post('/api/install-piper', async (req, res) => {
    try {
        const result = await installPiper();
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// TTS endpoint using Piper CLI
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'default' } = req.body;
    
    console.log('🎤 TTS Request:', text);
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length > 1000) {
        return res.status(400).json({ 
            error: 'Text is too long. Maximum 1000 characters.',
            length: text.length,
            max: 1000
        });
    }
    
    // Check Piper availability
    const piperStatus = checkPiperStatus();
    console.log('🔍 Piper Status:', piperStatus);
    
    // Auto-install Piper if needed
    if (!piperStatus.available) {
        console.log('📦 Auto-installing Piper CLI...');
        const installResult = await installPiper();
        console.log('📦 Install result:', installResult);
        
        if (!installResult.success) {
            console.log('🌐 Falling back to Google TTS...');
            return await fallbackToGoogleTTS(res, text);
        }
    }
    
    // Check models
    let modelStatus = { available: false, models: [] };
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            const onnxModels = files.filter(f => f.endsWith('.onnx'));
            
            modelStatus = {
                available: onnxModels.length > 0,
                models: onnxModels,
                total_files: files.length
            };
        }
    } catch (err) {
        console.log('❌ Model check error:', err.message);
    }
    
    if (!modelStatus.available) {
        console.log('🌐 No models found, falling back to Google TTS...');
        return await fallbackToGoogleTTS(res, text);
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
        piperStatus: checkPiperStatus(),
        ttsProvider: 'Piper CLI'
    };
    
    jobs.set(jobId, job);
    
    // Start Piper TTS processing
    console.log('🤖 Starting Piper CLI TTS...');
    processPiperTTS(jobId, text, voice).catch(error => {
        console.error(`❌ Piper failed:`, error);
        fallbackJobToGoogle(jobId, text, voice);
    });
    
    res.json({
        message: 'TTS job created',
        jobId: jobId,
        status: job.status,
        provider_decision: {
            will_use_piper: true,
            piper_available: piperStatus.available,
            models_available: modelStatus.available
        },
        estimated_completion: '5-15 sekunder'
    });
});

// Piper CLI TTS processing
async function processPiperTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🤖 [${jobId}] Starting Piper CLI TTS`);
        
        job.status = 'processing';
        job.progress = 10;
        
        if (!piperPath || !fs.existsSync(piperPath)) {
            throw new Error('Piper CLI not available');
        }
        
        job.progress = 20;
        job.status = 'loading_model';
        
        // Find model file
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFile = files.find(f => f.endsWith('.onnx'));
        
        if (!onnxFile) {
            throw new Error('No .onnx model file found');
        }
        
        const modelPath = path.join(MODELS_DIR, onnxFile);
        console.log(`📂 [${jobId}] Using model: ${modelPath}`);
        
        job.progress = 40;
        job.status = 'generating_audio';
        
        // Generate output file
        const audioFilename = `${jobId}_piper.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        console.log(`🗣️ [${jobId}] Running Piper CLI...`);
        console.log(`📝 [${jobId}] Text: "${text}"`);
        
        // Run Piper CLI
        const piperProcess = spawn(piperPath, [
            '--model', modelPath,
            '--output-file', audioPath
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // Send text to stdin
        piperProcess.stdin.write(text);
        piperProcess.stdin.end();
        
        let stdout = '';
        let stderr = '';
        
        piperProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        piperProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        // Wait for process to complete
        await new Promise((resolve, reject) => {
            piperProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Piper process exited with code ${code}. stderr: ${stderr}`));
                }
            });
            
            piperProcess.on('error', reject);
        });
        
        job.progress = 90;
        job.status = 'finalizing';
        
        // Check if file was created
        if (!fs.existsSync(audioPath)) {
            throw new Error('Piper did not create output file');
        }
        
        const stats = fs.statSync(audioPath);
        console.log(`💾 [${jobId}] Audio file created: ${stats.size} bytes`);
        
        if (stats.size === 0) {
            throw new Error('Piper created empty audio file');
        }
        
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        job.modelUsed = onnxFile;
        job.ttsProvider = 'Piper CLI (success)';
        
        console.log(`🎉 [${jobId}] Piper CLI TTS completed successfully: ${audioUrl}`);
        
        // Cleanup after 5 minutes
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
        console.error(`❌ [${jobId}] Piper CLI TTS failed:`, error);
        throw error;
    }
}

// Fallback to Google TTS for individual job
async function fallbackJobToGoogle(jobId, text, voice) {
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

// Direct Google TTS fallback for immediate response
async function fallbackToGoogleTTS(res, text) {
    try {
        const audioFilename = `google_${Date.now()}.mp3`;
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
        
        return res.json({
            message: 'TTS completed (Google fallback)',
            audioUrl: audioUrl,
            ttsProvider: 'Google TTS (fallback)',
            status: 'completed'
        });
        
    } catch (error) {
        return res.status(500).json({ 
            error: `TTS failed: ${error.message}` 
        });
    }
}

// Job status
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
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
    console.log(`🚀 Railway Piper CLI Backend running on port ${PORT}`);
    console.log(`🔗 Health: ${getBaseUrl()}/health`);
    console.log(`📦 Install Piper: POST ${getBaseUrl()}/api/install-piper`);
    
    // Try auto-install on startup
    console.log('🔍 Checking Piper CLI...');
    const installResult = await installPiper();
    console.log('📦 Startup Piper install:', installResult);
    
    // Check models
    if (fs.existsSync(MODELS_DIR)) {
        const files = fs.readdirSync(MODELS_DIR);
        const onnxFiles = files.filter(f => f.endsWith('.onnx'));
        console.log(`📦 ONNX Models found:`, onnxFiles);
        
        if (onnxFiles.length > 0) {
            console.log(`🎯 Ready for Piper CLI TTS with Norwegian model!`);
        }
    }
});