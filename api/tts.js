// api/tts.js - Vercel Serverless Function
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
  
    if (req.method === 'POST') {
      try {
        const { image, filename } = req.body;
        
        if (!image || !filename) {
          return res.status(400).json({ 
            success: false, 
            error: 'Mangler image eller filename' 
          });
        }
  
        // Send til Railway backend for lagring
        // TODO: Erstatt med din faktiske Railway URL
        const RAILWAY_URL = process.env.RAILWAY_URL || 'https://backendttc-production.up.railway.app';
        
        const railwayResponse = await fetch(`${RAILWAY_URL}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image, filename })
        });
  
        const result = await railwayResponse.json();
        
        if (railwayResponse.ok) {
          res.status(200).json({ 
            success: true, 
            message: 'Bilde lastet opp!',
            filename: result.filename 
          });
        } else {
          res.status(500).json({ 
            success: false, 
            error: result.error || 'Feil ved opplasting' 
          });
        }
      } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Server feil ved opplasting' 
        });
      }
    } 
    
    else if (req.method === 'GET') {
      try {
        const { filename } = req.query;
        
        if (!filename) {
          return res.status(400).json({ 
            success: false, 
            error: 'Mangler filename parameter' 
          });
        }
  
        // Hent fra Railway backend
        const RAILWAY_URL = process.env.RAILWAY_URL || 'https://your-railway-app.railway.app';
        const railwayResponse = await fetch(`${RAILWAY_URL}/image/${filename}`);
        
        if (railwayResponse.ok) {
          const result = await railwayResponse.json();
          res.status(200).json({
            success: true,
            image: result.image,
            filename: result.filename
          });
        } else {
          res.status(404).json({ 
            success: false, 
            error: 'Bilde ikke funnet' 
          });
        }
      } catch (error) {
        console.error('Get image error:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Server feil ved henting av bilde' 
        });
      }
    }
    
    else {
      res.status(405).json({ 
        success: false, 
        error: 'Method not allowed' 
      });
    }
  }