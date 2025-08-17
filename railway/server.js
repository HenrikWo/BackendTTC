const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory job storage
const jobs = new Map();

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
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
    
    // Simulate processing
    setTimeout(() => {
        console.log('✅ TTS prosessering ferdig for:', text);
    }, 1000);
    
    res.json({
        message: 'TTS prosessering startet!',
        text: text,
        status: 'processing',
        railway_timestamp: new Date().toISOString(),
        estimated_completion: '5-10 sekunder'
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
    console.log(`Health check: http://localhost:${PORT}/health`);
});