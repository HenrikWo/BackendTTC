const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Volume path (Railway volume mount point)
const MODELS_DIR = '/app/models';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory job storage
const jobs = new Map();

// Health check med volume info
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
    
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        models_directory: MODELS_DIR,
        models_info: modelInfo
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
            file.endsWith('.bin') || 
            file.endsWith('.safetensors')
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

// Simple test endpoint
app.post('/api/test', (req, res) => {
    const { message, sentAt, from } = req.body;
    
    console.log('📨 Mottok test-melding fra:', from, '- Melding:', message);
    
    res.json({
        received: true,
        your_message: message,
        sent_at: sentAt,
        railway_timestamp: new Date().toISOString(),
        railway_status: 'Railway backend fungerer! 🎉'
    });
});

// Simple TTS endpoint (mock for testing)
app.post('/api/tts', (req, res) => {
    const { text } = req.body;
    
    console.log('🎤 TTS Request mottatt:', text);
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    // Check models directory
    let modelCount = 0;
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            modelCount = files.filter(f => f.endsWith('.onnx')).length;
        }
    } catch (err) {
        console.log('Could not check models:', err.message);
    }
    
    // Simulate processing
    setTimeout(() => {
        console.log('✅ TTS prosessering ferdig for:', text);
    }, 1000);
    
    res.json({
        message: 'TTS prosessering startet!',
        text: text,
        status: 'processing',
        railway_timestamp: new Date().toISOString(),
        estimated_completion: '5-10 sekunder',
        models_available: modelCount
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
        
        console.log(`Processing TTS for job ${jobId}: "${text}"`);
        
        // Mock processing steps
        await sleep(2000);
        job.progress = 30;
        
        await sleep(3000);
        job.progress = 60;
        
        await sleep(2000);
        job.progress = 90;
        
        // Mock completed result
        const audioUrl = `https://example.com/audio/${jobId}.wav`;
        
        job.status = 'completed';
        job.progress = 100;
        job.audioUrl = audioUrl;
        job.completedAt = new Date().toISOString();
        
        console.log(`TTS job ${jobId} completed`);
        
    } catch (error) {
        console.error(`TTS processing error for job ${jobId}:`, error);
        job.status = 'failed';
        job.error = error.message;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Clean up old jobs every hour
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    
    for (const [jobId, job] of jobs.entries()) {
        if (new Date(job.createdAt).getTime() < oneHourAgo) {
            jobs.delete(jobId);
        }
    }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 Railway TTS Backend running on port ${PORT}`);
    console.log(`📁 Models directory: ${MODELS_DIR}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    
    // Check volume on startup
    try {
        if (fs.existsSync(MODELS_DIR)) {
            const files = fs.readdirSync(MODELS_DIR);
            console.log(`📦 Volume mounted! Found ${files.length} files in models directory`);
            const models = files.filter(f => f.endsWith('.onnx'));
            if (models.length > 0) {
                console.log(`🤖 ONNX models found:`, models);
            }
        } else {
            console.log(`📁 Volume not mounted yet - directory ${MODELS_DIR} doesn't exist`);
        }
    } catch (err) {
        console.log(`❌ Could not access models directory:`, err.message);
    }
});