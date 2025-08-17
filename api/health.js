  // api/health.js - Health check endpoint
export default function handler(req, res) {
  return res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}