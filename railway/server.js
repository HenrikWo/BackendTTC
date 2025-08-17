const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ort = require('onnxruntime-node');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory job storage
const jobs = new Map();
let ttsSession = null;

// Initialize ONNX model on startup
async function initializeModel() {
    try {
        const modelPath = path.join(__dirname, 'tts_model.onnx');
        
        if (!fs.existsSync(modelPath)) {
            console.error('❌ ONNX model not found:', modelPath);
            console.log('Please ensure tts_model.onnx is in the root directory');
            return false;
        }
        
        console.log('🤖 Loading ONNX TTS model...');
        ttsSession = await ort.InferenceSession.create(modelPath);
        console.log('✅ ONNX model loaded successfully!');
        
        // Log input/output info
        console.log('Model inputs:', ttsSession.inputNames);
        console.log('Model outputs:', ttsSession.outputNames);
        
        return true;
    } catch (error) {
        console.error('❌ Failed to load ONNX model:', error);
        return false;
    }
}

// Text preprocessing function
function preprocessText(text) {
    // Basic text cleanup - expand this based on your model's requirements
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\sæøå.,!?-]/g, '') // Keep Norwegian characters
        .replace(/\s+/g, ' ');
}

// Convert text to phonemes/tokens (model-specific)
function textToTokens(text) {
    // This is a placeholder - you'll need to implement based on your specific model
    // Most TTS models require tokenization or phoneme conversion
    const chars = Array.from(text);
    return chars.map(char => char.charCodeAt(0)); // Simple char-to-int mapping
}

// Generate audio using ONNX model
async function generateAudio(text) {
    if (!ttsSession) {
        throw new Error('ONNX model not initialized');
    }
    
    try {
        // Preprocess text
        const cleanText = preprocessText(text);
        console.log('Preprocessed text:', cleanText);
        
        // Convert to model input format
        const tokens = textToTokens(cleanText);
        const inputTensor = new ort.Tensor('int64', BigInt64Array.from(tokens.map(t => BigInt(t))), [1, tokens.length]);
        
        // Run inference
        console.log('Running ONNX inference...');
        const results = await ttsSession.run({
            [ttsSession.inputNames[0]]: inputTensor
        });
        
        // Get audio data from output
        const audioTensor = results[ttsSession.outputNames[0]];
        const audioData = audioTensor.data;
        
        // Convert to WAV format (simplified)
        const wavBuffer = createWavBuffer(audioData);
        
        return wavBuffer;
        
    } catch (error) {
        console.error('TTS generation error:', error);
        throw error;
    }
}

// Create WAV file buffer from audio data
function createWavBuffer(audioData) {
    const sampleRate = 22050; // Adjust based on your model
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioData.length * 2; // 16-bit samples
    const fileSize = 36 + dataSize;
    
    const buffer = Buffer.alloc(44 + dataSize);
    let offset = 0;
    
    // WAV header
    buffer.write('RIFF', offset); offset += 4;
    buffer.writeUInt32LE(fileSize, offset); offset += 4;
    buffer.write('WAVE', offset); offset += 4;
    buffer.write('fmt ', offset); offset += 4;
    buffer.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size
    buffer.writeUInt16LE(1, offset); offset += 2; // AudioFormat (PCM)
    buffer.writeUInt16LE(numChannels, offset); offset += 2;
    buffer.writeUInt32LE(sampleRate, offset); offset += 4;
    buffer.writeUInt32LE(byteRate, offset); offset += 4;
    buffer.writeUInt16LE(blockAlign, offset); offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
    buffer.write('data', offset); offset += 4;
    buffer.writeUInt32LE(dataSize, offset); offset += 4;
    
    // Audio data
    for (let i = 0; i < audioData.length; i++) {
        const sample = Math.max(-1, Math.min(1, audioData[i]));
        const intSample = Math.round(sample * 32767);
        buffer.writeInt16LE(intSample, offset);
        offset += 2;
    }
    
    return buffer;
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        onnx_loaded: !!ttsSession
    });
});

// TTS endpoint with ONNX processing
app.post('/api/tts', async (req, res) => {
    const { text } = req.body;
    
    console.log('🎤 TTS Request mottatt:', text);
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    if (!ttsSession) {
        return res.status(503).json({ 
            error: 'ONNX model not loaded',
            message: 'Server is starting up, please try again in a moment'
        });
    }
    
    const jobId = uuidv4();
    
    // Create job
    const job = {
        id: jobId,
        text: text,
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString()
    };
    
    jobs.set(jobId, job);
    
    // Start async processing
    processTTS(jobId, text);
    
    res.json({
        message: 'TTS prosessering startet!',
        jobId: jobId,
        text: text,
        status: 'processing',
        railway_timestamp: new Date().toISOString(),
        statusUrl: `/api/job/${jobId}`
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

// Download audio endpoint
app.get('/api/download/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'completed' || !job.audioBuffer) {
        return res.status(400).json({ error: 'Audio not ready' });
    }
    
    res.set({
        'Content-Type': 'audio/wav',
        'Content-Disposition': `attachment; filename="tts_${job.id}.wav"`,
        'Content-Length': job.audioBuffer.length
    });
    
    res.send(job.audioBuffer);
});

// ONNX TTS processing function
async function processTTS(jobId, text) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        console.log(`🔄 Processing TTS for job ${jobId}: "${text}"`);
        
        // Update progress
        job.progress = 20;
        
        // Generate audio using ONNX
        console.log('Generating audio with ONNX model...');
        job.progress = 40;
        
        const audioBuffer = await generateAudio(text);
        
        job.progress = 80;
        
        // Store the audio buffer
        job.audioBuffer = audioBuffer;
        job.audioUrl = `/api/download/${jobId}`;
        job.status = 'completed';
        job.progress = 100;
        job.completedAt = new Date().toISOString();
        
        console.log(`✅ TTS job ${jobId} completed, audio size: ${audioBuffer.length} bytes`);
        
    } catch (error) {
        console.error(`❌ TTS processing error for job ${jobId}:`, error);
        job.status = 'failed';
        job.error = error.message;
        job.progress = 0;
    }
}

// Clean up old jobs every hour
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    
    for (const [jobId, job] of jobs.entries()) {
        if (new Date(job.createdAt).getTime() < oneHourAgo) {
            jobs.delete(jobId);
            console.log(`🧹 Cleaned up old job: ${jobId}`);
        }
    }
}, 60 * 60 * 1000);

// Initialize model and start server
async function startServer() {
    console.log('🚀 Starting Railway TTS Backend...');
    
    // Initialize ONNX model
    const modelLoaded = await initializeModel();
    
    if (!modelLoaded) {
        console.log('⚠️  Server starting without ONNX model - TTS will not work');
    }
    
    app.listen(PORT, () => {
        console.log(`🚀 Railway TTS Backend running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`ONNX Model loaded: ${!!ttsSession}`);
    });
}

// Start the server
startServer().catch(console.error);