const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WYOMING_PORT = 10200;
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

// Health check
app.get('/health', (req, res) => {
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
        audio_directory: AUDIO_DIR,
        audio_info: audioInfo,
        wyoming_port: WYOMING_PORT,
        tts_provider: 'Wyoming Piper (Norwegian)'
    });
});

// TTS endpoint using Wyoming Piper
app.post('/api/tts', async (req, res) => {
    const { text, voice = 'no_NO-talesyntese-medium' } = req.body;
    
    console.log('🎤 TTS Request (Wyoming Piper):', text);
    
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
    
    const jobId = 'tts_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const job = {
        id: jobId,
        text: text,
        voice: voice,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        ttsProvider: 'Wyoming Piper (Norwegian)'
    };
    
    jobs.set(jobId, job);
    
    // Start Wyoming Piper TTS processing
    console.log('🤖 Starting Wyoming Piper TTS...');
    processWyomingTTS(jobId, text, voice).catch(error => {
        console.error(`❌ Wyoming Piper failed:`, error);
        const job = jobs.get(jobId);
        if (job) {
            job.status = 'failed';
            job.error = error.message;
        }
    });
    
    res.json({
        message: 'TTS job created',
        jobId: jobId,
        status: job.status,
        provider_decision: {
            will_use_wyoming: true,
            voice: voice
        },
        estimated_completion: '5-10 sekunder'
    });
});

// Wyoming Piper TTS processing
async function processWyomingTTS(jobId, text, voice) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🤖 [${jobId}] Starting Wyoming Piper TTS`);
        
        job.status = 'processing';
        job.progress = 20;
        
        job.progress = 40;
        job.status = 'generating_audio';
        
        console.log(`🗣️ [${jobId}] Calling Wyoming Piper API...`);
        console.log(`📝 [${jobId}] Text: "${text}"`);
        
        // Call Wyoming Piper HTTP API
        const wyomingUrl = `http://localhost:${WYOMING_PORT}/api/tts`;
        
        const response = await fetch(wyomingUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                voice: voice
            })
        });
        
        if (!response.ok) {
            throw new Error(`Wyoming Piper API error: ${response.status} ${response.statusText}`);
        }
        
        job.progress = 80;
        job.status = 'finalizing';
        
        // Get audio data
        const audioBuffer = await response.arrayBuffer();
        
        if (audioBuffer.byteLength === 0) {
            throw new Error('Wyoming Piper returned empty audio');
        }
        
        // Save audio file
        const audioFilename = `${jobId}_wyoming.wav`;
        const audioPath = path.join(AUDIO_DIR, audioFilename);
        
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        
        console.log(`💾 [${jobId}] Audio file saved: ${audioBuffer.byteLength} bytes`);
        
        const baseUrl = getBaseUrl();
        const audioUrl = `${baseUrl}/audio/${audioFilename}`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.audioPath = audioPath;
        job.completedAt = new Date().toISOString();
        job.ttsProvider = 'Wyoming Piper (Norwegian success)';
        
        console.log(`🎉 [${jobId}] Wyoming Piper TTS completed successfully: ${audioUrl}`);
        
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
        console.error(`❌ [${jobId}] Wyoming Piper TTS failed:`, error);
        job.status = 'failed';
        job.error = error.message;
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
app.listen(PORT, () => {
    console.log(`🚀 Wyoming Piper Wrapper running on port ${PORT}`);
    console.log(`🔗 Health: ${getBaseUrl()}/health`);
    console.log(`🇳🇴 Norwegian TTS via Wyoming Piper on port ${WYOMING_PORT}`);
    console.log(`🎯 Ready for Norwegian text-to-speech!`);
});