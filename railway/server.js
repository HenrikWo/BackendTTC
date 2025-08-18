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

// Get Railway public domain (fallback til hardkodet hvis ikke tilgjengelig)
function getBaseUrl() {
    // Railway setter automatisk RAILWAY_PUBLIC_DOMAIN
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (publicDomain) {
        return `https://${publicDomain}`;
    }
    
    // Fallback til din kjente Railway URL
    return 'https://backendttc-production.up.railway.app';
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
        audio_info: audioInfo
    });
});

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
            directory: MODELS_DIR
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not read models directory',
            details: error.message,
            directory: MODELS_DIR
        });
    }
});

// Download modeller fra Google Drive med forbedret feilhåndtering
app.post('/api/download-models', async (req, res) => {
    // Filene vi vil laste ned - oppdaterte Google Drive direktelinker
    const files = [
        {
            // Alternativ URL format for Google Drive
            url: 'https://drive.usercontent.google.com/download?id=1I28oJZCG9FuWut1cmCltAPMQMJULo9PV&export=download&confirm=1',
            filename: 'no_NO-talesyntese-medium.onnx',
            expectedSize: 50 * 1024 * 1024 // 50MB forventet størrelse
        },
        {
            url: 'https://drive.usercontent.google.com/download?id=1dPk-LRdL2KtWJsEj_ExyFYUEbQclm2n3&export=download&confirm=1',
            filename: 'no_NO-talesyntese-medium.onnx.json',
            expectedSize: 1024 // 1KB forventet størrelse
        }
    ];

    try {
        // Sørg for at models directory finnes
        if (!fs.existsSync(MODELS_DIR)) {
            console.log('📁 Creating models directory:', MODELS_DIR);
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }

        const downloadResults = [];

        for (const file of files) {
            try {
                console.log('⬇️ Starting download:', file.filename);
                console.log('📍 URL:', file.url);

                // Sjekk om filen allerede eksisterer
                const filePath = path.join(MODELS_DIR, file.filename);
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    console.log('📄 File already exists:', file.filename, `(${Math.round(stats.size / 1024 / 1024 * 100) / 100} MB)`);
                    
                    downloadResults.push({
                        filename: file.filename,
                        status: 'already_exists',
                        size: Math.round(stats.size / 1024 / 1024 * 100) / 100 + ' MB'
                    });
                    continue;
                }

                // Forsøk nedlasting med timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutter timeout

                const response = await fetch(file.url, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; Railway-TTS-Bot/1.0)'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                // Sjekk Content-Type
                const contentType = response.headers.get('content-type');
                console.log('📋 Content-Type:', contentType);

                // Sjekk om vi får HTML (mulig feilside fra Google Drive)
                if (contentType && contentType.includes('text/html')) {
                    throw new Error('Received HTML instead of file - possibly blocked by Google Drive');
                }

                const contentLength = response.headers.get('content-length');
                if (contentLength) {
                    console.log('📏 Expected size:', Math.round(parseInt(contentLength) / 1024 / 1024 * 100) / 100, 'MB');
                }

                // Last ned filen
                const buffer = await response.arrayBuffer();
                
                // Valider filstørrelse
                if (buffer.byteLength < 100) {
                    throw new Error('Downloaded file is too small - likely an error page');
                }

                // Skriv til disk
                fs.writeFileSync(filePath, Buffer.from(buffer));

                const sizeMB = Math.round(buffer.byteLength / (1024 * 1024) * 100) / 100;
                console.log('✅ Downloaded successfully:', file.filename, '-', sizeMB, 'MB');

                downloadResults.push({
                    filename: file.filename,
                    status: 'downloaded',
                    size: sizeMB + ' MB'
                });

            } catch (error) {
                console.error('❌ Download failed for', file.filename, ':', error.message);
                
                downloadResults.push({
                    filename: file.filename,
                    status: 'failed',
                    error: error.message
                });
            }
        }

        // Sjekk resultater
        const successful = downloadResults.filter(r => r.status === 'downloaded' || r.status === 'already_exists');
        const failed = downloadResults.filter(r => r.status === 'failed');

        if (successful.length === files.length) {
            res.json({ 
                message: 'All models ready!',
                results: downloadResults,
                total_files: successful.length
            });
        } else if (successful.length > 0) {
            res.json({ 
                message: `Partial success: ${successful.length}/${files.length} files ready`,
                results: downloadResults,
                successful: successful.length,
                failed: failed.length
            });
        } else {
            res.status(500).json({ 
                error: 'All downloads failed',
                results: downloadResults
            });
        }

    } catch (error) {
        console.error('❌ Download process failed:', error);
        res.status(500).json({ 
            error: 'Download process failed',
            details: error.message
        });
    }
});

// TTS endpoint med modell-sjekk
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'default' } = req.body;
    
    console.log('🎤 TTS Request mottatt:', text);
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    // Sjekk om modeller er tilgjengelige
    let modelStatus = { available: false, models: [] };
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
        modelStatus: modelStatus
    };
    
    jobs.set(jobId, job);
    
    // Start prosessering (asynkront)
    processTTS(jobId, text, voice).catch(error => {
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
        estimated_completion: modelStatus.available ? '10-30 sekunder' : 'Models må lastes ned først'
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

// Mock TTS processing function
async function processTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        // Update status
        job.status = 'processing';
        job.progress = 10;
        
        console.log(`🔄 Processing TTS for job ${jobId}: "${text}"`);
        
        // Sjekk om modeller er tilgjengelige
        const modelsAvailable = fs.existsSync(MODELS_DIR) && 
            fs.readdirSync(MODELS_DIR).some(f => f.endsWith('.onnx'));
        
        if (!modelsAvailable) {
            throw new Error('No ONNX models available. Please download models first.');
        }
        
        // Mock processing steps
        await sleep(2000);
        job.progress = 30;
        job.status = 'loading_model';
        
        await sleep(3000);
        job.progress = 60;
        job.status = 'generating_audio';
        
        await sleep(2000);
        job.progress = 90;
        job.status = 'finalizing';
        
        // Generer mock WAV fil
        const audioFilename = `${jobId}.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        // Lag en enkel mock WAV fil (44.1kHz, 16-bit, mono, 2 sekunder med silence)
        const sampleRate = 44100;
        const duration = 2; // sekunder
        const numSamples = sampleRate * duration;
        const bufferSize = 44 + numSamples * 2; // WAV header + data
        
        const buffer = Buffer.alloc(bufferSize);
        
        // WAV header
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(bufferSize - 8, 4);
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16); // PCM chunk size
        buffer.writeUInt16LE(1, 20); // PCM format
        buffer.writeUInt16LE(1, 22); // Mono
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
        buffer.writeUInt16LE(2, 32); // Block align
        buffer.writeUInt16LE(16, 34); // Bits per sample
        buffer.write('data', 36);
        buffer.writeUInt32LE(numSamples * 2, 40);
        
        // Generer enkel tone i stedet for stillhet (så vi kan høre at det funker)
        const frequency = 440; // A note
        for (let i = 0; i < numSamples; i++) {
            const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.3; // 30% volume
            const value = Math.round(sample * 32767);
            buffer.writeInt16LE(value, 44 + i * 2);
        }
        
        // Skriv filen
        fs.writeFileSync(audioPath, buffer);
        console.log(`🎵 Generated mock audio file: ${audioPath}`);
        
        // Generer riktig URL
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        
        console.log(`✅ TTS job ${jobId} completed - Audio URL: ${audioUrl}`);
        
        // Sett opp automatisk sletting etter 5 minutter
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                    console.log(`🗑️ Cleaned up audio file: ${audioFilename}`);
                }
                jobs.delete(jobId);
                console.log(`🧹 Cleaned up job: ${jobId}`);
            } catch (err) {
                console.error(`❌ Cleanup error for ${jobId}:`, err.message);
            }
        }, 5 * 60 * 1000); // 5 minutter
        
    } catch (error) {
        console.error(`❌ TTS processing error for job ${jobId}:`, error);
        job.status = 'failed';
        job.error = error.message;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Clean up models directory
app.delete('/api/models', (req, res) => {
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            let deleted = 0;
            
            files.forEach(file => {
                const filePath = path.join(MODELS_DIR, file);
                try {
                    fs.unlinkSync(filePath);
                    deleted++;
                    console.log('🗑️ Deleted:', file);
                } catch (err) {
                    console.log('❌ Could not delete:', file, err.message);
                }
            });
            
            res.json({
                message: `Cleaned up models directory`,
                deleted_files: deleted,
                remaining_files: fs.readdirSync(MODELS_DIR).length
            });
        } else {
            res.json({ message: 'Models directory does not exist' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clean up old jobs every hour
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    
    for (const [jobId, job] of jobs.entries()) {
        if (new Date(job.createdAt).getTime() < oneHourAgo) {
            // Clean up audio file if it exists
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

// Clean up orphaned audio files on startup
function cleanupOrphanedFiles() {
    try {
        if (fs.existsSync(AUDIO_DIR)) {
            const files = fs.readdirSync(AUDIO_DIR);
            files.forEach(file => {
                const filePath = path.join(AUDIO_DIR, file);
                const stats = fs.statSync(filePath);
                
                // Slett filer som er eldre enn 1 time
                if (Date.now() - stats.mtime.getTime() > 60 * 60 * 1000) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Cleaned up orphaned file: ${file}`);
                    } catch (err) {
                        console.error(`❌ Could not delete orphaned file ${file}:`, err.message);
                    }
                }
            });
        }
    } catch (err) {
        console.error('❌ Cleanup error:', err.message);
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Railway TTS Backend running on port ${PORT}`);
    console.log(`📁 Models directory: ${MODELS_DIR}`);
    console.log(`🎵 Audio directory: ${AUDIO_DIR}`);
    console.log(`🔗 Base URL: ${getBaseUrl()}`);
    console.log(`🔗 Health check: ${getBaseUrl()}/health`);
    console.log(`📥 Download models: POST /api/download-models`);
    
    // Clean up old files on startup
    cleanupOrphanedFiles();
    
    // Check volume on startup
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            console.log(`📦 Volume mounted! Found ${files.length} files in models directory`);
            
            const models = files.filter(f => f.endsWith('.onnx'));
            const configs = files.filter(f => f.endsWith('.json'));
            
            if (models.length > 0 && configs.length > 0) {
                console.log(`🤖 Ready for TTS! Models:`, models);
                console.log(`⚙️ Config files:`, configs);
            } else {
                console.log(`📋 Models incomplete. Use POST /api/download-models to download them.`);
                console.log(`   Found: ${models.length} ONNX files, ${configs.length} JSON configs`);
            }
        } else {
            console.log(`📁 Volume not mounted yet - creating directory ${MODELS_DIR}`);
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }
    } catch (err) {
        console.log(`❌ Could not access models directory:`, err.message);
    }
});