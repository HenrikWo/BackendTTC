const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Volume path (Railway volume mount point)
const MODELS_DIR = '/app/models';

// Ensure models directory exists
if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log('📁 Created models directory:', MODELS_DIR);
}

// Configure multer for file uploads to volume
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, MODELS_DIR);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory job storage
const jobs = new Map();

// Health check with volume info
app.get('/health', (req, res) => {
    let modelFiles = [];
    try {
        modelFiles = fs.readdirSync(MODELS_DIR);
    } catch (err) {
        console.log('Could not read models directory:', err.message);
    }
    
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        models_directory: MODELS_DIR,
        available_models: modelFiles
    });
});

// List available models
app.get('/api/models', (req, res) => {
    try {
        const files = fs.readdirSync(MODELS_DIR);
        const models = files.filter(file => 
            file.endsWith('.onnx') || 
            file.endsWith('.bin') || 
            file.endsWith('.safetensors')
        );
        
        const modelInfo = models.map(filename => {
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
            total_count: models.length
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not read models directory',
            details: error.message 
        });
    }
});

// Upload model file to volume
app.post('/api/upload-model', upload.single('model'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    console.log('📦 Model uploaded:', req.file.filename, 
                '- Size:', Math.round(req.file.size / (1024 * 1024) * 100) / 100, 'MB');
    
    res.json({
        message: 'Model uploaded successfully!',
        filename: req.file.filename,
        size: Math.round(req.file.size / (1024 * 1024) * 100) / 100 + ' MB',
        path: req.file.path
    });
});

// Download model from URL and save to volume
app.post('/api/download-model', async (req, res) => {
    const { url, filename } = req.body;
    
    if (!url || !filename) {
        return res.status(400).json({ error: 'URL and filename required' });
    }
    
    try {
        console.log('⬇️ Downloading model from:', url);
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const buffer = await response.arrayBuffer();
        const filePath = path.join(MODELS_DIR, filename);
        
        fs.writeFileSync(filePath, Buffer.from(buffer));
        
        console.log('✅ Model downloaded:', filename, 
                    '- Size:', Math.round(buffer.byteLength / (1024 * 1024) * 100) / 100, 'MB');
        
        res.json({
            message: 'Model downloaded successfully!',
            filename: filename,
            size: Math.round(buffer.byteLength / (1024 * 1024) * 100) / 100 + ' MB',
            path: filePath
        });
        
    } catch (error) {
        console.error('❌ Download failed:', error);
        res.status(500).json({ 
            error: 'Download failed',
            details: error.message 
        });
    }
});

// Delete model from volume
app.delete('/api/models/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(MODELS_DIR, filename);
    
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log('🗑️ Deleted model:', filename);
            res.json({ message: 'Model deleted successfully', filename });
        } else {
            res.status(404).json({ error: 'Model not found' });
        }
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not delete model',
            details: error.message 
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
    
    // Check if we have any models available
    let availableModels = [];
    try {
        const files = fs.readdirSync(MODELS_DIR);
        availableModels = files.filter(file => file.endsWith('.onnx'));
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
        available_models: availableModels.length
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
    
    // List existing models on startup
    try {
        const files = fs.readdirSync(MODELS_DIR);
        const models = files.filter(file => file.endsWith('.onnx'));
        console.log(`🤖 Found ${models.length} ONNX models:`, models);
    } catch (err) {
        console.log('📁 Models directory is empty or not accessible');
    }
});