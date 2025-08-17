// api/hello.js - Hello endpoint
export default function handler(req, res) {
  // Legg til CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
      return res.status(200).end();
  }
  
  // Støtt både GET og POST
  if (req.method === 'GET' || req.method === 'POST') {
      return res.status(200).json({
          message: '🎉 Vercel backend fungerer!',
          service: 'tts-backend',
          status: 'online',
          timestamp: new Date().toISOString(),
          method: req.method
      });
  } else {
      return res.status(405).json({ error: 'Method not allowed' });
  }
}