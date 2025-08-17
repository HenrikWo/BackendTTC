// api/hello.js - Superenkelt API endpoint
export default function handler(req, res) {
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