// api/tts.js - Forenklet TTS test
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }
        
        // Railway backend URL
        const RAILWAY_URL = process.env.RAILWAY_BACKEND_URL || 'http://localhost:3000';
        
        console.log('Sending to Railway:', text);
        
        const response = await fetch(`${RAILWAY_URL}/api/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text })
        });
        
        if (!response.ok) {
            throw new Error(`Railway error: ${response.status}`);
        }
        
        const result = await response.json();
        
        return res.status(200).json({
            success: true,
            message: 'TTS request sendt til Railway!',
            railway_response: result
        });
        
    } catch (error) {
        console.error('TTS API error:', error);
        return res.status(500).json({ 
            success: false,
            error: 'Railway backend ikke tilgjengelig',
            details: error.message
        });
    }
}