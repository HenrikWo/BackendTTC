// api/tts.js - Send TTS request to Railway backend
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { text, voice = 'default' } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }
        
        // Send request to Railway backend
        const RAILWAY_URL = process.env.RAILWAY_BACKEND_URL || 'https://your-app.railway.app';
        
        const response = await fetch(`${RAILWAY_URL}/api/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text.slice(0, 1000), // Limit text length
                voice: voice,
                requestId: Date.now().toString()
            })
        });
        
        if (!response.ok) {
            throw new Error(`Backend error: ${response.status}`);
        }
        
        const result = await response.json();
        
        return res.status(200).json({
            success: true,
            jobId: result.jobId,
            status: result.status,
            message: 'TTS request submitted',
            estimatedTime: result.estimatedTime || '10-30 seconds'
        });
        
    } catch (error) {
        console.error('TTS API error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
}